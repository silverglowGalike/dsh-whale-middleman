/**
 * I-01 回归（2026-11-18 晚版）：子会话自评 + 最终汇报，中台只记账不判断内容。
 *
 * 跑：<runtime node> test/i01-receipt.test.mjs
 *
 * 方案（用户定的）：
 * - 子会话自测通过 → `middleman_report_done({ outcome: "done", report })`
 *   → 主会话收到汇报，依赖满足的后继自动开跑；
 * - 没通过/拿不准 → `outcome: "needs_review"` → 主会话收到汇报，但**不**自动开跑；
 * - 只交回执不判断内容——通过与否是子会话的事，中台是程序。
 *
 * 事故背景（2026-11-17）：子会话只读了两个文件、正文停在「让我先看一眼」，
 * 宿主把这一轮结算成 done，后继票基于不存在的产出继续跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIRST_HOME = mkdtempSync(join(tmpdir(), 'wt-i01-'))
process.env.WT_HOME = FIRST_HOME
mkdirSync(join(FIRST_HOME, 'designs'), { recursive: true })

const {
  RECEIPT_UNVERIFIABLE, applyReportedOutcome, classifyTurnEnd, isSatisfiedStatus,
} = await import('../lib/core.js')
const { load } = await import('../lib/ledger.js')
const { buildTools } = await import('../lib/tools.js')
const { installObserver } = await import('../lib/observer.js')
const {
  DONE_RECEIPT_TOOL, lastAssistantText, readReceipt, summarize,
} = await import('../lib/dispatch.js')

function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-i01-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

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

function makeBatch(id, tickets, overrides = {}) {
  return {
    id,
    title: 'I-01 回执测试批次',
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
    spec: { goal: '把没做和做完分开', nonGoals: [], acceptance: ['能跑起来'] },
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

function fakeDispatcher(options = {}) {
  const spawnCalls = []
  const runCalls = []
  return {
    spawnCalls,
    runCalls,
    async spawn(worker) {
      spawnCalls.push({ ticketId: worker.id })
      return { sessionId: 'child-' + worker.id, model: { provider: 'p', model: 'm' } }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
    },
    async tail() {
      if (options.tailError !== undefined) throw new Error(options.tailError)
      if (typeof options.tail === 'function') return options.tail()
      if (options.tail !== undefined) return options.tail
      return []
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function installForTest(dispatcher) {
  const handlers = {}
  const ctx = {
    on(name, handler) {
      handlers[name] = handler
      return () => {}
    },
  }
  const uninstall = installObserver(ctx, { dispatcher, warn: () => {}, testFiles: async () => [] })
  return { handlers, uninstall }
}

/** 这一轮**没有**回执（事故里的形状）。 */
const NO_RECEIPT_HISTORY = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '让我先记个计划，看一眼目录。' }] } },
  },
]

/** 这一轮的回执：自评 + 最终汇报。 */
function receiptHistory(outcome, report, turn = 1) {
  return [
    { type: 'turn/start', data: { turn } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '写报告…' }] } },
    },
    {
      type: 'tool/call',
      data: {
        turn,
        name: DONE_RECEIPT_TOOL,
        arguments: JSON.stringify({ outcome, report }),
      },
    },
  ]
}

test('applyReportedOutcome：done 才解锁；needs_review / 无回执 / 读不到 都停住', () => {
  const done = classifyTurnEnd({ kind: 'completed' })

  const passed = applyReportedOutcome(done, { outcome: 'done', report: '全部通过' })
  assert.equal(passed.status, 'done')
  assert.equal(passed.outcome, 'done')

  const review = applyReportedOutcome(done, { outcome: 'needs_review', report: 'x', note: '测试没过' })
  assert.equal(review.status, 'needs_review')
  assert.equal(review.code, 'NEEDS_REVIEW')
  assert.equal(review.outcome, 'needs_review')
  assert.match(review.note, /测试没过/)

  const missing = applyReportedOutcome(done, undefined)
  assert.equal(missing.status, 'no_receipt')
  assert.equal(missing.code, 'NO_RECEIPT')

  const unverified = applyReportedOutcome(done, RECEIPT_UNVERIFIABLE)
  assert.equal(unverified.status, 'receipt_unverified')
  assert.equal(unverified.code, 'RECEIPT_UNVERIFIED')

  // 非 completed 的分类不受回执影响。
  const trunc = applyReportedOutcome(classifyTurnEnd({ kind: 'max-tokens' }), { outcome: 'done', report: '' })
  assert.equal(trunc.status, 'partial')
  assert.match(trunc.note, /max-tokens/)
  const aborted = applyReportedOutcome(classifyTurnEnd({ kind: 'aborted' }), { outcome: 'done', report: '' })
  assert.equal(aborted.status, 'user_interrupted')
  const transport = applyReportedOutcome(
    classifyTurnEnd({ kind: 'error', error: { code: 'TRANSPORT' } }),
    { outcome: 'done', report: '' },
  )
  assert.equal(transport.status, 'failed')
  assert.equal(transport.code, 'NETWORK_FAILED')
})

