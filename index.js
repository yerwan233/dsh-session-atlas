/**
 * dsh-session-atlas —— 「工作区图」的 Host 半边。
 *
 * 浏览器半边能读 `useWorkspaces` / `useSessions`，但有三件事只有 Host 能做：
 *   ① 分组数据要跨浏览器 / 跨 web 与桌面端口共享 → 存 `%DSH_HOME%\workspace-graph\groups.json`；
 *   ② `Workspace.attachSession()` 只挂在宿主返回的工作区实体上，客户端服务没有这个方法；
 *   ③ 「建工作区（复用同目录）+ 改标题 + 收编同目录会话」需要按宿主校验结果逐条报告。
 *
 * 路由（全部精确匹配，挂在 ctx.get('webServer') 上；没有 webServer 的 profile 静默不做事）：
 *   GET  /workspace-graph/state            读分组
 *   POST /workspace-graph/groups           整表替换分组（建 / 改 / 合并 / 删一次提交）
 *   POST /workspace-graph/create-workspace 建或复用工作区 → 改标题 → 收编
 *   POST /workspace-graph/attach           只收编（同目录才能成功，其余如实报告）
 *   POST /workspace-graph/detach           解挂（不动会话日志）
 *
 * 硬约束（已核对 dsh-workspace 源码，不绕过）：
 *   - 工作区成员资格 = 会话头里不可变 cwd 的 realpath 等于工作区路径；
 *     `attachSession` 对不匹配的会话会 reject，这里只把错误分类后原样报告。
 *   - 绝不写 DSH 的 workspace 存储、绝不改会话头 / 会话日志 / 目录。
 *
 * 安全：写路由要求 POST + 同源 Origin（或无 Origin）+ `application/json`；
 * 跨站 fetch 会被 `sec-fetch-site`/预检挡住，避免任意网页改本机工作区数据。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-session-atlas'

export const ROUTE_STATE = '/workspace-graph/state'
export const ROUTE_GROUPS = '/workspace-graph/groups'
export const ROUTE_LAYOUT = '/workspace-graph/layout'
export const ROUTE_CREATE = '/workspace-graph/create-workspace'
export const ROUTE_ATTACH = '/workspace-graph/attach'
export const ROUTE_DETACH = '/workspace-graph/detach'

export const LIMITS = {
  maxGroups: 200,
  maxSessionsPerGroup: 2000,
  maxSessionsTotal: 20000,
  maxBodyBytes: 256 * 1024,
  maxTitleLength: 60,
  maxIdLength: 80,
  maxDetailLength: 200,
  maxLayoutNodes: 2000,
  maxCoord: 100000,
}

/** 节点图的节点键：`ws:<id>` / `grp:<id>` / `sess:<id>` / `unassigned`。 */
const LAYOUT_KEY = /^(?:(?:ws|grp|sess):[A-Za-z0-9_-]{1,80}|unassigned)$/

/**
 * 会话 id 的保守形状校验：只要 `session-` 前缀 + 常见字符，存在性由宿主校验。
 * 故意不写死 uuid 长度——格式变一次就静默丢成员比放宽更糟。
 */
const SESSION_ID = /^(?:session-)?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

/** 写文件串行队列：同一进程内的写不会交错，也不需要额外锁。 */
let writeTail = Promise.resolve()

/**
 * 分组文件位置：`DSH_WORKSPACE_GRAPH_FILE` 优先（测试注入），否则 `%DSH_HOME%\workspace-graph\groups.json`。
 * @returns {string} 绝对路径。
 */
export function groupsFile() {
  const override = process.env.DSH_WORKSPACE_GRAPH_FILE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
  return join(home, 'workspace-graph', 'groups.json')
}

/**
 * 把任意错误压成一句可展示的文字。
 * @param {unknown} error - 捕获到的错误。
 * @returns {string} 文字。
 */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 取请求头（兼容 Node 的普通对象与 Headers 形态）。
 * @param {object} req - 入站请求。
 * @param {string} key - 小写头名。
 * @returns {string|undefined} 头值。
 */
function headerOf(req, key) {
  const headers = req && typeof req === 'object' ? req.headers : undefined
  if (headers === undefined || headers === null) return undefined
  let value
  if (typeof headers.get === 'function') value = headers.get(key)
  else value = headers[key]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * 统一 JSON 响应。
 * @param {object} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 可 JSON 序列化响应体。
 * @param {boolean} [headOnly] - HEAD 只发头。
 */
function sendJson(res, status, body, headOnly) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(headOnly === true ? undefined : text)
}

