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
const CACHE_VERSION = 2

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
 */
function decompressMultiFrame(buf) {
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
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], to)))
    } catch {
      /* 坏帧跳过，不影响其它帧 */
    }
  }
  return Buffer.concat(parts)
}

/**
 * 解析一个会话文件，返回该文件里的每次调用。
 * @returns {{ records: number[][], models: string[] }} records 里每条是 [t, modelIdx, input, output, cacheRead, cacheWrite]
 */
function parseFile(full) {
  let buf
  try {
    buf = fs.readFileSync(full)
  } catch {
    return null
  }
  let text
  try {
    text = decompressMultiFrame(buf).toString('utf8')
  } catch {
    return null
  }
  if (!text) return { records: [], models: [] }

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
  return { records, models }
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
    if (old && old.stamp === stamp && Array.isArray(old.records)) {
      // 命中缓存：把模型名重新映射到本次的索引表
      const localModels = old.models ?? []
      for (const r of old.records) {
        const m = localModels[r[1]] ?? 'unknown'
        records.push([r[0], idxOf(m), r[2], r[3], r[4], r[5]])
      }
      next.files[full] = old
      continue
    }
    const parsed = parseFile(full)
    if (!parsed) continue
    scanned++
    for (const r of parsed.records) {
      const m = parsed.models[r[1]] ?? 'unknown'
      records.push([r[0], idxOf(m), r[2], r[3], r[4], r[5]])
    }
    next.files[full] = { stamp, models: parsed.models, records: parsed.records }
  }

  // 丢掉已经不存在的文件
  if (scanned > 0 || !Object.keys(cache.files).length) writeCache(next)
  const result = { records, models, scanned, files: files.length, at: Date.now() }
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
  const wanted = limit > 0 ? limit : 0
  let series = all
  if (wanted > 0) {
    const lastAt = all.length ? all[all.length - 1].at : endAt
    const from = shiftBucket(lastAt, unit, -(wanted - 1))
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
