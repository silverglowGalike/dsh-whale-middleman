/**
 * P1 恢复能力回归：middleman_rewire（改依赖表）与 middleman_rebind（改绑会话）。
 *
 * 跑：<runtime node> test/p1-rewire.test.mjs
 *
 * 为什么不用 `node --test`：沙箱下测试运行器会给每个文件起子进程，本机
 * 复现过 EPERM。直接执行这个文件，node:test 照样把测试跑完，失败时退出码
 * 同样非 0。
 *
 * 所有 dispatcher 都是假的：绝不真的建会话、绝不真的给子会话发消息。
 * 主会话（parentSessionId）在测试里是 'session-parent'，任何发给它的
 * run 调用都能被单独数出来——回传信封会发给它，工具本身不该发。
 *
 * 两条最容易写漏的链路，这里都是端到端验证而不是只查字段：
 * - rewire 改完立刻求值：满足就自动 spawn+run，不满足就安静停着；
 * - rebind 之后新会话的 turn/end 真的能结算到这张票（观察器按
 *   childSessionId 反查），而不只是 childSessionId 写进去了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 台账之前指到临时目录，否则会写到 ~/.dsh 下的真台账。
const FIRST_HOME = mkdtempSync(join(tmpdir(), 'wt-rewire-'))
process.env.WT_HOME = FIRST_HOME
mkdirSync(join(FIRST_HOME, 'designs'), { recursive: true })

const { load } = await import('../lib/ledger.js')
const { installObserver } = await import('../lib/observer.js')
const { buildTools } = await import('../lib/tools.js')

/** 切一份干净的台账目录。测试之间互不看见对方的批次。 */
function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-rewire-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

/** 一张票：字段给齐，方便直接塞进台账。 */
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

/** 一个已批准的批次：依赖求值只在这种批次上会真的开跑。 */
function makeBatch(id, tickets, overrides = {}) {
  return {
    id,
    title: 'P1 rewire 测试批次',
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
    spec: { goal: '让失败变成可恢复的中间态', nonGoals: [], acceptance: ['能跑起来'] },
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

function pathOf(batch) {
  return join(process.env.WT_HOME, 'designs', batch.id + '.json')
}

/** 假 dispatcher：只记调用，绝不建会话、绝不发消息。 */
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
        model: { provider: 'p', model: 'm-effective', reasoningEffort: 'high' },
      }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
    },
    async tail() {
      // 2026-11-18 起 completed 必须配回执：要结算成 done 的测试
      // 必须显式给自评 + 最终汇报，不能靠假 dispatcher 的空白历史替它圆谎。
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

/** 按名字取一个工具；每次用独立的 tool 实例，互不影响。 */
function toolNamed(name, dispatcher) {
  const tool = buildTools(facesWith(dispatcher)).find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, '找不到工具 ' + name)
  return tool
}