/**
 * 失败响应：`code` 给客户端分支，`message` 给人看。
 * @param {object} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {string} code - 机器可读错误码。
 * @param {string} message - 中文短说明。
 */
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message })
}

/**
 * 插件日志：优先宿主 logger，缺了就退回 console，绝不因为日志失败影响主流程。
 * @param {object} ctx - Cordis 上下文。
 * @param {'info'|'warn'} level - 级别。
 * @param {string} text - 内容。
 */
function log(ctx, level, text) {
  const line = `[workspace-graph] ${text}`
  try {
    const logger = ctx && typeof ctx === 'object' ? ctx.logger ?? ctx.get?.('logger') : undefined
    if (logger && typeof logger[level] === 'function') {
      logger[level](line)
      return
    }
  } catch {
    /* 日志服务异常时退回 console */
  }
  try {
    if (typeof console[level] === 'function') console[level](line)
  } catch {
    /* ignore */
  }
}

/**
 * 规范化标题：空串保留为「未命名」（由客户端按界面语言兜底显示），其余裁到上限。
 * @param {unknown} value - 原始标题。
 * @returns {string} 标题。
 */
export function normalizeTitle(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? '' : text.slice(0, LIMITS.maxTitleLength)
}

/**
 * 规范化一组会话 id：形状不对、重复的都丢掉，按出现顺序保留。
 * @param {unknown} input - 原始数组。
 * @returns {string[]} 会话 id。
 */
export function normalizeSessionIds(input) {
  const out = []
  if (!Array.isArray(input)) return out
  const seen = new Set()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || id.length > LIMITS.maxIdLength) continue
    if (!SESSION_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= LIMITS.maxSessionsPerGroup) break
  }
  return out
}

/**
 * 合法 ISO 时间串或当前时间。
 * @param {unknown} value - 原始值。
 * @returns {string} ISO 时间串。
 */
function isoOrNow(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value)
    if (Number.isFinite(time)) return new Date(time).toISOString()
  }
  return new Date().toISOString()
}

/**
 * 整表规范化：丢弃非法条目、去重 id、裁剪标题、夹取上限。读和写都走这里，损坏文件自然降级。
 * @param {unknown} input - 原始 groups 数组。
 * @returns {Array<{id: string, title: string, sessionIds: string[], createdAt: string, updatedAt: string}>} 分组。
 */
export function normalizeGroupList(input) {
  const groups = []
  if (!Array.isArray(input)) return groups
  const seen = new Set()
  let total = 0
  for (const entry of input) {
    if (groups.length >= LIMITS.maxGroups || total >= LIMITS.maxSessionsTotal) break
    if (entry === null || typeof entry !== 'object') continue
    let id = typeof entry.id === 'string' ? entry.id.trim().slice(0, LIMITS.maxIdLength) : ''
    if (id === '' || seen.has(id)) id = `grp-${randomUUID()}`
    while (seen.has(id)) id = `grp-${randomUUID()}`
    seen.add(id)
    const sessionIds = normalizeSessionIds(entry.sessionIds)
    total += sessionIds.length
    groups.push({
      id,
      title: normalizeTitle(entry.title),
      sessionIds,
      createdAt: isoOrNow(entry.createdAt),
      updatedAt: isoOrNow(entry.updatedAt),
    })
  }
  return groups
}

/**
 * 规范化节点图布局：位置有限、坐标夹取、键形状校验、条目上限。
 * 客户端是唯一写者，但坏文件/手改文件不能让页面崩，所以读和写都走这里。
 * 注意：**只记展开态、没有手动位置的条目必须保留**（否则「展开/收起」刷新后就丢了）。
 * @param {unknown} input - 原始 layout（`{nodes}` 或直接 nodes）。
 * @returns {{nodes: Record<string, {x?: number, y?: number, expanded?: boolean}>}} 布局。
 */