test('readReceipt：按 turn 读，同一轮以最后一次为准，参数不合法就当没交', () => {
  const history = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'tool/call',
      data: { turn: 1, name: DONE_RECEIPT_TOOL, arguments: JSON.stringify({ outcome: 'done', report: '第一轮' }) },
    },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'tool/call',
      data: { turn: 2, name: DONE_RECEIPT_TOOL, arguments: JSON.stringify({ outcome: 'needs_review', report: '第二轮' }) },
    },
  ]
  assert.equal(readReceipt(history, 1).outcome, 'done')
  assert.equal(readReceipt(history, 2).outcome, 'needs_review')
  assert.equal(readReceipt(history, 2).report, '第二轮')

  const lastWins = [
    { type: 'tool/call', data: { turn: 1, name: DONE_RECEIPT_TOOL, arguments: JSON.stringify({ outcome: 'needs_review', report: 'a' }) } },
    { type: 'tool/call', data: { turn: 1, name: DONE_RECEIPT_TOOL, arguments: JSON.stringify({ outcome: 'done', report: 'b' }) } },
  ]
  assert.equal(readReceipt(lastWins, 1).outcome, 'done')

  const junk = [{ type: 'tool/call', data: { turn: 1, name: DONE_RECEIPT_TOOL, arguments: '{not json' } }]
  assert.equal(readReceipt(junk, 1), undefined)
  const badOutcome = [{ type: 'tool/call', data: { turn: 1, name: DONE_RECEIPT_TOOL, arguments: JSON.stringify({ outcome: 'ok', report: 'x' }) } }]
  assert.equal(readReceipt(badOutcome, 1), undefined)
  // 其它工具不是回执。
  assert.equal(readReceipt([{ type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{}' } }], 1), undefined)
})

test('lastAssistantText：只取这一轮，不把上一轮的正文拼进来', () => {
  const history = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮的话' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二轮的话' }] } } },
  ]
  assert.equal(lastAssistantText(history, 2), '第二轮的话')
  assert.equal(lastAssistantText(history, 1), '第一轮的话')
  assert.equal(lastAssistantText(history), '第二轮的话')
})

test('summarize：本机的 pwsh 命令也要算进摘要', () => {
  const summary = summarize([
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'node --check lib/core.js' }) } },
    { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'lib/core.js' }) } },
    { type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) } },
    { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ file_path: 'lib/observer.js' }) } },
  ])
  assert.deepEqual(summary.files, ['lib/core.js'])
  assert.deepEqual(summary.commands, ['node --check lib/core.js', 'echo hi'])
})

test('middleman_report_done：交自评+汇报、不写台账、非子会话拒绝', async () => {
  freshHome('tool')
  const batch = makeBatch('D-I01-TOOL', [ticket('T-1', 'running', { childSessionId: 'child-T-1' })])
  writeBatch(batch)
  const path = join(process.env.WT_HOME, 'designs', batch.id + '.json')
  const before = readFileSync(path, 'utf8')

  const faces = {
    dispatcher: fakeDispatcher(),
    warn: () => {},
    testFiles: async () => [],
    confirmations: {
      async find(sessionId) {
        return sessionId === 'child-T-1' ? { batch, ticket: batch.tickets[0] } : undefined
      },
    },
  }
  const tool = buildTools(faces).find((candidate) => candidate.name === 'middleman_report_done')
  assert.ok(tool !== undefined, '工具面里必须有 middleman_report_done')

  const ok = await tool.execute(
    { outcome: 'done', report: '改了 core.js，测试通过。' },
    { agent: { session: { id: 'child-T-1' } } },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.outcome, 'done')
  assert.equal(ok.ticketId, 'T-1')
  assert.equal(ok.receipt, 'recorded-in-history')

  // 回执只落在会话历史里（那条 tool/call），不许改台账——否则结算与工具会抢 CAS。
  assert.equal(readFileSync(path, 'utf8'), before, 'report_done 不写台账')

  const review = await tool.execute(
    { outcome: 'needs_review', report: '实现了，但测试没过。' },
    { agent: { session: { id: 'child-T-1' } } },
  )
  assert.equal(review.ok, true)

  const badOutcome = await tool.execute(
    { outcome: 'ok', report: 'x' },
    { agent: { session: { id: 'child-T-1' } } },
  )
  assert.equal(badOutcome.code, 'invalid-request')
  const noReport = await tool.execute(
    { outcome: 'done', report: '   ' },
    { agent: { session: { id: 'child-T-1' } } },
  )
  assert.equal(noReport.code, 'invalid-request')

  const stray = await tool.execute({ outcome: 'done', report: 'x' }, { agent: { session: { id: 'someone-else' } } })
  assert.equal(stray.code, 'not-a-dispatched-ticket')
  const noSession = await tool.execute({ outcome: 'done', report: 'x' }, {})
  assert.equal(noSession.code, 'invalid-request')
})

