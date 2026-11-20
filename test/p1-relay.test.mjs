/**
 * T-3 回归：依赖票自动启动是**依赖表求值**，不是「上一级呼叫下一级」。
 *
 * 跑：<runtime node> test/p1-relay.test.mjs
 *
 * 为什么不用 `node --test`：沙箱下测试运行器会给每个文件起子进程，本机
 * 复现过 EPERM。直接执行这个文件，node:test 照样会把测试跑完，失败时
 * 退出码同样非 0。
 *
 * 所有 dispatcher 都是假的：绝不真的建会话、绝不真的给子会话发消息。
 * 主会话（parentSessionId）在测试里是 'session-parent'，任何发给它的
 * run 调用都能被单独数出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 台账之前指到临时目录，否则会写到 ~/.dsh 下的真台账。
// 每个测试再切一份新的 HOME：启动对账会扫全部批次，混在一起会互相干扰。
const FIRST_HOME = mkdtempSync(join(tmpdir(), 'wt-relay-'))
process.env.WT_HOME = FIRST_HOME
mkdirSync(join(FIRST_HOME, 'designs'), { recursive: true })

const {
  evaluateBatch, isSatisfiedStatus, isTerminalStatus, readyTickets,
  transportGraceAction,
} = await import('../lib/core.js')
const { load, save } = await import('../lib/ledger.js')
const { installObserver, relayBatch, deliverEnvelope } = await import('../lib/observer.js')
const { buildBrief } = await import('../lib/dispatch.js')
const { makeRoutes, API_PREFIX } = await import('../lib/routes.js')

/** 切一份干净的台账目录。测试之间互不看见对方的批次。 */
function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-relay-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

/** 一张票：默认草稿以外的字段都给齐，方便直接塞进台账。 */
function ticket(id, status, overrides = {}) {
  return {
    id,
    title: id + ' 标题',
    brief: id + ' 任务书',
    riskIds: ['R-1'],
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    modelReason: '因为',
    blockedBy: [],
    status,
    ...overrides,
  }
}

/** 一个已批准的批次：依赖求值只在这种批次上有意义。 */
function makeBatch(id, tickets, overrides = {}) {
  return {
    id,
    title: 'T-3 测试批次',
    createdAt: Date.now(),
    status: 'approved',
    revision: 0,
    decisions: [{ id: 'D1', kind: 'goal', title: '目标', answer: '做' }],
    questions: [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
      { question: 'q3', answer: 'a3' },
    ],
    risks: [{
      id: 'R-1',
      title: '会失败',
      trigger: '当 X 时',
      impact: '结果不对',
      mitigation: '写 Y 兜住',
      verification: '人工核对：跑一遍',
    }],
    plan: { steps: '1. 做', output: '东西' },
    spec: { goal: '让依赖票自动启动', nonGoals: [], acceptance: ['能跑起来'] },
    parentSessionId: 'session-parent',
    tickets,
    ...overrides,
  }
}

function writeBatch(batch) {
  writeFileSync(
    join(process.env.WT_HOME, 'designs', batch.id + '.json'),
    JSON.stringify(batch, null, 2) + '\n',
  )
}

/** 假 dispatcher：只记调用，绝不建会话。 */
function fakeDispatcher(options = {}) {
  const spawnCalls = []
  const runCalls = []
  const failSpawnFor = new Set(options.failSpawnFor ?? [])
  return {
    spawnCalls,
    runCalls,
    async spawn(worker, spawnOptions) {
      spawnCalls.push({ ticketId: worker.id, options: spawnOptions })
      if (failSpawnFor.has(worker.id)) throw new Error('起不来：' + worker.id)
      return {
        sessionId: 'child-' + worker.id,
        // 宿主会规范化模型：回读值才是子会话真正跑的。
        model: { provider: 'p', model: 'm-effective', reasoningEffort: 'high' },
      }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
    },
    async tail() {
      // 2026-11-18 起 completed 必须配回执（自评 + 最终汇报）。默认不给回执——
      // 测试要表现的「结算成 done」必须显式说明子会话交过回执，不能让假数据替它圆谎。
      return options.doneReceipt === true
        ? [{
          type: 'tool/call',
          data: {
            name: 'middleman_report_done',
            turn: options.receiptTurn ?? 1,
            arguments: JSON.stringify({ outcome: 'done', report: '做完了，验证通过。' }),
          },
        }]
        : []
    },
  }
}

