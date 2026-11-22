/**
 * dsh-token-ring —— 时间线
 *
 * 职责：把每个会话的事件日志（session.v4.jsonl.zstd）里每一次真实的
 * LLM 调用挖出来，带着时间戳和模型名，再按小时 / 天 / 月聚合成柱状图数据。
 *
 * 为什么不用 projcache 的 tokenUsage.totals：
 *   那是「会话累计值」，跨天的老会话会把几天的量全记在今天，
 *   也没有任何时间维度，画不出趋势。
 *
 * 数据来源：~/.dsh/sessions/<工作区转义名>/<会话id>/session.v4.jsonl.zstd
 *   事件 type=assistant/message 的 data.usage：
 *     inputTokens      本次未缓存输入
 *     outputTokens     本次输出
 *     cacheReadTokens  本次缓存读
 *     cacheWriteTokens 本次缓存写
 *   （注意 totalTokens 是会话累计值，不能用）
 *
 * 性能：60 个文件 / 112 MB 首次全扫约 3.5 秒；结果按文件 mtime+size 落在
 * ~/.dsh/token-usage/timeline-cache.json，之后只重扫变过的文件。
 *
 * 只读，绝不写回任何 DSH 数据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = os.homedir()
const SESSIONS = path.join(HOME, '.dsh', 'sessions')
const CACHE_DIR = path.join(HOME, '.dsh', 'token-usage')
const CACHE_FILE = path.join(CACHE_DIR, 'timeline-cache.json')
const CACHE_VERSION = 4

/**
 * 存留文件：会话被删掉之后，它曾经贡献的用量就只剩这里还有。
 *
 * 结构（按会话 id 存原始调用记录，不用聚合桶，这样删了会话也还能按小时拆）：
 *   { version, sessions: { "<会话id>": { stamp, lastSeen, models: [...], records: [[t,m,i,o,cr,cw], ...] } } }
 *
 * 为什么存原始记录而不是每天一个总数：29,515 条 ≈ 2 MB，
 * 换来的是删会话之后连「那天几点用的、哪个模型」都还原得出来。
 */
const ARCHIVE_FILE = path.join(CACHE_DIR, 'session-archive.json')
const ARCHIVE_VERSION = 1

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 递归找指定文件名的文件 */
function findAll(dir, name, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findAll(p, name, out)
    else if (e.name === name) out.push(p)
  }
  return out
}

/**
 * 解压一个可能由多帧拼起来的 zstd 文件。
 * DSH 是边聊边追加写，每次 flush 一帧，所以一个文件里成百上千帧。
 *
 * 优化：如果文件是纯追加写（帧数只增不减），跳过前 `skipFrames` 帧，
 * 只解压尾巴。当前这个会话 39729 帧，重扫全解压要 1.4 秒，
 * 只扫末几帧接近 0 毫秒。
 */
function decompressTail(buf, skipFrames = 0) {
  const starts = []
  let i = 0
  while (i < buf.length - 4) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  if (!starts.length) return Buffer.alloc(0)
  const parts = []
  for (let k = skipFrames; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], to)))
    } catch {
      /* 坏帧跳过，不影响其它帧 */
    }
  }
  return Buffer.concat(parts)
}

/** 给 `parseFile` 当增量：跳过前 `skipFrames` 帧的解压 */
function decompressFromFrame(buf, frameIndex) {
  const starts = []
  let i = 0
  while (i < buf.length - 4) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  if (!starts.length) return Buffer.alloc(0)
  if (frameIndex >= starts.length) return Buffer.alloc(0)
  const parts = []
  for (let k = frameIndex; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], to)))
    } catch {
      /* 坏帧跳过 */
    }
  }
  return Buffer.concat(parts)
}

function decompressMultiFrame(buf) {
  return decompressTail(buf, 0)
}

/** 一个文件里的帧总数，用来判断「新增了没有、从哪帧开始扫」 */
function frameCount(buf) {
  let n = 0
  let i = 0
  while (i < buf.length - 4) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    n++
    i = at + 4
  }
  return n
}

/**
 * 解析一个会话文件，返回该文件里的每次调用。
 * @param {number} [skipFrames] 已知的旧帧数，跳过前 N 帧的解压（只扫新增部分）。
 * @returns {{ records: number[][], models: string[], frameCount: number }} records 里每条是 [t, modelIdx, input, output, cacheRead, cacheWrite]
 */