export function normalizeLayout(input) {
  const source =
    input !== null && typeof input === 'object' && input.nodes !== null && typeof input.nodes === 'object'
      ? input.nodes
      : input !== null && typeof input === 'object'
        ? input
        : {}
  const nodes = {}
  let count = 0
  for (const key of Object.keys(source)) {
    if (count >= LIMITS.maxLayoutNodes) break
    const value = source[key]
    if (!LAYOUT_KEY.test(key) || value === null || typeof value !== 'object') continue
    const x = Number(value.x)
    const y = Number(value.y)
    const hasX = Number.isFinite(x)
    const hasY = Number.isFinite(y)
    const hasExpanded = value.expanded === true || value.expanded === false
    if (!hasX && !hasY && !hasExpanded) continue
    const entry = {}
    if (hasX) entry.x = Math.min(LIMITS.maxCoord, Math.max(-LIMITS.maxCoord, x))
    if (hasY) entry.y = Math.min(LIMITS.maxCoord, Math.max(-LIMITS.maxCoord, y))
    if (hasExpanded) entry.expanded = value.expanded === true
    nodes[key] = entry
    count += 1
  }
  return { nodes }
}

/** 空状态（version 2：分组 + 布局）。 */
function emptyState() {
  return { version: 2, updatedAt: null, groups: [], layout: { nodes: {} } }
}

/** 不经写队列的原始读取（只在 updateState 的队列任务里用）。 */
async function readStateUnlocked(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return {
      version: 2,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      groups: normalizeGroupList(Array.isArray(parsed?.groups) ? parsed.groups : []),
      layout: normalizeLayout(parsed?.layout),
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      log(undefined, 'warn', `读状态失败（按空集处理）：${messageOf(error)}`)
    }
    return emptyState()
  }
}

/**
 * 读完整状态（分组 + 布局）；文件缺失、损坏都退化成空集。
 * @param {string} [file] - 状态文件路径。
 * @returns {Promise<{version: number, updatedAt: string|null, groups: object[], layout: {nodes: object}}>} 状态。
 */
export async function readState(file = groupsFile()) {
  return readStateUnlocked(file)
}

/**
 * 兼容旧调用：只读分组部分（测试与既有代码用）。
 * @param {string} [file] - 状态文件路径。
 * @returns {Promise<{version: number, updatedAt: string|null, groups: object[]}>} 分组视图。
 */
export async function readGroups(file = groupsFile()) {
  const state = await readStateUnlocked(file)
  return { version: state.version, updatedAt: state.updatedAt, groups: state.groups }
}

/**
 * 串行执行一次读改写。
 * @param {() => Promise<unknown>} task - 任务。
 * @returns {Promise<unknown>} 任务结果。
 */
function enqueueWrite(task) {
  const next = writeTail.then(task, task)
  writeTail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * 串行执行一次读改写：先把整份状态读进来，交给 mutator 产出新状态，再原子落盘。
 * 所有写（分组、布局）共用这一条队列，避免互相覆盖。
 * @param {(current: {groups: object[], layout: {nodes: object}}) => {groups?: unknown, layout?: unknown}} mutator - 变更函数。
 * @param {string} [file] - 状态文件路径。
 * @returns {Promise<{version: number, updatedAt: string, groups: object[], layout: {nodes: object}}>} 落盘状态。
 */
export async function updateState(mutator, file = groupsFile()) {
  return enqueueWrite(async () => {
    const current = await readStateUnlocked(file)
    const next = mutator({ groups: current.groups, layout: current.layout })
    const state = {
      version: 2,
      updatedAt: new Date().toISOString(),
      groups: normalizeGroupList(next?.groups === undefined ? current.groups : next.groups),
      layout: normalizeLayout(next?.layout === undefined ? current.layout : next.layout),
    }
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return state
  })
}

/**
 * 兼容旧调用：只替换分组，保留现有布局。
 * @param {unknown} groups - 待写分组。
 * @param {string} [file] - 状态文件路径。
 * @returns {Promise<{version: number, updatedAt: string, groups: object[], layout: {nodes: object}}>} 落盘状态。
 */
export async function writeGroups(groups, file = groupsFile()) {
  return updateState(() => ({ groups }), file)
}

/**
 * 校验一个写请求：方法、同源、Content-Type。
 * @param {object} req - 入站请求。
 * @returns {{ok: true} | {ok: false, status: number, code: string, message: string}} 判定。
 */
export function mutationAllowed(req) {
  if (!req || req.method !== 'POST') {
    return { ok: false, status: 405, code: 'bad-method', message: '只接受 POST' }
  }
  if (headerOf(req, 'sec-fetch-site') === 'cross-site') {
    return { ok: false, status: 403, code: 'denied-origin', message: '跨站请求已拒绝' }
  }
  const origin = headerOf(req, 'origin')
  if (origin !== undefined && origin !== '') {
    const host = headerOf(req, 'host')
    let same = false
    try {
      same = typeof host === 'string' && new URL(origin).host === host
    } catch {
      same = false
    }
    if (!same) return { ok: false, status: 403, code: 'denied-origin', message: '只允许同源请求' }
  }
  const type = headerOf(req, 'content-type')
  if (typeof type !== 'string' || !/^application\/json\b/i.test(type)) {
    return { ok: false, status: 415, code: 'bad-content-type', message: '需要 application/json' }
  }
  return { ok: true }
}

/**
 * 读 JSON 请求体，带体积上限。
 * @param {object} req - 入站请求（可读流）。
 * @param {number} limit - 字节上限。
 * @returns {Promise<unknown>} 解析结果；空体返回 {}。
 */
export function readJsonBody(req, limit = LIMITS.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve({})
      return
    }
    const chunks = []
    let total = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buffer.length
      if (total > limit) {
        const error = new Error('请求体超过上限')
        error.code = 'too-large'
        finish(reject, error)
        try {
          req.destroy?.()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        finish(resolve, {})
        return
      }
      try {
        finish(resolve, JSON.parse(text))
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.code = 'bad-json'
        finish(reject, error)
      }
    })
    req.on('error', (error) => finish(reject, error))
  })
}