function facesWith(dispatcher) {
  return { dispatcher, warn: () => {}, testFiles: async () => [] }
}

/** 直接改一张票的状态，模拟「结算已经写进台账」。 */
async function setStatus(batchId, ticketId, status) {
  const batch = await load(batchId)
  const target = batch.tickets.find((candidate) => candidate.id === ticketId)
  assert.ok(target !== undefined, '找不到票 ' + ticketId)
  target.status = status
  await save(batch, { expectedRevision: batch.revision })
}

/** 等一个异步条件成立；超时抛错，不让测试挂死。 */
async function waitFor(check, timeoutMs = 3000) {  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 简单的等待。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 走真正的路由 handler，造一个最小 req/res。 */
async function callRoute(faces, path, body) {
  const route = makeRoutes(faces).find((candidate) => candidate.path === path && candidate.kind === 'exact')
  assert.ok(route !== undefined, '找不到路由 ' + path)
  const req = {
    url: path,
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:53827' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    },
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

test('isSatisfiedStatus：只认 done；partial/needs_review/no_receipt/failed 一律不解锁后继', () => {
  assert.equal(isSatisfiedStatus('done'), true)
  // 2026-11-18 收紧：partial 不再自动接力——产出可能不完整，交给主会话
  // 读完正文决定（rewire 放行 / 重跑 / 交给用户）。
  for (const status of [
    'partial', 'needs_review', 'no_receipt', 'receipt_unverified',
    'failed', 'cancelled', 'interrupted',
    'running', 'waiting', 'queued', 'pending', 'draft', undefined,
  ]) {
    assert.equal(isSatisfiedStatus(status), false, String(status) + ' 不该满足依赖')
  }
  // isTerminalStatus 保留原义：失败/取消是终态，但不满足。
  assert.equal(isTerminalStatus('failed'), true)
  assert.equal(isTerminalStatus('user_interrupted'), true)
  assert.equal(isTerminalStatus('lead_interrupted'), true)
  assert.equal(isTerminalStatus('cancelled'), true)
  assert.equal(isTerminalStatus('partial'), true)
  // interrupted 在宽限期到点、DSH 也救不回来之后结算：不会再自己动，算终态。
  assert.equal(isTerminalStatus('interrupted'), true)
  assert.equal(isTerminalStatus('running'), false)
})

test('readyTickets：只有 done 算就绪；partial/failed/cancelled 都挡后继（/state.ready 口径）', () => {
  const batch = makeBatch('D-READY', [
    ticket('A', 'done'),
    ticket('B', 'failed'),
    ticket('C', 'partial'),
    ticket('E', 'cancelled'),
    ticket('X', 'pending', { blockedBy: ['A'] }),
    ticket('Y', 'pending', { blockedBy: ['B'] }),
    ticket('Z', 'pending', { blockedBy: ['C'] }),
    ticket('W', 'pending', { blockedBy: ['E'] }),
    ticket('OLD', undefined, { blockedBy: ['A'] }),
  ])
  assert.deepEqual(
    readyTickets(batch).map((row) => row.id).sort(),
    ['OLD', 'X'],
  )
})

test('evaluateBatch：纯函数，不就地写台账；带 launchError 的票不进 startable', () => {
  const batch = makeBatch('D-EVAL', [
    ticket('A', 'done'),
    ticket('B', 'queued', { blockedBy: ['A'], launchError: '起不来', launchFailureCode: 'LAUNCH_FAILED' }),
    ticket('C', 'queued', { blockedBy: ['A'] }),
    ticket('D', 'running', { blockedBy: ['A'] }),
  ])
  const result = evaluateBatch(batch, 12345)

  assert.equal(result.evaluatedAt, 12345)
  assert.deepEqual(result.startable, ['C'])
  assert.equal(result.blockedStates.B.evaluatedAt, 12345)
  // 依赖是满足的，只是启动失败过、等显式重试——面板要能看出这个区别。
  assert.equal(result.blockedStates.B.allSatisfied, true)
  assert.equal(result.blockedStates.D, undefined)
  // 纯函数：计算结果不往输入对象里塞 blockedState。
  assert.equal(batch.tickets[1].blockedState, undefined)
})

test('ledger.save：并发写同一个 expectedRevision，只有一次成功（CAS 是原子的）', async () => {
  freshHome('cas')
  const batch = makeBatch('D-LEDGER-CAS', [ticket('T-1', 'done')])
  writeBatch(batch)

  const first = await load(batch.id)
  const second = await load(batch.id)
  first.title = 'A'
  second.title = 'B'
  const results = await Promise.allSettled([
    save(first, { expectedRevision: batch.revision }),
    save(second, { expectedRevision: batch.revision }),
  ])

  const fulfilled = results.filter((row) => row.status === 'fulfilled')
  const rejected = results.filter((row) => row.status === 'rejected')
  assert.equal(fulfilled.length, 1, '只该有一个写成功')
  assert.equal(rejected.length, 1, '另一个必须拿到 revision-conflict')
  assert.equal(rejected[0].reason.code, 'revision-conflict')

  const after = await load(batch.id)
  assert.equal(after.revision, batch.revision + 1)
  assert.ok(after.title === 'A' || after.title === 'B')
})

test('单前序 done 后：queued 后继没有会话，由求值补 spawn 并启动', async () => {
  freshHome('done')
  const batch = makeBatch('D-RELAY-DONE', [
    ticket('T-1', 'done'),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const result = await relayBatch(facesWith(dispatcher), batch.id)

  assert.deepEqual(result.started, ['T-2'])
  assert.deepEqual(result.failed, [])
  // /approve 只给已就绪的票建会话；被挡的票没有 childSessionId，求值要自己 spawn。
  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId), ['T-2'])
  assert.deepEqual(dispatcher.runCalls.map((row) => row.sessionId), ['child-T-2'])
  assert.doesNotMatch(dispatcher.runCalls[0].text, /T-1|blockedBy|前置/)

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(target.status, 'running')
  assert.equal(target.childSessionId, 'child-T-2')
  assert.equal(target.launchError, undefined)
  assert.equal(target.launchFailureCode, undefined)
  // 成功启动后清掉 blockedState。
  assert.equal(target.blockedState, undefined)
})

test('前序 failed 时：后继不启动、仍 queued、且没有向任何人发消息', async () => {
  freshHome('failed')
  const batch = makeBatch('D-RELAY-FAILED', [
    ticket('T-1', 'failed', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const result = await relayBatch(facesWith(dispatcher), batch.id)

  assert.deepEqual(result.started, [])
  assert.deepEqual(result.failed, [])
  assert.equal(dispatcher.spawnCalls.length, 0)
  // 关键：连主会话都没有任何消息。被前序失败挡住的票是安静地停在 queued 的。
  assert.equal(dispatcher.runCalls.length, 0)

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(target.status, 'queued')
  assert.equal(target.childSessionId, undefined)
  assert.equal(target.blockedState.allSatisfied, false)
  assert.deepEqual(
    target.blockedState.blockers.map((row) => ({ id: row.id, status: row.status, satisfied: row.satisfied })),
    [{ id: 'T-1', status: 'failed', satisfied: false }],
  )
  assert.equal(typeof target.blockedState.evaluatedAt, 'number')
})

test('blockedState：列出满足与未满足的前序；missing 单独标记', async () => {
  freshHome('blocked')
  const batch = makeBatch('D-RELAY-BLOCKED', [
    ticket('P', 'done'),
    ticket('Q', 'partial'),
    ticket('R', 'failed'),
    ticket('T', 'queued', { blockedBy: ['P', 'Q', 'R'] }),
    ticket('M', 'queued', { blockedBy: ['GONE'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const result = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(result.started, [])
  assert.equal(dispatcher.spawnCalls.length, 0)

  const after = await load(batch.id)
  const blockedTicket = after.tickets.find((row) => row.id === 'T')
  assert.equal(blockedTicket.status, 'queued')
  assert.equal(blockedTicket.blockedState.allSatisfied, false)
  assert.deepEqual(
    blockedTicket.blockedState.blockers.map((row) => [row.id, row.status, row.satisfied]),
    [['P', 'done', true], ['Q', 'partial', false], ['R', 'failed', false]],
  )

  const missingTicket = after.tickets.find((row) => row.id === 'M')
  assert.equal(missingTicket.blockedState.allSatisfied, false)
  assert.deepEqual(
    missingTicket.blockedState.blockers.map((row) => [row.id, row.status, row.satisfied, row.missing]),
    [['GONE', 'missing', false, true]],
  )
  assert.equal(missingTicket.blockedState.blockers[0].title, '(不存在的工单)')
})

test('多前序：部分满足不动，全部满足才启动（AND）', async () => {
  freshHome('and')
  const batch = makeBatch('D-RELAY-AND', [
    ticket('P', 'done'),
    ticket('Q', 'running', { childSessionId: 'child-Q' }),
    ticket('T', 'queued', { blockedBy: ['P', 'Q'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const first = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(first.started, [])
  let after = await load(batch.id)
  let target = after.tickets.find((row) => row.id === 'T')
  assert.equal(target.status, 'queued')
  assert.equal(target.blockedState.allSatisfied, false)
  assert.deepEqual(
    target.blockedState.blockers.map((row) => [row.id, row.satisfied]),
    [['P', true], ['Q', false]],
  )

  await setStatus(batch.id, 'Q', 'done')
  const second = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(second.started, ['T'])
  after = await load(batch.id)
  target = after.tickets.find((row) => row.id === 'T')
  assert.equal(target.status, 'running')
  assert.equal(target.childSessionId, 'child-T')
})

test('多后继：一个前序满足后，所有可启动的后继都启动（fan-out）', async () => {
  freshHome('fanout')
  const batch = makeBatch('D-RELAY-FANOUT', [
    ticket('A', 'done'),
    ticket('B', 'queued', { blockedBy: ['A'] }),
    ticket('C', 'queued', { blockedBy: ['A'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const result = await relayBatch(facesWith(dispatcher), batch.id)

  assert.deepEqual(result.started.sort(), ['B', 'C'])
  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId).sort(), ['B', 'C'])
  assert.deepEqual(dispatcher.runCalls.map((row) => row.sessionId).sort(), ['child-B', 'child-C'])

  const after = await load(batch.id)
  assert.deepEqual(after.tickets.map((row) => row.status), ['done', 'running', 'running'])
})

test('菱形：D 要等 B、C 都满足才启动', async () => {
  freshHome('diamond')
  const batch = makeBatch('D-RELAY-DIAMOND', [
    ticket('A', 'done'),
    ticket('B', 'queued', { blockedBy: ['A'] }),
    ticket('C', 'queued', { blockedBy: ['A'] }),
    ticket('D', 'queued', { blockedBy: ['B', 'C'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const first = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(first.started.sort(), ['B', 'C'])
  let after = await load(batch.id)
  let d = after.tickets.find((row) => row.id === 'D')
  assert.equal(d.status, 'queued')
  assert.equal(d.blockedState.allSatisfied, false)

  // 只结算 B：D 仍然要等 C。
  await setStatus(batch.id, 'B', 'done')
  const second = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(second.started, [])
  after = await load(batch.id)
  d = after.tickets.find((row) => row.id === 'D')
  assert.equal(d.status, 'queued')
  assert.deepEqual(
    d.blockedState.blockers.map((row) => [row.id, row.satisfied]),
    [['B', true], ['C', false]],
  )

  // B、C 都满足了，D 才启动。
  await setStatus(batch.id, 'C', 'done')
  const third = await relayBatch(facesWith(dispatcher), batch.id)
  assert.deepEqual(third.started, ['D'])
  after = await load(batch.id)
  d = after.tickets.find((row) => row.id === 'D')
  assert.equal(d.status, 'running')
  assert.equal(d.childSessionId, 'child-D')
  assert.equal(dispatcher.spawnCalls.filter((row) => row.ticketId === 'D').length, 1)
})

test('并发双触发：同一张后继只启动一次（先占位再启动）', async () => {
  freshHome('race')
  const batch = makeBatch('D-RELAY-RACE', [
    ticket('A', 'done'),
    ticket('B', 'queued', { blockedBy: ['A'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const faces = facesWith(dispatcher)
  // 两个「前序几乎同时结算」的调用：都看到 B 可启动，但只有一个能抢到。
  const [first, second] = await Promise.all([
    relayBatch(faces, batch.id),
    relayBatch(faces, batch.id),
  ])

  assert.equal(
    dispatcher.spawnCalls.filter((row) => row.ticketId === 'B').length,
    1,
    'B 只该被 spawn 一次',
  )
  assert.equal(
    dispatcher.runCalls.filter((row) => row.sessionId === 'child-B').length,
    1,
    'B 只该被 run 一次',
  )
  assert.equal([...first.started, ...second.started].filter((id) => id === 'B').length, 1)

  const after = await load(batch.id)
  assert.equal(after.tickets.find((row) => row.id === 'B').status, 'running')
})

test('启动失败隔离：失败的票回 queued + launchError，其它票照常启动；不自动重试', async () => {
  freshHome('launch-fail')
  const batch = makeBatch('D-RELAY-LAUNCH-FAIL', [
    ticket('A', 'done'),
    ticket('B', 'queued', { blockedBy: ['A'] }),
    ticket('C', 'queued', { blockedBy: ['A'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ failSpawnFor: ['B'] })
  const faces = facesWith(dispatcher)

  const first = await relayBatch(faces, batch.id)
  assert.deepEqual(first.failed.map((row) => row.ticketId), ['B'])
  // B 失败不能连累 C：同一轮里 C 仍然启动。
  assert.deepEqual(first.started, ['C'])
  assert.deepEqual(dispatcher.runCalls.filter((row) => row.sessionId === 'child-C').length, 1)

  let after = await load(batch.id)
  let b = after.tickets.find((row) => row.id === 'B')
  assert.equal(b.status, 'queued')
  assert.match(b.launchError, /起不来：B/)
  assert.equal(b.launchFailureCode, 'LAUNCH_FAILED')
  assert.equal(b.blockedState.allSatisfied, true)

  // 启动失败立刻给主会话报一条信封；不靠 outbox 反复重试。
  const toParent = dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent')
  assert.equal(toParent.length, 1)
  assert.match(toParent[0].text, /\[启动失败\] B/)

  // 再求值一次：带 launchError 的票不进 startable，不会自动重试。
  const second = await relayBatch(faces, batch.id)
  assert.deepEqual(second.failed, [])
  after = await load(batch.id)
  b = after.tickets.find((row) => row.id === 'B')
  assert.equal(b.status, 'queued')
  assert.match(b.launchError, /起不来：B/)
  assert.equal(dispatcher.spawnCalls.filter((row) => row.ticketId === 'B').length, 1)
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 1)
})

test('buildBrief：不把依赖表写进子会话上下文，但必须写清收尾回执要求', () => {
  const text = buildBrief(
    { risks: [], spec: { acceptance: [] } },
    { id: 'T-2', title: '验证', brief: '做验证', blockedBy: ['T-1'] },
  )
  assert.match(text, /做验证/)
  assert.doesNotMatch(text, /T-1|blockedBy|前置/)
  // 回执要求在任务书里：模型不知道这条规矩就不会调，结算就会判 NO_RECEIPT。
  assert.match(text, /middleman_report_done/)
})

test('结算路径：turn/end 结算后触发求值，后继自动启动；不额外给主会话发消息', async () => {
  freshHome('settle')
  const batch = makeBatch('D-RELAY-SETTLE', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ], { parentSessionId: undefined })
  writeBatch(batch)

  // 子会话这一轮交过完成回执：completed + 回执才算 done。
  const dispatcher = fakeDispatcher({ doneReceipt: true })
  const handlers = {}
  const ctx = {
    on(name, handler) {
      handlers[name] = handler
      return () => {}
    },
  }
  const uninstall = installObserver(ctx, facesWith(dispatcher))

  // 给启动对账一点时间跑完，再手工触发 turn/end（只结算 T-1，不启动 T-2）。
  await new Promise((resolve) => setTimeout(resolve, 100))
  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const settled = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(settled.status, 'done')
  assert.equal(settled.report.receipt, 'yes')
  const successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'running')
  assert.equal(successor.childSessionId, 'child-T-2')
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 0)
})

test('/approve → 结算 → 后继启动：批完就写 blockedState，前序 done 后自动接力', async () => {
  freshHome('approve-settle')
  const batch = makeBatch('D-RELAY-APPROVE-SETTLE', [
    ticket('T-1', 'draft'),
    ticket('T-2', 'draft', { blockedBy: ['T-1'] }),
  ], { status: 'converged', parentSessionId: undefined })
  writeBatch(batch)

  // 子会话这一轮交过完成回执：completed + 回执才算 done。
  const dispatcher = fakeDispatcher({ doneReceipt: true })
  const faces = facesWith(dispatcher)

  const approved = await callRoute(faces, API_PREFIX + '/approve', {
    batchId: batch.id,
    expectedRevision: batch.revision,
  })
  assert.equal(approved.status, 200)
  assert.deepEqual(approved.body.launched, ['T-1'])
  assert.deepEqual(approved.body.queued, ['T-2'])

  let after = await load(batch.id)
  let successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'queued')
  // 批准那一刻的求值就该把「卡在谁身上」写下来，而不是等第一次结算。
  assert.equal(successor.blockedState.allSatisfied, false)
  assert.deepEqual(
    successor.blockedState.blockers.map((row) => [row.id, row.status, row.satisfied]),
    [['T-1', 'running', false]],
  )

  // 观察器在批准之后装：索引里要有 child-T-1，turn/end 才认得出是谁。
  const handlers = {}
  const ctx = {
    on(name, handler) {
      handlers[name] = handler
      return () => {}
    },
  }
  const uninstall = installObserver(ctx, faces)
  await new Promise((resolve) => setTimeout(resolve, 100))

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  after = await load(batch.id)
  assert.equal(after.tickets.find((row) => row.id === 'T-1').status, 'done')
  assert.equal(after.tickets.find((row) => row.id === 'T-1').report.receipt, 'yes')
  successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'running')
  assert.equal(successor.childSessionId, 'child-T-2')
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 0)
})

test('重启恢复：apply 时对全部批次重放求值，补启动已满足依赖的 queued 票', async () => {  freshHome('restart')
  const batch = makeBatch('D-RELAY-RESTART', [
    ticket('T-1', 'done'),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const ctx = { on() { return () => {} } }
  const uninstall = installObserver(ctx, facesWith(dispatcher))

  await waitFor(async () => {
    const after = await load(batch.id)
    const target = after.tickets.find((row) => row.id === 'T-2')
    return target.status === 'running' && target.childSessionId === 'child-T-2'
  })
  // 让 relayBatch 把最后几笔写台账的动作收尾，再切到下一个 HOME。
  await new Promise((resolve) => setTimeout(resolve, 50))
  uninstall()

  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId), ['T-2'])
  assert.deepEqual(dispatcher.runCalls.map((row) => row.sessionId), ['child-T-2'])
})

test('transportGraceAction：宽限期内有活动就撤销，到点才报 expired', () => {
  const grace = { at: 1000, turn: 1 }
  assert.equal(transportGraceAction(grace, { now: 2000, lastEventTime: 900, lastTurnEndTurn: 1 }), 'wait')
  assert.equal(transportGraceAction(grace, { now: 2000, lastEventTime: 1500 }), 'activity')
  assert.equal(transportGraceAction(grace, { now: 2000, lastTurnEndTurn: 2 }), 'activity')
  assert.equal(transportGraceAction(grace, { now: 61_000 }), 'expired')
  assert.equal(transportGraceAction(undefined, { now: 1 }), 'none')
})

test('TRANSPORT：先挂 60 秒宽限、不向主会话报错；新一轮 turn/start 撤销宽限', async () => {
  freshHome('transport-grace')
  const batch = makeBatch('D-TRANSPORT-GRACE', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const handlers = {}
  const ctx = { on(name, handler) { handlers[name] = handler; return () => {} } }
  const uninstall = installObserver(ctx, facesWith(dispatcher))
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'stream reset' } } } },
  )

  let after = await load(batch.id)
  let target = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(target.status, 'running', '宽限期内票还是 running，不结算')
  assert.equal(target.transportGrace.turn, 1)
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 0, '宽限期内不报错')

  await handlers['session/event']({ id: 'child-T-1' }, { type: 'turn/start', data: { turn: 2 } })
  uninstall()

  after = await load(batch.id)
  target = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(target.transportGrace, undefined, 'DSH 续跑生效后宽限要撤销')
})

test('重启对账：静默结算一次，不推信封', async () => {
  freshHome('quiet-reconcile')
  const batch = makeBatch('D-QUIET-RECONCILE', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  dispatcher.tail = async () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做了一半。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const uninstall = installObserver({ on() { return () => {} } }, facesWith(dispatcher))
  await sleep(150)
  uninstall()

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(target.status, 'no_receipt', 'completed 没回执 → NO_RECEIPT')
  assert.equal(target.report.deliverySuppressed, 'restart')
  assert.equal(target.report.deliveredAt, undefined)
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 0, '重启补结算不推信封')
})

test('手动继续：终态票的新一轮 turn/end 仍能结算成 done（终态只表示不会自动再动）', async () => {
  freshHome('manual-resume')
  const batch = makeBatch('D-MANUAL-RESUME', [
    ticket('T-1', 'user_interrupted', {
      childSessionId: 'child-T-1',
      reportedTurn: 1,
      report: { turn: 1, status: 'user_interrupted' },
    }),
  ])
  writeBatch(batch)

  // 用户在子会话对话页里手动继续：新一轮交回执并完成。
  const dispatcher = fakeDispatcher()
  dispatcher.tail = async () => [
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续做完了。' }] } } },
    {
      type: 'tool/call',
      data: {
        turn: 2,
        name: 'middleman_report_done',
        arguments: JSON.stringify({ outcome: 'done', report: '继续做完，验证通过。' }),
      },
    },
  ]
  const handlers = {}
  const ctx = { on(name, handler) { handlers[name] = handler; return () => {} } }
  const uninstall = installObserver(ctx, facesWith(dispatcher))
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(target.status, 'done', '手动继续的完成要能覆盖中断状态')
  assert.equal(target.report.outcome, 'done')
  assert.equal(target.reportedTurn, 2)
})

test('deliverEnvelope：并发/重复投递只推一次（I-02 去重）', async () => {
  freshHome('deliver-dedupe')
  const batch = makeBatch('D-DELIVER-DEDUPE', [
    ticket('T-1', 'failed', {
      report: { turn: 1, status: 'failed', envelopeId: 'T-1:1', text: '出错了', attempts: 0 },
    }),
  ])
  writeBatch(batch)
  const dispatcher = fakeDispatcher()
  const faces = facesWith(dispatcher)

  // settle 的即时投递与 outbox 的兜底重投同时发生：只允许发一条。
  await Promise.all([
    deliverEnvelope(faces, batch.id, 'T-1'),
    deliverEnvelope(faces, batch.id, 'T-1'),
    deliverEnvelope(faces, batch.id, 'T-1'),
  ])
  const toParent = dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent')
  assert.equal(toParent.length, 1, '并发投递只能推一次')

  let after = await load(batch.id)
  let report = after.tickets[0].report
  assert.equal(report.attempts, 1)
  assert.equal(typeof report.deliveredAt, 'number')

  // 已投递之后再调（比如 30 秒后的 outbox）也不会重发。
  await deliverEnvelope(faces, batch.id, 'T-1')
  after = await load(batch.id)
  report = after.tickets[0].report
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 1)
  assert.equal(report.attempts, 1)
})

test('重启后：早于本进程启动的 running 票降级为 suspended，用户可点执行', async () => {
  freshHome('stale-running')
  const batch = makeBatch('D-STALE-RUNNING', [
    // 重启前遗留：最后活动早于本进程启动。
    ticket('T-1', 'running', { childSessionId: 'child-T-1', startedAt: 1, lastEventAt: 1 }),
    // 本进程里刚活动过的票：不能被误伤。
    ticket('T-2', 'running', { childSessionId: 'child-T-2', startedAt: Date.now(), lastEventAt: Date.now() }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  dispatcher.tail = async () => []
  const uninstall = installObserver({ on() { return () => {} } }, facesWith(dispatcher))
  await sleep(150)
  uninstall()

  const after = await load(batch.id)
  const stale = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(stale.status, 'suspended', '重启遗留的 running 要降级，否则 /run 永远 already-running')
  assert.equal(stale.staleReason, 'restart')
  assert.equal(typeof stale.staleAt, 'number')

  const live = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(live.status, 'running', '本进程里活动的票不能被降级')
})