function parseFile(full, skipFrames = 0) {  let buf
  try {
    buf = fs.readFileSync(full)
  } catch {
    return null
  }
  let text
  try {
    text = (skipFrames > 0 ? decompressFromFrame(buf, skipFrames) : decompressMultiFrame(buf)).toString('utf8')
  } catch {
    return null
  }
  if (!text) return { records: [], models: [], frameCount: 0 }

  const models = []
  const modelIdx = new Map()
  const idxOf = (m) => {
    let i = modelIdx.get(m)
    if (i === undefined) {
      i = models.length
      models.push(m)
      modelIdx.set(m, i)
    }
    return i
  }

  const records = []
  for (const line of text.split('\n')) {
    // 先做一个极廉价的预筛，避免对十万行全量 JSON.parse
    if (line.length < 40 || !line.includes('"assistant/message"')) continue
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const d = j?.data
    const u = d?.usage
    if (!u) continue
    const input = Number(u.inputTokens) || 0
    const output = Number(u.outputTokens) || 0
    const cacheRead = Number(u.cacheReadTokens) || 0
    const cacheWrite = Number(u.cacheWriteTokens) || 0
    if (input + output + cacheRead + cacheWrite <= 0) continue
    const t = Number(j.time) || 0
    if (!t) continue
    records.push([t, idxOf(String(d?.message?.source?.model ?? 'unknown')), input, output, cacheRead, cacheWrite])
  }
  return { records, models, frameCount: frameCount(buf) }
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (j?.version === CACHE_VERSION && j.files) return j
  } catch {
    /* 缓存不存在或坏了，重建 */
  }
  return { version: CACHE_VERSION, files: {} }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8')
  } catch {
    /* 写不进去就算了，不影响本次结果 */
  }
}

// ── 会话存留 ────────────────────────────────────────────────────────────────
// 会话一删，它的日志就没了，用量也就跟着蒸发。所以每次扫到现存会话，把它的
// 调用记录抄一份到 ARCHIVE_FILE；等它哪天消失，再从归档里把这些记录读回来
// 参与统计。归档只增不减，是「账本」，不是缓存。

function readArchive() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'))
    if (j?.version === ARCHIVE_VERSION && j.sessions && typeof j.sessions === 'object') return j
  } catch {
    /* 没有或坏了，从空开始 */
  }
  return { version: ARCHIVE_VERSION, sessions: {} }
}

function writeArchive(a) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(a), 'utf8')
  } catch {
    /* 写不进去不影响本次统计 */
  }
}

/** `.../session-<id>/session.v4.jsonl.zstd` → `session-<id>` */
function sessionIdOf(full) {
  return path.basename(path.dirname(full))
}

let liveCache = null
let liveAt = 0
const LIVE_TTL = 5_000

/**
 * 扫描全部会话，返回完整记录集。
 * @param {boolean} force 为 true 时忽略内存缓存（磁盘缓存仍然生效）
 */
