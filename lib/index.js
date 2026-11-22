/**
 * dsh-token-ring —— 主机侧
 *
 * 职责：读 DSH 的会话投影缓存，把 token 用量 / 估算花费 / 模型占比
 * 聚合成一份 JSON，交给设置页那几个圆环画出来。
 *
 * 数据来源：~/.dsh/storages/session_projcache/sessions/session-*.json
 *   record.rows.tokenUsage.val.totals      → 四类 token 累计
 *   record.rows.modelSelection.val.lastUsed → 该会话最后用的模型
 *   record.identity.createdAt / cwd         → 时间与项目
 *
 * 定价：优先用 ~/.dsh/token-usage/pricing.ccsa.json（223 个模型的真实价目），
 * 读不到就落到内置兜底表。模型名带 `cn:` 这类地区前缀时自动剥掉再匹配。
 *
 * 只读，绝不写回任何 DSH 数据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scanTimeline, buildBuckets } from './timeline.js'

const TAG = '[dsh-token-ring]'
const API = '/dsh-token-ring/api'
const HOME = os.homedir()
const SESSION_DIR = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
const PRICING_FILE = path.join(HOME, '.dsh', 'token-usage', 'pricing.ccsa.json')

/** 缓存价目表，避免每次请求都去解析 106 KB 的 JSON */
const CACHE_TTL = 60_000
let pricingCache = { at: 0, map: null }
/** 聚合结果短缓存：连续刷新设置页不必重复扫盘 */
const STATS_TTL = 20_000
const statsCache = new Map()

/** 后台轮询间隔：进页面之前就把扫描做完了 */
const WARM_POLL_MS = 30_000

/**
 * 后台定时把扫描跑完。
 * 每次调用 scanTimeline(true)：
 *   - 没变动的文件走磁盘缓存（毫秒级）
 *   - 有变动的只解压新帧（毫秒级，纯追加写）
 *   - 结果写进 liveCache（5s 内存缓存）+ timeline-cache.json + session-archive.json
 * 这样进页面时拿到的 liveCache 已经是 ≤30s 的旧数据，HTTP 只负责序列化。
 */
let warmTimer = null
function startWarm() {
  if (warmTimer) return
  const tick = () => {
    try {
      scanTimeline(true)
    } catch (e) {
      console.warn(`${TAG} 后台扫盘失败：${e?.message ?? e}`)
    }
  }
  warmTimer = setInterval(tick, WARM_POLL_MS)
  if (typeof warmTimer.unref === 'function') warmTimer.unref()
  // 启动时先热身一次，不等第一个周期
  tick()
}

function stopWarm() {
  if (!warmTimer) return
  clearInterval(warmTimer)
  warmTimer = null
}

/** 兜底价（RMB / 每百万 token）。表读不到时至少不会算出 0 */
const FALLBACK_PRICING = {
  'deepseek-v4.1-flash': { in: 1.0, out: 4.0, cacheRead: 0.02, cacheWrite: 1.0 },
  'deepseek-v4-flash': { in: 1.0, out: 4.0, cacheRead: 0.02, cacheWrite: 1.0 },
  'deepseek-flash': { in: 1.0, out: 4.0, cacheRead: 0.02, cacheWrite: 1.0 },
  'deepseek-chat': { in: 1.89, out: 7.7, cacheRead: 0.49, cacheWrite: 1.89 },
  'deepseek-reasoner': { in: 3.85, out: 15.33, cacheRead: 0.98, cacheWrite: 3.85 },
  'deepseek-v3': { in: 1.96, out: 7.77, cacheRead: 0.196, cacheWrite: 1.96 },
  'deepseek-v3.2': { in: 1.96, out: 2.94, cacheRead: 0.196, cacheWrite: 1.96 },
  'glm-5.3-flash': { in: 0.8, out: 2.8, cacheRead: 0.23, cacheWrite: 0.8 },
  'glm-4.5-air': { in: 0.8, out: 2.0, cacheRead: 0.16, cacheWrite: 0.8 },
}