/**
 * 把 attachSession 的错误归类，供界面显示原因（不吞掉原始 detail）。
 * @param {unknown} error - attachSession 抛出的错误。
 * @returns {string} 状态码。
 */
export function classifyAttachError(error) {
  const text = messageOf(error)
  if (text.includes('carries no cwd')) return 'no-cwd'
  if (text.includes('does not resolve')) return 'cwd-unresolved'
  if (text.includes('is not a directory')) return 'cwd-mismatch'
  if (text.includes('its cwd resolves to')) return 'cwd-mismatch'
  if (text.includes('holds no such session') || text.includes('cannot validate session')) return 'not-found'
  return 'failed'
}

/**
 * 逐个收编；已在成员里的直接报 `already`，其余按宿主校验结果分类。
 * @param {object} entity - 工作区实体。
 * @param {string[]} sessionIds - 会话 id。
 * @returns {Promise<Array<{sessionId: string, status: string, detail?: string}>>} 结果。
 */
export async function attachSessions(entity, sessionIds) {
  const results = []
  for (const sessionId of sessionIds) {
    const accounted = Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)
    if (accounted) {
      results.push({ sessionId, status: 'already' })
      continue
    }
    try {
      await entity.attachSession(sessionId)
      results.push({ sessionId, status: 'attached' })
    } catch (error) {
      results.push({
        sessionId,
        status: classifyAttachError(error),
        detail: messageOf(error).slice(0, LIMITS.maxDetailLength),
      })
    }
  }
  return results
}

/**
 * 逐个解挂；不在成员里的报 `absent`。
 * @param {object} entity - 工作区实体。
 * @param {string[]} sessionIds - 会话 id。
 * @returns {Promise<Array<{sessionId: string, status: string, detail?: string}>>} 结果。
 */
export async function detachSessions(entity, sessionIds) {
  const results = []
  for (const sessionId of sessionIds) {
    const accounted = Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)
    if (!accounted) {
      results.push({ sessionId, status: 'absent' })
      continue
    }
    try {
      await entity.detachSession(sessionId)
      results.push({ sessionId, status: 'detached' })
    } catch (error) {
      results.push({
        sessionId,
        status: 'failed',
        detail: messageOf(error).slice(0, LIMITS.maxDetailLength),
      })
    }
  }
  return results
}

/**
 * 在 Host 上找到注册表服务。
 * @param {object} ctx - Cordis 上下文。
 * @returns {object|undefined} 注册表。
 */
function registryOf(ctx) {
  let registry
  try {
    registry = ctx.get?.('workspaceRegistry')
  } catch {
    registry = undefined
  }
  return registry && typeof registry.get === 'function' ? registry : undefined
}

/**
 * 读一个可选服务（取不到不抛）。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} name - 服务名。
 * @returns {object|undefined} 服务。
 */