export function scanTimeline(force = false) {
  const now = Date.now()
  if (!force && liveCache && now - liveAt < LIVE_TTL) return liveCache

  const files = findAll(SESSIONS, 'session.v4.jsonl.zstd')
  const cache = readCache()
  const next = { version: CACHE_VERSION, files: {} }
  const models = []
  const modelIdx = new Map()
  const idxOf = (m) => {
    let i = modelIdx.get(m)
    if (i === undefined) {
      i = models.length
      models.push(m)
      modelIdx.set(m, i)
    }
    return i
  }

  const records = []
  // 每条记录带上「来自哪个会话文件」，这样按时间窗统计时还能数出涉及几个会话
  const fileIds = []
  const fileIdxOf = new Map()
  const fileIdx = (full) => {
    let i = fileIdxOf.get(full)
    if (i === undefined) {
      i = fileIds.length
      fileIds.push(full)
      fileIdxOf.set(full, i)
    }
    return i
  }

  let scanned = 0
  for (const full of files) {
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    const stamp = `${Math.round(st.mtimeMs)}:${st.size}`
    const old = cache.files[full]
    const fid = fileIdx(full)
    const sid = sessionIdOf(full)
    if (old && old.stamp === stamp && Array.isArray(old.records)) {
      // 命中缓存：把模型名重新映射到本次的索引表
      const localModels = old.models ?? []
      for (const r of old.records) {
        const m = localModels[r[1]] ?? 'unknown'
        records.push([r[0], idxOf(m), r[2], r[3], r[4], r[5], fid])
      }
      next.files[full] = { stamp: old.stamp, models: localModels, records: old.records, id: sid }
      continue
    }

    // 文件变了：先试试「尾部追加」路径 —— 纯追加时只解压新帧，省掉全量解压。
    // 当前会话 39729 帧，全量解压 1.4s vs 只扫增量 ≈ 0ms。
    let parsed = null
    const oldFrames = Number(old?.frameCount) || 0
    if (old && oldFrames > 0 && Array.isArray(old.records)) {
      const buf = fs.readFileSync(full)
      const nowFrames = frameCount(buf)
      if (nowFrames >= oldFrames) {
        const tail = parseFile(full, oldFrames)
        if (tail) {
          // 旧记录用的是 old.models 的索引，新记录用的是 tail.models 的索引。
          // 合并成一张模型表，再把新记录的索引映射过来。
          const mergedModels = [...(old.models || [])]
          const remap = new Map()
          const idxIn = (m) => {
            let i = remap.get(m)
            if (i === undefined) {
              i = mergedModels.indexOf(m)
              if (i < 0) {
                i = mergedModels.length
                mergedModels.push(m)
              }
              remap.set(m, i)
            }
            return i
          }
          const mergedRecords = (old.records || []).slice()
          for (const r of tail.records || []) {
            mergedRecords.push([r[0], idxIn(tail.models?.[r[1]] ?? 'unknown'), r[2], r[3], r[4], r[5]])
          }
          parsed = { records: mergedRecords, models: mergedModels, frameCount: nowFrames }
        }
      }
    }
    if (!parsed) {
      parsed = parseFile(full)
      if (!parsed) continue
    }
    scanned++
    for (const r of parsed.records) {
      const m = parsed.models[r[1]] ?? 'unknown'
      records.push([r[0], idxOf(m), r[2], r[3], r[4], r[5], fid])
    }
    next.files[full] = { stamp, models: parsed.models, records: parsed.records, frameCount: parsed.frameCount, id: sid }
  }

  // ── 存留：把现存会话抄进账本，再把已删会话的记录捞回来 ──────────────────
  const archive = readArchive()
  const liveIds = new Set()
  let archivedRecords = 0
  let archivedSessions = 0

  for (const v of Object.values(next.files)) {
    if (!v.id) continue
    liveIds.add(v.id)
    const localModels = v.models || []
    archive.sessions[v.id] = {
      stamp: v.stamp,
      lastSeen: now,
      models: localModels,
      // 存模型名而不是索引，换一次会话也不怕表错位
      records: (v.records || []).map((r) => [r[0], localModels[r[1]] ?? 'unknown', r[2], r[3], r[4], r[5]]),
    }
  }

  // 归档里有、磁盘上已经没有的，就是被删掉的会话
  for (const [id, a] of Object.entries(archive.sessions)) {
    if (liveIds.has(id)) continue
    archivedSessions++
    for (const r of a.records || []) {
      records.push([r[0], idxOf(r[1] || 'unknown'), r[2], r[3], r[4], r[5], -1])
      archivedRecords++
    }
  }

  // 丢掉已经不存在的文件
  if (scanned > 0 || !Object.keys(cache.files).length) writeCache(next)
  if (scanned > 0) writeArchive(archive)
  const result = {
    records,
    models,
    fileIds,
    scanned,
    files: files.length,
    archivedRecords,
    archivedSessions,
    at: Date.now(),
  }
  liveCache = result
  liveAt = now
  return result
}

const PAD = (n) => String(n).padStart(2, '0')

/** 桶的时间键：小时 / 天 / 月 */
export function keyOf(t, unit) {
  const d = new Date(t)
  const y = d.getFullYear()
  const m = PAD(d.getMonth() + 1)
  const day = PAD(d.getDate())
  if (unit === 'month') return `${y}-${m}`
  if (unit === 'day') return `${y}-${m}-${day}`
  return `${y}-${m}-${day} ${PAD(d.getHours())}`
}