/** 表里查不到时用的默认价（按 flash 档最省的那一档，宁可低估不虚报） */
const DEFAULT_PRICE = { in: 1.0, out: 4.0, cacheRead: 0.02, cacheWrite: 1.0 }

/** `cn:deepseek-v4.1-flash` → `deepseek-v4.1-flash` */
function normalizeId(id) {
  return String(id ?? '')
    .trim()
    .replace(/^[a-z]{2,3}:/i, '')
    .toLowerCase()
}

function loadPricing() {
  const now = Date.now()
  if (pricingCache.map && now - pricingCache.at < CACHE_TTL) return pricingCache.map

  const map = new Map()
  try {
    const raw = fs.readFileSync(PRICING_FILE, 'utf8')
    const j = JSON.parse(raw)
    for (const m of j?.models ?? []) {
      const price = {
        in: Number(m.inputCostPerMillion) || 0,
        out: Number(m.outputCostPerMillion) || 0,
        cacheRead: Number(m.cacheReadCostPerMillion) || 0,
        cacheWrite: Number(m.cacheCreationCostPerMillion) || 0,
      }
      if (m.modelId) map.set(normalizeId(m.modelId), price)
      for (const a of m.aliases ?? []) {
        if (a && !String(a).includes('^')) map.set(normalizeId(a), price)
      }
    }
  } catch {
    /* 表不存在或坏了，走兜底 */
  }
  for (const [k, v] of Object.entries(FALLBACK_PRICING)) {
    if (!map.has(k)) map.set(k, v)
  }
  pricingCache = { at: now, map }
  return map
}

function priceOf(pricing, model) {
  return pricing.get(normalizeId(model)) ?? DEFAULT_PRICE
}