function serviceOf(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 把全部路由注册到给定上下文持有的 webServer 上。
 * @param {object} ownerCtx - 持有生命周期的上下文（路由随它卸载）。
 * @param {object} webServer - webServer 服务。
 * @returns {number} 注册条数。
 */
function registerRoutes(ownerCtx, webServer) {
  const routes = buildRoutes(ownerCtx)
  for (const route of routes) {
    ownerCtx.effect(
      () => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `workspace-graph: ${route.path}`,
    )
  }
  return routes.length
}

/** GET /state 处理器。 */
async function handleState(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'bad-method', '只接受 GET')
    return
  }
  const state = await readState()
  sendJson(
    res,
    200,
    {
      ok: true,
      version: state.version,
      updatedAt: state.updatedAt,
      groups: state.groups,
      layout: state.layout,
      limits: LIMITS,
    },
    req.method === 'HEAD',
  )
}

/** POST /groups 处理器（整表替换分组，保留布局）。 */
async function handleGroups(req, res) {
  const allowed = mutationAllowed(req)
  if (allowed.ok !== true) {
    fail(res, allowed.status, allowed.code, allowed.message)
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const code = error && error.code === 'too-large' ? 'too-large' : 'bad-json'
    fail(res, code === 'too-large' ? 413 : 400, code, messageOf(error))
    return
  }
  const raw = Array.isArray(body) ? body : body && typeof body === 'object' ? body.groups : []
  const state = await updateState(() => ({ groups: raw }))
  sendJson(res, 200, { ok: true, version: state.version, updatedAt: state.updatedAt, groups: state.groups, layout: state.layout })
}

/** POST /layout 处理器：只替换节点位置/展开态，保留分组。 */
async function handleLayout(req, res) {
  const allowed = mutationAllowed(req)
  if (allowed.ok !== true) {
    fail(res, allowed.status, allowed.code, allowed.message)
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const code = error && error.code === 'too-large' ? 'too-large' : 'bad-json'
    fail(res, code === 'too-large' ? 413 : 400, code, messageOf(error))
    return
  }
  const nodes = body && typeof body === 'object' ? body.nodes : undefined
  const state = await updateState(() => ({ layout: { nodes } }))
  sendJson(res, 200, { ok: true, version: state.version, updatedAt: state.updatedAt, layout: state.layout })
}

/** POST /create-workspace 处理器。 */
async function handleCreateWorkspace(ctx, req, res) {
  const allowed = mutationAllowed(req)
  if (allowed.ok !== true) {
    fail(res, allowed.status, allowed.code, allowed.message)
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const code = error && error.code === 'too-large' ? 'too-large' : 'bad-json'
    fail(res, code === 'too-large' ? 413 : 400, code, messageOf(error))
    return
  }
  const path = body && typeof body.path === 'string' ? body.path.trim() : ''
  if (path === '') {
    fail(res, 400, 'path-required', '缺少目录 path')
    return
  }
  const registry = registryOf(ctx)
  if (registry === undefined || typeof registry.create !== 'function') {
    fail(res, 503, 'registry-unavailable', '当前 Host 没有 workspaceRegistry')
    return
  }
  let workspace
  let created = false
  try {
    const existing = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(path) : undefined
    if (existing !== undefined && existing !== null) {
      workspace = existing
    } else {
      workspace = await registry.create(path)
      created = true
    }
  } catch (error) {
    fail(res, 400, 'create-failed', messageOf(error))
    return
  }
  if (workspace === undefined || workspace === null) {
    fail(res, 500, 'create-failed', '注册表没有返回工作区')
    return
  }
  const entity = (typeof registry.get === 'function' ? registry.get(workspace.id) : undefined) ?? workspace
  const title = normalizeTitle(body.title)
  let titleApplied = false
  if (title !== '' && entity.title !== title) {
    try {
      await entity.setTitle(title)
      titleApplied = true
    } catch (error) {
      log(ctx, 'warn', `设置标题失败：${messageOf(error)}`)
    }
  }
  const adopt = normalizeSessionIds(body.adoptSessionIds)
  const results = adopt.length === 0 ? [] : await attachSessions(entity, adopt)
  const adopted = results.filter((item) => item.status === 'attached' || item.status === 'already').map((item) => item.sessionId)
  const skipped = results.filter((item) => item.status !== 'attached' && item.status !== 'already')
  sendJson(res, 200, {
    ok: true,
    workspaceId: entity.id,
    path: entity.path,
    title: entity.title,
    created,
    titleApplied,
    adopted,
    skipped,
  })
}

