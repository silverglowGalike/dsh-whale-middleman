/**
 * 重试入口：模型侧与用户侧共用一套机制，额度规则分开。
 *
 * 定位（用户 2026-11-19）：插件要支持高度自动化的工作流——简单报错让主会话
 * 自己修，用户专注设计与决策。所以重试给模型也给用户：
 * - 复核族（NEEDS_REVIEW / RECEIPT_UNVERIFIED / NO_RECEIPT）不设上限；
 * - 报错族同一错误码最多 5 次（主会话主动调才计数）；
 * - 用户动手就把额度还回去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-retry-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const core = await import('../lib/core.js')
const { retryTicket } = await import('../lib/retry.js')
const { makeRoutes, API_PREFIX } = await import('../lib/routes.js')
const { buildTools } = await import('../lib/tools.js')
const { load } = await import('../lib/ledger.js')

function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-retry-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

function makeBatch(id, tickets, overrides = {}) {
  return {
    id,
    title: '重试测试 ' + id,
    createdAt: Date.now(),
    status: 'approved',
    revision: 0,
    decisions: [],
    questions: [],
    risks: [],
    tickets,
    parentSessionId: 'session-parent',
    cwd: 'C:/tmp',
    ...overrides,
  }
}

function ticket(id, status, overrides = {}) {
  return {
    id,
    title: id + ' 标题',
    brief: id + ' 的任务书',
    blockedBy: [],
    riskIds: [],
    riskFree: true,
    riskFreeReason: '测试夹具',
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    modelReason: '测试',
    status,
    childSessionId: 'child-' + id,
    ...overrides,
  }
}

function writeFixture(batch) {
  writeFileSync(join(process.env.WT_HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2) + '\n')
  return batch
}

function pathOf(batch) {
  return join(process.env.WT_HOME, 'designs', batch.id + '.json')
}

function fakeDispatcher(options = {}) {
  const runCalls = []
  const spawnCalls = []
  return {
    runCalls,
    spawnCalls,
    async spawn(worker) {
      spawnCalls.push(worker.id)
      return { sessionId: 'child-' + worker.id, model: { provider: 'p', model: 'm' } }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
      if (options.failRun === true) throw new Error('送不进去')
    },
    async tail() { return [] },
  }
}

function facesWith(dispatcher) {
  return { dispatcher, warn: () => {}, testFiles: async () => [] }
}

async function callRoute(faces, path, body) {
  const route = makeRoutes(faces).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, '找不到路由 ' + path)
  const req = {
    url: path,
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:53827' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  }
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk !== undefined) raw += String(chunk) },
  }
  await route.handler(req, res)
  return { status, body: raw === '' ? undefined : JSON.parse(raw) }
}

// ── 策略（纯函数） ───────────────────────────────────────────────

test('策略：复核族不设上限（10 次后仍允许）', () => {
  const row = ticket('T-1', 'needs_review', {
    report: { code: 'NEEDS_REVIEW', status: 'needs_review' },
    leadRetries: { code: 'NEEDS_REVIEW', used: 10 },
  })
  const plan = core.planLeadRetry(row)
  assert.equal(plan.allowed, true)
  assert.equal(plan.family, 'review')
  assert.equal(plan.limit, null)
})

test('策略：报错族 5 次用尽后拒绝（retry-exhausted），换错误码重新计', () => {
  const busy = ticket('T-1', 'failed', {
    report: { code: 'NETWORK_FAILED', status: 'failed' },
    leadRetries: { code: 'NETWORK_FAILED', used: 5 },
  })
  const plan = core.planLeadRetry(busy)
  assert.equal(plan.allowed, false)
  assert.equal(plan.refusalCode, 'retry-exhausted')
  assert.equal(core.LEAD_ERROR_RETRY_LIMIT, 5)

  const otherCode = core.planLeadRetry({
    ...busy,
    report: { code: 'ACCOUNT_QUOTA', status: 'failed' },
  })
  assert.equal(otherCode.allowed, true, '换了错误码 = 换了问题，从新额度开始')
  assert.equal(otherCode.used, 0)
})

test('策略：启动失败按 LAUNCH_FAILED 记报错族，同一 code 5 次用尽后拒绝', () => {
  const busy = ticket('T-1', 'queued', {
    childSessionId: undefined,
    launchFailureCode: 'LAUNCH_FAILED',
    launchError: '起不来',
    leadRetries: { code: 'LAUNCH_FAILED', used: 5 },
  })
  const plan = core.planLeadRetry(busy)
  assert.equal(plan.allowed, false)
  assert.equal(plan.family, 'error')
  assert.equal(plan.code, 'LAUNCH_FAILED')
  assert.equal(plan.refusalCode, 'retry-exhausted')
})

test('策略：模型不能重试 running / waiting / suspended / done / 用户叫停的票', () => {
  for (const status of ['running', 'waiting', 'suspended', 'done', 'user_interrupted', 'cancelled']) {
    const plan = core.planLeadRetry(ticket('T-1', status))
    assert.equal(plan.allowed, false, status)
  }
  // lead 自己取消的票可以重试（那是它自己的决定）。
  assert.equal(core.planLeadRetry(ticket('T-1', 'lead_interrupted')).allowed, true)
})

test('策略：用户侧只挡「正在跑」和「正在等自己回答」，done 要求走重跑', () => {
  assert.equal(core.planUserRetry(ticket('T-1', 'failed')).allowed, true)
  assert.equal(core.planUserRetry(ticket('T-1', 'running')).allowed, false)
  assert.equal(core.planUserRetry(ticket('T-1', 'waiting')).allowed, false)
  assert.equal(core.planUserRetry(ticket('T-1', 'done')).allowed, false)
})

// ── 机制：终态票重跑 ─────────────────────────────────────────────

test('重跑终态票：重发任务书、清上一轮字段、记账并消耗额度', async () => {
  freshHome('rerun')
  const batch = writeFixture(makeBatch('D-RETRY-RERUN', [
    ticket('T-1', 'failed', {
      report: { turn: 1, status: 'failed', code: 'NETWORK_FAILED', text: '上一轮正文' },
      finishedAt: 1,
      interruptedBy: 'lead',
      transportGrace: { at: 1, turn: 1 },
      leadRetries: { code: 'NETWORK_FAILED', used: 2 },
    }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await retryTicket(facesWith(dispatcher), {
    batchId: batch.id, ticketId: 'T-1', by: 'lead', reason: '网络恢复后重跑',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'running')
  assert.equal(result.retry.family, 'error')
  assert.equal(result.retry.remaining, 2, '5 次额度，之前用了 2，这次用完还剩 2')
  assert.equal(dispatcher.runCalls.length, 1)
  assert.match(dispatcher.runCalls[0].text, /T-1 的任务书/)

  const after = await load(batch.id)
  const row = after.tickets[0]
  assert.equal(row.status, 'running')
  assert.equal(row.report, undefined)
  assert.equal(row.finishedAt, undefined)
  assert.equal(row.transportGrace, undefined)
  assert.equal(row.interruptedBy, undefined)
  assert.equal(row.rerunFrom, 'failed')
  assert.equal(row.leadRetries.used, 3)
  assert.equal(row.retries.at(-1).by, 'lead')
  assert.equal(row.retries.at(-1).mode, 'rerun')
  assert.equal(row.retries.at(-1).reason, '网络恢复后重跑')
})

test('重跑耗尽额度：拒绝、不写台账、不给子会话发消息', async () => {
  freshHome('exhausted')
  const batch = writeFixture(makeBatch('D-RETRY-EXHAUSTED', [
    ticket('T-1', 'failed', {
      report: { code: 'NETWORK_FAILED', status: 'failed' },
      leadRetries: { code: 'NETWORK_FAILED', used: 5 },
    }),
  ]))
  const before = readFileSync(pathOf(batch), 'utf8')
  const dispatcher = fakeDispatcher()

  const result = await retryTicket(facesWith(dispatcher), { batchId: batch.id, ticketId: 'T-1', by: 'lead' })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'retry-exhausted')
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal(readFileSync(pathOf(batch), 'utf8'), before)
})

test('用户重试把主会话额度还回去', async () => {
  freshHome('user-reset')
  const batch = writeFixture(makeBatch('D-RETRY-USER', [
    ticket('T-1', 'failed', {
      report: { code: 'NETWORK_FAILED', status: 'failed' },
      leadRetries: { code: 'NETWORK_FAILED', used: 5 },
    }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await retryTicket(facesWith(dispatcher), { batchId: batch.id, ticketId: 'T-1', by: 'user' })
  assert.equal(result.ok, true)

  const after = await load(batch.id)
  assert.equal(after.tickets[0].leadRetries, undefined)
  assert.equal(after.tickets[0].retries.at(-1).by, 'user')
})

// ── 机制：启动失败（I-04 的出口） ───────────────────────────────

test('启动失败后重试：清 launchError 并按依赖求值重新启动，成功后清记账码', async () => {
  freshHome('launch')
  // 没有子会话（上次 spawn 就失败了），正是 /run 会 409 launch-retry-required 的形态。
  const batch = writeFixture(makeBatch('D-RETRY-LAUNCH', [
    ticket('T-1', 'queued', {
      childSessionId: undefined,
      launchFailureCode: 'LAUNCH_FAILED',
      launchError: 'reasoningEffort: medium 不被 deepseek-flash 支持',
      startedAt: undefined,
    }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await retryTicket(facesWith(dispatcher), { batchId: batch.id, ticketId: 'T-1', by: 'lead' })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'running')
  assert.equal(result.retry.family, 'error', '启动失败算报错族，消耗次数')
  assert.equal(result.retry.code, 'LAUNCH_FAILED')
  assert.equal(dispatcher.spawnCalls.length, 1)
  assert.equal(dispatcher.runCalls.length, 1)

  const after = await load(batch.id)
  const row = after.tickets[0]
  assert.equal(row.status, 'running')
  assert.equal(row.launchError, undefined)
  assert.equal(row.launchFailureCode, undefined)
  assert.equal(row.retries.at(-1).mode, 'launch')
})

test('批次还没批准时拒绝重试（批准时会自动开跑）', async () => {
  freshHome('grilling')
  const batch = writeFixture(makeBatch('D-RETRY-GRILL', [ticket('T-1', 'draft')], { status: 'converged' }))
  const dispatcher = fakeDispatcher()
  const result = await retryTicket(facesWith(dispatcher), { batchId: batch.id, ticketId: 'T-1', by: 'lead' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'batch-not-approved')
  assert.equal(dispatcher.runCalls.length, 0)
})

// ── 两个入口 ────────────────────────────────────────────────────

test('POST /retry：用户点重试能把卡住的 queued 票拉起来', async () => {
  freshHome('route')
  const batch = writeFixture(makeBatch('D-RETRY-ROUTE', [
    ticket('T-1', 'queued', { childSessionId: undefined, launchFailureCode: 'LAUNCH_FAILED', launchError: '起不来' }),
  ]))
  const dispatcher = fakeDispatcher()
  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/retry', {
    batchId: batch.id, ticketId: 'T-1',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.status, 'running')
})

test('POST /retry：正在跑的票拒绝（409），不产生副作用', async () => {
  freshHome('route-running')
  const batch = writeFixture(makeBatch('D-RETRY-RUNNING', [ticket('T-1', 'running')]))
  const before = readFileSync(pathOf(batch), 'utf8')
  const dispatcher = fakeDispatcher()
  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/retry', {
    batchId: batch.id, ticketId: 'T-1',
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'retry-not-allowed')
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal(readFileSync(pathOf(batch), 'utf8'), before)
})

test('/run 对「启动失败过、没有子会话」的 queued 票给 launch-retry-required，而不是误导的 not-dispatched', async () => {
  freshHome('run-launch-failed')
  const batch = writeFixture(makeBatch('D-RETRY-RUN-HINT', [
    ticket('T-1', 'queued', { childSessionId: undefined, launchFailureCode: 'LAUNCH_FAILED', launchError: '起不来' }),
  ]))
  const dispatcher = fakeDispatcher()
  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: batch.id, ticketId: 'T-1',
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'launch-retry-required')
  assert.match(result.body.error, /重试启动/)
  assert.equal(dispatcher.runCalls.length, 0)
})

test('middleman_retry：子会话调用被拒（它只该把失败写进回执）', async () => {
  freshHome('tool-child')
  const batch = writeFixture(makeBatch('D-RETRY-TOOL', [ticket('T-1', 'failed')]))
  const dispatcher = fakeDispatcher()
  const tools = buildTools({
    dispatcher,
    warn: () => {},
    testFiles: async () => [],
    confirmations: {
      find: async (sessionId) => (sessionId === 'child-T-1'
        ? { batch, ticket: batch.tickets[0] }
        : undefined),
    },
  })
  const tool = tools.find((candidate) => candidate.name === 'middleman_retry')
  const result = await tool.execute(
    { batchId: batch.id, ticketId: 'T-1' },
    { agent: { session: { id: 'child-T-1' } } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-a-lead')
  assert.equal(dispatcher.runCalls.length, 0)
})

test('重试可以换任务书（重设计）：新 brief 写进台账，重发的也是新那份', async () => {
  freshHome('brief')
  const batch = writeFixture(makeBatch('D-RETRY-BRIEF', [
    ticket('T-1', 'needs_review', { report: { code: 'NEEDS_REVIEW', status: 'needs_review' } }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await retryTicket(facesWith(dispatcher), {
    batchId: batch.id,
    ticketId: 'T-1',
    by: 'lead',
    brief: '换一条路：先写测试再改实现，改完跑 test/p0.test.mjs',
    reason: '原任务书没说清验收口径',
  })
  assert.equal(result.ok, true)
  assert.equal(dispatcher.runCalls.length, 1)
  assert.match(dispatcher.runCalls[0].text, /换一条路/)

  const after = await load(batch.id)
  const row = after.tickets[0]
  assert.match(row.brief, /换一条路/)
  assert.equal(row.retries.at(-1).briefChanged, true)
})

test('middleman_retry：主会话调用成功，返回剩余额度', async () => {
  freshHome('tool-lead')
  const batch = writeFixture(makeBatch('D-RETRY-TOOL-LEAD', [
    ticket('T-1', 'needs_review', { report: { code: 'NEEDS_REVIEW', status: 'needs_review' } }),
  ]))
  const dispatcher = fakeDispatcher()
  const tools = buildTools({
    dispatcher,
    warn: () => {},
    testFiles: async () => [],
    confirmations: { find: async () => undefined },
  })
  const tool = tools.find((candidate) => candidate.name === 'middleman_retry')
  const result = await tool.execute(
    { batchId: batch.id, ticketId: 'T-1', reason: '补一下验收' },
    { agent: { session: { id: 'session-lead' } } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.retry.family, 'review')
  assert.equal(dispatcher.runCalls.length, 1)
})