/** 四类 token 折算成人民币 */
function costOf(tokens, price) {
  return (
    ((tokens.input ?? 0) / 1e6) * price.in +
    ((tokens.output ?? 0) / 1e6) * price.out +
    ((tokens.cacheRead ?? 0) / 1e6) * price.cacheRead +
    ((tokens.cacheWrite ?? 0) / 1e6) * price.cacheWrite
  )
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 扫一遍会话缓存 */
function readSessions() {
  let names = []
  try {
    names = fs.readdirSync(SESSION_DIR)
  } catch (e) {
    console.warn(`${TAG} 读不到会话缓存目录：${e?.message ?? e}`)
    return []
  }

  const out = []
  for (const name of names) {
    // 实际文件名是 <uuid>.json，早期版本带 session- 前缀，两种都收
    if (!name.endsWith('.json') || name.startsWith('.') || name.startsWith('.tmp')) continue
    const full = path.join(SESSION_DIR, name)
    try {
      const j = JSON.parse(fs.readFileSync(full, 'utf8'))
      const rec = j?.record
      if (!rec) continue
      const tu = rec.rows?.tokenUsage?.val?.totals
      if (!tu) continue

      const tokens = {
        input: num(tu.uncachedInputTokens),
        output: num(tu.outputTokens),
        cacheRead: num(tu.cacheReadTokens),
        cacheWrite: num(tu.cacheWriteTokens),
      }
      const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
      if (total <= 0) continue

      const lastUsed = rec.rows?.modelSelection?.val?.lastUsed
      out.push({
        id: name.startsWith('session-')
        ? name.slice('session-'.length, -'.json'.length)
        : name.slice(0, -'.json'.length),
        createdAt: Number(rec.identity?.createdAt) || 0,
        // 「最后活动时间」：跨天的会话今天还在用，只按 createdAt 筛会把它们整个漏掉
        lastActiveAt: Math.max(
          num(rec.rows?.timeContext?.val?.lastMessageTime),
          num(rec.rows?.sessionListMetadata?.val?.lastPromptAt),
          Number(rec.identity?.createdAt) || 0,
        ),
        cwd: String(rec.identity?.cwd ?? rec.rows?.workingDirectory?.val ?? ''),
        title: String(rec.rows?.title?.val ?? '').trim(),
        model: String(lastUsed?.model ?? 'unknown'),
        provider: String(lastUsed?.provider ?? ''),
        turns: num(rec.rows?.sessionStats?.val?.turns),
        tokens,
        total,
      })
    } catch {
      /* 坏文件直接跳过，不影响整体 */
    }
  }
  return out
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function buildStats(range) {
  const now = Date.now()
  const hit = statsCache.get(range)
  if (hit && now - hit.at < STATS_TTL) return hit.data

  const since =
    range === 'today'
      ? startOfToday()
      : range === '7d'
        ? now - 7 * 864e5
        : range === '30d'
          ? now - 30 * 864e5
          : range === '90d'
            ? now - 90 * 864e5
            : 0

  // 按「每一次调用」的时间戳过滤，而不是「会话最后活跃时间 + 会话累计 token」。
  // 后者会把一个跨天老会话几十天的历史全算进「今天」—— 实测能差一百多倍。
  // force=false：不绕过 5s 内存缓存，平时毫秒级
  const scanned = scanTimeline()
  const modelNames = scanned.models || []
  const priceCache = loadPricing()

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const byModel = new Map()
  const touchedFiles = new Set()
  const providerOf = new Map()
  let cost = 0
  let turns = 0
  let calls = 0

  for (const r of scanned.records || []) {
    const t = r[0]
    if (since > 0 && t < since) continue
    const model = modelNames[r[1]] ?? 'unknown'
    const input = r[2] || 0
    const output = r[3] || 0
    const cacheRead = r[4] || 0
    const cacheWrite = r[5] || 0

    const price = priceOf(priceCache, model)
    const c = costOf({ input, output, cacheRead, cacheWrite }, price)
    cost += c
    calls++

    totals.input += input
    totals.output += output
    totals.cacheRead += cacheRead
    totals.cacheWrite += cacheWrite
    if (r[6] !== undefined && r[6] >= 0) touchedFiles.add(r[6])

    let bucket = byModel.get(model)
    if (!bucket) {
      bucket = {
        model,
        provider: providerOf.get(model) ?? (model.startsWith('cn:') ? 'dsh' : ''),
        sessions: 0,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      byModel.set(model, bucket)
    }
    bucket.cost += c
    bucket.tokens.input += input
    bucket.tokens.output += output
    bucket.tokens.cacheRead += cacheRead
    bucket.tokens.cacheWrite += cacheWrite
  }

  // 「会话数」按「这段时间内真的有调用的会话文件」算
  for (const [, b] of byModel) b.sessions = touchedFiles.size
  turns = calls

  const totalTokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite

  // 缓存命中率：缓存读 ÷（未缓存输入 + 缓存读 + 缓存写）
  const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite
  const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0

  /** 缓存读如果按未命中价算要多少钱 —— 用来展示「缓存省了多少钱」 */
  let cacheSaved = 0
  for (const [model, b] of byModel) {
    const price = priceOf(priceCache, model)
    const miss = (b.tokens.cacheRead / 1e6) * (price?.in ?? 0)
    const real = (b.tokens.cacheRead / 1e6) * (price?.cacheRead ?? 0)
    cacheSaved += Math.max(0, miss - real)
  }

  const models = [...byModel.values()]
    .map((m) => ({
      ...m,
      total: m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite,
      share: totalTokens > 0
        ? (m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite) / totalTokens
        : 0,
    }))
    .sort((a, b) => b.total - a.total)

  const data = {
    ok: true,
    range,
    generatedAt: now,
    currency: 'RMB',
    pricingSource: pricingCache.map && fs.existsSync(PRICING_FILE) ? 'pricing.ccsa.json' : '内置兜底表',
    sessionCount: touchedFiles.size,
    allSessionCount: (scanned.fileIds || []).length,
    archivedSessions: scanned.archivedSessions || 0,
    archivedRecords: scanned.archivedRecords || 0,
    turns,
    totals: { ...totals, total: totalTokens },
    cost,
    cacheSaved,
    cacheHitRate,
    models,
  }

  statsCache.set(range, { at: now, data })
  return data
}

/** 同进程重复加载（desktop + web 共用 webServer）时，先卸旧实例再挂 */
let LIVE = null

export default {
  name: 'dsh-token-ring',
  inject: ['webServer'],
  apply(ctx) {
    if (LIVE) {
      try {
        LIVE()
      } catch (e) {
        console.warn(`${TAG} 卸载旧实例失败（已忽略）：${e?.message ?? e}`)
      }
      LIVE = null
    }

    const disposers = []
    let stopped = false
    const dispose = () => {
      if (stopped) return
      stopped = true
      for (const d of disposers) {
        try {
          d?.()
        } catch {}
      }
      disposers.length = 0
      if (LIVE === dispose) LIVE = null
    }
    LIVE = dispose
    ctx.effect(() => dispose, 'dsh-token-ring: lifecycle')

    // 后台热身：DSH 启动后就持续扫，进页面拿到的已经是预热数据
    startWarm()
    disposers.push(() => stopWarm())

    const json = (res, code, obj) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(obj))
    }

    /** 回环直放，其余交给 connection 判定（fail-closed） */
    const guarded = (req, res) => {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1') return false
      try {
        const conn = ctx.get?.('connection') ?? ctx.connection
        if (conn && typeof conn.requestRejection === 'function') {
          const code = conn.requestRejection(req)
          if (code === undefined || code === null || code === false) return false
          res.statusCode = typeof code === 'number' ? code : 403
          res.end()
          return true
        }
      } catch {}
      json(res, 403, { ok: false, error: '不受信任的访问来源' })
      return true
    }

    try {
      disposers.push(
        ctx.webServer.register({
          kind: 'get',
          path: `${API}/stats`,
          handler: async (req, res) => {
            if (guarded(req, res)) return
            try {
              let range = 'all'
              try {
                const u = new URL(req.url ?? '/', 'http://127.0.0.1')
                const q = u.searchParams.get('range')
                if (q) range = q
              } catch {}
              json(res, 200, buildStats(range))
            } catch (e) {
              json(res, 500, { ok: false, error: String(e?.message ?? e) })
            }
          },
        }),
      )
    } catch (e) {
      console.warn(`${TAG} 路由没注册上（可能已被占用）：${e?.message ?? e}`)
    }

    // ---- 时间线：按小时 / 天 / 月聚合的真实用量
    try {
      disposers.push(
        ctx.webServer.register({
          kind: 'get',
          path: `${API}/timeline`,
          handler: async (req, res) => {
            if (guarded(req, res)) return
            try {
              const u = new URL(req.url ?? '/', 'http://127.0.0.1')
              const unitRaw = String(u.searchParams.get('unit') || 'hour').toLowerCase()
              const unit = unitRaw === 'day' || unitRaw === 'month' ? unitRaw : 'hour'
              const limitRaw = Number(u.searchParams.get('limit') || 0)
              const limit =
                Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : unit === 'hour' ? 48 : unit === 'day' ? 30 : 12
              const scanned = scanTimeline()
              const pricing = loadPricing()
              const data = buildBuckets(
                scanned.records,
                scanned.models,
                (m) => priceOf(pricing, m),
                unit,
                limit,
              )
              json(res, 200, {
                ok: true,
                ...data,
                limit,
                calls: scanned.records.length,
                files: scanned.files,
                rescanned: scanned.scanned,
                generatedAt: Date.now(),
              })
            } catch (e) {
              json(res, 500, { ok: false, error: String(e?.message ?? e) })
            }
          },
        }),
      )
    } catch (e) {
      console.warn(`${TAG} 时间线路由没注册上：${e?.message ?? e}`)
    }
  },
}