/**
 * POST /attach 与 POST /detach 共用的处理器。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} req - 入站请求。
 * @param {object} res - 响应对象。
 * @param {'attach'|'detach'} mode - 动作。
 */
async function handleMembership(ctx, req, res, mode) {
  const allowed = mutationAllowed(req)
  if (allowed.ok !== true) {
    fail(res, allowed.status, allowed.code, allowed.message)
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const code = error && error.code === 'too-large' ? 'too-large' : 'bad-json'
    fail(res, code === 'too-large' ? 413 : 400, code, messageOf(error))
    return
  }
  const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
  if (workspaceId === '') {
    fail(res, 400, 'workspace-required', '缺少 workspaceId')
    return
  }
  const sessionIds = normalizeSessionIds(body.sessionIds)
  if (sessionIds.length === 0) {
    fail(res, 400, 'sessions-required', '缺少 sessionIds')
    return
  }
  const registry = registryOf(ctx)
  if (registry === undefined) {
    fail(res, 503, 'registry-unavailable', '当前 Host 没有 workspaceRegistry')
    return
  }
  const entity = registry.get(workspaceId)
  if (entity === undefined || entity === null) {
    fail(res, 404, 'workspace-not-found', '工作区不存在')
    return
  }
  const results = mode === 'attach' ? await attachSessions(entity, sessionIds) : await detachSessions(entity, sessionIds)
  sendJson(res, 200, { ok: true, workspaceId: entity.id, results })
}

/**
 * 造出全部路由（测试直接拿这个数组调 handler，不需要真 webServer）。
 * @param {object} ctx - Cordis 上下文。
 * @returns {Array<{path: string, handler: (req: object, res: object) => Promise<void>}>} 路由。
 */
export function buildRoutes(ctx) {
  const wrap = (inner) => async (req, res) => {
    try {
      await inner(req, res)
    } catch (error) {
      try {
        fail(res, 500, 'internal', messageOf(error))
      } catch {
        /* 响应可能已经写出 */
      }
    }
  }
  return [
    { path: ROUTE_STATE, handler: wrap((req, res) => handleState(req, res)) },
    { path: ROUTE_GROUPS, handler: wrap((req, res) => handleGroups(req, res)) },
    { path: ROUTE_LAYOUT, handler: wrap((req, res) => handleLayout(req, res)) },
    { path: ROUTE_CREATE, handler: wrap((req, res) => handleCreateWorkspace(ctx, req, res)) },
    { path: ROUTE_ATTACH, handler: wrap((req, res) => handleMembership(ctx, req, res, 'attach')) },
    { path: ROUTE_DETACH, handler: wrap((req, res) => handleMembership(ctx, req, res, 'detach')) },
  ]
}

/**
 * 插件主体：等 webServer 就绪后再把 6 条路由挂上去。
 *
 * ⚠️ 为什么必须用 `ctx.inject`：profile 启动时 bundle 插入的插件行**早于 webServer 挂载**，
 * 直接在 apply 里 `ctx.get('webServer')` 会拿到 undefined → 路由永远不注册（重启后 404）。
 * `ctx.inject(['webServer'], cb)` 会在服务就绪时再回调；没有 webServer 的 profile 里回调不执行，
 * 插件保持待命，不报错。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - patch 行里的 config（本版不使用）。
 */
export function apply(ctx, config = {}) {
  void config
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        const webServer = serviceOf(webCtx, 'webServer')
        if (webServer === undefined || typeof webServer.register !== 'function') {
          log(ctx, 'warn', 'webServer 已声明但不可用：工作区图路由不启动')
          return
        }
        const count = registerRoutes(webCtx, webServer)
        log(ctx, 'info', `就绪：${count} 条路由；分组文件 ${groupsFile()}`)
      })
      return
    }
    // 老宿主兜底：没有 ctx.inject 就按旧方式直接抓一次（可能拿不到，拿不到就只记日志）。
    const webServer = serviceOf(ctx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log(ctx, 'info', '当前 profile 没有 webServer：工作区图路由不启动')
      return
    }
    const count = registerRoutes(ctx, webServer)
    log(ctx, 'info', `就绪：${count} 条路由；分组文件 ${groupsFile()}`)
  } catch (error) {
    try {
      console.warn(`[workspace-graph] 初始化失败：${messageOf(error)}`)
    } catch {
      /* ignore */
    }
  }
}