/** 装一个观察器并返回事件入口；索引在安装时异步建好。 */
function installForTest(faces) {
  const handlers = {}
  const ctx = {
    on(name, handler) {
      handlers[name] = handler
      return () => {}
    },
  }
  const uninstall = installObserver(ctx, faces)
  return { handlers, uninstall }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('rewire：把失败的前序从依赖里摘掉 → 立刻满足 → 自动启动', async () => {
  freshHome('rewire-start')
  const batch = makeBatch('D-REWIRE-START', [
    ticket('T-1', 'failed', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const tool = toolNamed('middleman_rewire', dispatcher)

  const result = await tool.execute({ batchId: batch.id, ticketId: 'T-2', blockedBy: [] })
  assert.equal(result.ok, true, JSON.stringify(result))
  // 求值结果与启动动作都来自 core.evaluateBatch / relayBatch。
  assert.deepEqual(result.evaluation.startable, ['T-2'])
  assert.deepEqual(result.relay.started, ['T-2'])
  assert.equal(result.batch.status, 'approved')
  assert.equal(result.ticket.status, 'running')

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(target.status, 'running')
  assert.equal(target.childSessionId, 'child-T-2')
  assert.deepEqual(target.blockedBy, [])
  // 审计字段：这次改动从什么改成什么、什么时候改的。
  assert.equal(Array.isArray(target.rewires), true)
  assert.equal(target.rewires.length, 1)
  assert.deepEqual(target.rewires[0].from, ['T-1'])
  assert.deepEqual(target.rewires[0].to, [])
  assert.equal(typeof target.rewires[0].at, 'number')

  // 只启动了这张票。失败的 T-1 没有被联系：工具不向任何子会话发消息。
  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId), ['T-2'])
  assert.deepEqual(dispatcher.runCalls.map((row) => row.sessionId), ['child-T-2'])
  assert.equal(dispatcher.runCalls.some((row) => row.sessionId === 'child-T-1'), false)
  assert.equal(dispatcher.runCalls.some((row) => row.sessionId === 'session-parent'), false)
})

test('rewire：改成不满足 → 求值不启动，票留在 queued 并写下 blockedState', async () => {
  freshHome('rewire-blocked')
  const batch = makeBatch('D-REWIRE-BLOCKED', [
    ticket('T-1', 'failed', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued'),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const tool = toolNamed('middleman_rewire', dispatcher)

  // 原本没有依赖（满足）；加上一个失败的前序后变成不满足。
  const result = await tool.execute({ batchId: batch.id, ticketId: 'T-2', blockedBy: ['T-1'] })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.evaluation.startable, [])
  assert.deepEqual(result.relay.started, [])
  assert.equal(result.ticket.status, 'queued')
  assert.equal(dispatcher.spawnCalls.length, 0, '不满足依赖就不该 spawn')
  assert.equal(dispatcher.runCalls.length, 0, '也不该向任何人发消息')

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(target.status, 'queued')
  assert.deepEqual(target.blockedBy, ['T-1'])
  // 求值把「卡在谁身上」写进了台账，而不是只在返回值里。
  assert.equal(target.blockedState.allSatisfied, false)
  assert.deepEqual(
    target.blockedState.blockers.map((row) => [row.id, row.status, row.satisfied]),
    [['T-1', 'failed', false]],
  )
  assert.deepEqual(target.rewires[0].to, ['T-1'])
})

test('rewire：running/done/failed 拒绝，参数校验失败也不落盘', async () => {
  freshHome('rewire-refuse')
  const batch = makeBatch('D-REWIRE-REFUSE', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'done', { childSessionId: 'child-T-2' }),
    ticket('T-3', 'failed', { childSessionId: 'child-T-3' }),
    ticket('T-4', 'queued'),
    ticket('T-5', 'queued'),
    ticket('T-6', 'queued', { blockedBy: ['T-5'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const tool = toolNamed('middleman_rewire', dispatcher)
  const before = readFileSync(pathOf(batch), 'utf8')

  for (const ticketId of ['T-1', 'T-2', 'T-3']) {
    const result = await tool.execute({ batchId: batch.id, ticketId, blockedBy: [] })
    assert.equal(result.ok, false, ticketId + ' 应该被拒')
    assert.equal(result.code, 'ticket-not-rewirable', ticketId)
  }

  // 参数校验：不是数组、指向不存在的票、依赖自己、改完会成环。
  const badShape = await tool.execute({ batchId: batch.id, ticketId: 'T-4', blockedBy: 'T-1' })
  assert.equal(badShape.code, 'invalid-request')
  const badDep = await tool.execute({ batchId: batch.id, ticketId: 'T-4', blockedBy: ['GONE'] })
  assert.equal(badDep.code, 'dependency-missing')
  const selfDep = await tool.execute({ batchId: batch.id, ticketId: 'T-4', blockedBy: ['T-4'] })
  assert.equal(selfDep.code, 'invalid-request')
  const cycle = await tool.execute({ batchId: batch.id, ticketId: 'T-5', blockedBy: ['T-6'] })
  assert.equal(cycle.code, 'dependency-cycle')

  // 被拒绝的调用一个字节都不许写，也不许碰任何会话。
  assert.equal(readFileSync(pathOf(batch), 'utf8'), before, '拒绝不能留副作用')
  assert.equal(dispatcher.spawnCalls.length, 0)
  assert.equal(dispatcher.runCalls.length, 0)
})

test('rebind：新会话的 turn/end 结算到这张票（观察器按 childSessionId 反查）', async () => {
  freshHome('rebind-settle')
  const batch = makeBatch('D-REBIND-SETTLE', [
    // 旧会话已经报过 turn 1：重绑必须清掉这个标记，否则新会话的 1 号轮次
    // 会被当成「已经报过」而丢掉。
    ticket('T-1', 'failed', {
      childSessionId: 'child-old',
      reportedTurn: 1,
      report: { turn: 1, status: 'failed', attempts: 0 },
      rebinds: [],
    }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ doneReceipt: true })
  const faces = facesWith(dispatcher)
  const { handlers, uninstall } = installForTest(faces)
  // 等启动对账跑完：此刻索引里只有 child-old。
  await sleep(120)

  const tool = toolNamed('middleman_rebind', dispatcher)
  const result = await tool.execute({ batchId: batch.id, ticketId: 'T-1', sessionId: 'child-new' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.batch.status, 'approved')
  assert.equal(result.ticket.status, 'failed')
  assert.equal(result.ticket.sessionId, 'child-new')
  assert.deepEqual(result.relay.started, [])

  const afterRebind = await load(batch.id)
  const rebound = afterRebind.tickets.find((row) => row.id === 'T-1')
  assert.equal(rebound.childSessionId, 'child-new')
  assert.equal(rebound.reportedTurn, undefined, '旧会话的结算标记要清掉')
  // 重绑本身不向任何子会话发消息（旧会话、新会话都没有）。
  assert.equal(
    dispatcher.runCalls.some((row) => row.sessionId === 'child-old' || row.sessionId === 'child-new'),
    false,
  )

  // 立刻触发新会话的 turn/end：索引必须已经重建，否则这条回传会被丢掉。
  await handlers['session/event'](
    { id: 'child-new' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const target = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(target.status, 'done', '新会话的 turn/end 必须结算到这张票')
  assert.equal(target.childSessionId, 'child-new')
  assert.equal(target.reportedTurn, 1)
  assert.equal(target.report.turn, 1)
  // 审计字段：从哪个会话改绑到哪个会话。
  assert.equal(target.rebinds.length, 1)
  assert.equal(target.rebinds[0].from, 'child-old')
  assert.equal(target.rebinds[0].to, 'child-new')
  assert.equal(typeof target.rebinds[0].at, 'number')
  // 回传信封照常推给主会话——这不是「工具给子会话发消息」。
  assert.equal(dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent').length, 1)
})

test('rebind：票本身还是 failed 时后继不启动；新会话结算成 done 后才接力', async () => {
  freshHome('rebind-blocked')
  const batch = makeBatch('D-REBIND-BLOCKED', [
    ticket('T-1', 'failed', { childSessionId: 'child-old' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ doneReceipt: true })
  const faces = facesWith(dispatcher)
  const { handlers, uninstall } = installForTest(faces)
  await sleep(120)

  const tool = toolNamed('middleman_rebind', dispatcher)
  const result = await tool.execute({ batchId: batch.id, ticketId: 'T-1', sessionId: 'child-new' })
  assert.equal(result.ok, true, JSON.stringify(result))
  // 重绑不改票的状态：failed 仍不满足依赖，后继必须安静地等着。
  assert.deepEqual(result.evaluation.startable, [])
  assert.deepEqual(result.relay.started, [])
  assert.equal(dispatcher.spawnCalls.length, 0, '票状态没变，后继不该被启动')

  let after = await load(batch.id)
  let successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'queued')
  assert.equal(successor.blockedState.allSatisfied, false)
  assert.deepEqual(
    successor.blockedState.blockers.map((row) => [row.id, row.status, row.satisfied]),
    [['T-1', 'failed', false]],
  )

  // 新会话跑完：T-1 结算成 done，结算路径触发求值，T-2 才启动。
  await handlers['session/event'](
    { id: 'child-new' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  after = await load(batch.id)
  assert.equal(after.tickets.find((row) => row.id === 'T-1').status, 'done')
  successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'running')
  assert.equal(successor.childSessionId, 'child-T-2')
  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId), ['T-2'])
})

test('rebind：已结算的票拒绝改绑；同一会话不能绑给两张票；台账不变', async () => {
  freshHome('rebind-refuse')
  const batch = makeBatch('D-REBIND-REFUSE', [
    ticket('T-1', 'done', { childSessionId: 'child-1' }),
    ticket('T-2', 'failed', { childSessionId: 'child-2' }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher()
  const tool = toolNamed('middleman_rebind', dispatcher)
  const before = readFileSync(pathOf(batch), 'utf8')

  const settled = await tool.execute({ batchId: batch.id, ticketId: 'T-1', sessionId: 'child-9' })
  assert.equal(settled.ok, false)
  assert.equal(settled.code, 'ticket-not-rebindable')

  const duplicated = await tool.execute({ batchId: batch.id, ticketId: 'T-2', sessionId: 'child-1' })
  assert.equal(duplicated.ok, false)
  assert.equal(duplicated.code, 'session-already-bound')

  const missing = await tool.execute({ batchId: batch.id, ticketId: 'T-9', sessionId: 'child-9' })
  assert.equal(missing.code, 'ticket-missing')

  // 参数校验：sessionId 是空的。
  const noSession = await tool.execute({ batchId: batch.id, ticketId: 'T-2', sessionId: '   ' })
  assert.equal(noSession.code, 'invalid-request')

  assert.equal(readFileSync(pathOf(batch), 'utf8'), before, '拒绝不能留副作用')
  assert.equal(dispatcher.spawnCalls.length, 0)
  assert.equal(dispatcher.runCalls.length, 0)
})