test('端到端：done 回执 → 汇报回到主会话，后继自动开跑', async () => {
  freshHome('done')
  const batch = makeBatch('D-I01-DONE', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ tail: receiptHistory('done', '实现完成，测试通过。') })
  const { handlers, uninstall } = installForTest(dispatcher)
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const settled = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(settled.status, 'done')
  assert.equal(settled.report.outcome, 'done')
  // 回执里的汇报是权威正文；不再依赖历史拼接。
  assert.equal(settled.report.text, '实现完成，测试通过。')

  const successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'running')
  assert.equal(successor.childSessionId, 'child-T-2')

  // 主会话收到的回传里要直接有汇报正文。
  const toParent = dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent')
  assert.equal(toParent.length, 1)
  assert.match(toParent[0].text, /· done/)
  assert.match(toParent[0].text, /报告: 实现完成，测试通过。/)
})

test('端到端：needs_review 只回传汇报，后继不开跑', async () => {
  freshHome('review')
  const batch = makeBatch('D-I01-REVIEW', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({
    tail: receiptHistory('needs_review', '界面改好了，但三个用例没过，需要你判断。'),
  })
  const { handlers, uninstall } = installForTest(dispatcher)
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const settled = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(settled.status, 'needs_review')
  assert.equal(settled.report.code, 'NEEDS_REVIEW')
  assert.equal(settled.report.outcome, 'needs_review')

  const successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'queued')
  assert.equal(successor.childSessionId, undefined)
  assert.deepEqual(dispatcher.spawnCalls, [])

  const toParent = dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent')
  assert.equal(toParent.length, 1)
  assert.match(toParent[0].text, /报告: 界面改好了/)
  assert.match(toParent[0].text, /后继不会自动开跑/)
})

test('端到端：没有回执 → no_receipt，后继停在 queued', async () => {
  freshHome('no-receipt')
  const batch = makeBatch('D-I01-NO-RECEIPT', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ tail: NO_RECEIPT_HISTORY })
  const { handlers, uninstall } = installForTest(dispatcher)
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const settled = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(settled.status, 'no_receipt')
  assert.equal(settled.report.code, 'NO_RECEIPT')
  const successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'queued')
  assert.deepEqual(dispatcher.spawnCalls, [])
})

test('端到端：读不到历史 → receipt_unverified（无法核实），后继不开跑', async () => {
  freshHome('unverifiable')
  const batch = makeBatch('D-I01-UNVERIFIED', [
    ticket('T-1', 'running', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'queued', { blockedBy: ['T-1'] }),
  ])
  writeBatch(batch)

  const dispatcher = fakeDispatcher({ tailError: '宿主没有提供流式端点' })
  const { handlers, uninstall } = installForTest(dispatcher)
  await sleep(120)

  await handlers['session/event'](
    { id: 'child-T-1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  uninstall()

  const after = await load(batch.id)
  const settled = after.tickets.find((row) => row.id === 'T-1')
  assert.equal(settled.status, 'receipt_unverified')
  assert.equal(settled.report.code, 'RECEIPT_UNVERIFIED')
  assert.equal(settled.report.receipt, 'unverifiable')
  assert.match(settled.report.note, /无法核实/)

  const successor = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(successor.status, 'queued')
  assert.deepEqual(dispatcher.spawnCalls, [])
})

test('依赖口径：只有 done 满足；needs_review / no_receipt / receipt_unverified 不自动放行', () => {
  assert.equal(isSatisfiedStatus('done'), true)
  for (const status of [
    'partial', 'needs_review', 'no_receipt', 'receipt_unverified',
    'failed', 'cancelled', 'interrupted', 'running', 'waiting',
  ]) {
    assert.equal(isSatisfiedStatus(status), false, status)
  }
})