/** 桶的起点时间戳，用来给缺失的时段补零 */
function startOfBucket(key, unit) {
  const [datePart, hourPart] = key.split(' ')
  const [y, mo, da] = datePart.split('-').map(Number)
  if (unit === 'month') return new Date(y, mo - 1, 1).getTime()
  if (unit === 'day') return new Date(y, mo - 1, da).getTime()
  return new Date(y, mo - 1, da, Number(hourPart || 0)).getTime()
}

/** 往前后推一个桶 */
function shiftBucket(ms, unit, delta) {
  const d = new Date(ms)
  if (unit === 'month') d.setMonth(d.getMonth() + delta)
  else if (unit === 'day') d.setDate(d.getDate() + delta)
  else d.setHours(d.getHours() + delta)
  return d.getTime()
}

/**
 * 聚合。
 * @param records 记录集
 * @param models 模型名表
 * @param priceOf 计价函数 (model) => { in, out, cacheRead, cacheWrite }
 * @param unit 'hour' | 'day' | 'month'
 * @param limit 返回最近多少个桶（0 = 全部）
 * @param endAt 右端点（默认现在）
 * @returns {{ buckets: any[], unit: string, start: number, end: number }}
 */
export function buildBuckets(records, models, priceOf, unit, limit, endAt = Date.now()) {
  const map = new Map()
  for (const r of records) {
    const k = keyOf(r[0], unit)
    let b = map.get(k)
    if (!b) {
      b = { key: k, at: startOfBucket(k, unit), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, byModel: new Map() }
      map.set(k, b)
    }
    const model = models[r[1]] ?? 'unknown'
    b.input += r[2]
    b.output += r[3]
    b.cacheRead += r[4]
    b.cacheWrite += r[5]
    b.calls += 1
    let mb = b.byModel.get(model)
    if (!mb) {
      mb = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      b.byModel.set(model, mb)
    }
    mb.input += r[2]
    mb.output += r[3]
    mb.cacheRead += r[4]
    mb.cacheWrite += r[5]
  }

  const all = [...map.values()].sort((a, b) => a.at - b.at)

  // 补零：让桶连续，柱状图才不会跳
  //
  // 右端点必须钉在「现在」(endAt)，不能用最后一个有数据的桶 ——
  // 那样「近 24 小时」会变成「最后一次调用往前 24 小时」，中间断了几天
  // 也照样从旧位置开始画，看上去就是时间轴整段错位。
  const wanted = limit > 0 ? limit : 0
  let series = all
  if (wanted > 0) {
    const endStart = startOfBucket(keyOf(endAt, unit), unit)
    const from = shiftBucket(endStart, unit, -(wanted - 1))
    const byKey = new Map(all.map((b) => [b.key, b]))
    series = []
    for (let i = 0; i < wanted; i++) {
      const t = shiftBucket(from, unit, i)
      const k = keyOf(t, unit)
      series.push(
        byKey.get(k) ?? {
          key: k,
          at: startOfBucket(k, unit),
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          calls: 0,
          byModel: new Map(),
        },
      )
    }
  }

  const buckets = series.map((b) => {
    let cost = 0
    for (const [model, t] of b.byModel) {
      const p = priceOf(model)
      cost += (t.input / 1e6) * (p?.in ?? 0)
      cost += (t.output / 1e6) * (p?.out ?? 0)
      cost += (t.cacheRead / 1e6) * (p?.cacheRead ?? 0)
      cost += (t.cacheWrite / 1e6) * (p?.cacheWrite ?? 0)
    }
    const total = b.input + b.output + b.cacheRead + b.cacheWrite
    return {
      key: b.key,
      at: b.at,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      total,
      cost: Math.round(cost * 10000) / 10000,
      calls: b.calls,
      models: [...b.byModel]
        .map(([model, t]) => ({
          model,
          total: t.input + t.output + t.cacheRead + t.cacheWrite,
        }))
        .sort((a, b2) => b2.total - a.total)
        .slice(0, 4),
    }
  })

  return {
    unit,
    buckets,
    start: buckets.length ? buckets[0].at : 0,
    end: buckets.length ? buckets[buckets.length - 1].at : 0,
  }
}
