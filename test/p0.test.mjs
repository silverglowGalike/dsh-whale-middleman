/**
 * P0 回归测试：都是昨天真机撞过的坑，每条对应一个具体故障。
 *
 * 跑：node --test test/p0.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-home-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { jsonSafe, classifyTurnEnd } = await import('../lib/core.js')
const { save, load, blankBatch } = await import('../lib/ledger.js')
const { buildTools } = await import('../lib/tools.js')
const { envelopeFor, lastTurnEnd } = await import('../lib/observer.js')

/**
 * 造一份能通过拆票闸门的草稿批次。
 *
 * P1 起拆票发生在批准**之前**（批次 converged，票是 draft）；批准完成后
 * 整批锁定，design_split 会被拒。所以这里的夹具用 converged，而不是
 * 旧的 approved——旧流程「先批准再拆票」已经被 P1 换掉了。
 */
function fixture(id) {
  return {
    id,
    title: '测试批次',
    createdAt: Date.now(),
    status: 'converged',
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
    spec: { goal: '目标', nonGoals: [], acceptance: ['能跑起来'] },
    tickets: [
      {
        id: 'T-1',
        title: '实施',
        brief: 'b1',
        riskIds: ['R-1'],
        model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
        modelReason: '因为',
        blockedBy: [],
        status: 'running',
        childSessionId: 'session-child-1',
      },
      {
        id: 'T-2',
        title: '验证',
        brief: 'b2',
        riskIds: ['R-1'],
        model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
        modelReason: '因为',
        blockedBy: ['T-1'],
        status: 'pending',
      },
    ],
  }
}

function writeFixture(batch) {
  writeFileSync(join(HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2))
}

const faces = {
  dispatcher: { run: async () => {}, tail: async () => [] },
  confirmations: { find: async () => undefined },
  testFiles: async () => [],
  warn: () => {},
}

const splitTool = buildTools(faces).find((tool) => tool.name === 'design_split')

test('jsonSafe：undefined 键被丢掉，数组里的 undefined 变 null', () => {
  const safe = jsonSafe({ a: 1, b: undefined, c: [1, undefined, { d: undefined }], e: NaN })
  assert.equal('b' in safe, false)
  assert.deepEqual(safe.c, [1, null, {}])
  assert.equal(safe.e, null)
})

test('classifyTurnEnd：网络中断按 failed + NETWORK_FAILED；用户/主会话的停止分开记', () => {
  const transport = classifyTurnEnd({ kind: 'error', error: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } })
  assert.equal(transport.status, 'failed')
  assert.equal(transport.code, 'NETWORK_FAILED')
  assert.equal(transport.network, true)
  assert.equal(transport.resumable, false)

  const aborted = classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })
  assert.equal(aborted.status, 'user_interrupted')
  assert.equal(aborted.resumable, false)

  // 主会话调的取消要跟用户按的停止分开（I-03）。
  const leadAborted = classifyTurnEnd({ kind: 'aborted' }, { interruptedBy: 'lead' })
  assert.equal(leadAborted.status, 'lead_interrupted')
  assert.match(leadAborted.note, /主会话/)

  const hostInterrupt = classifyTurnEnd({ kind: 'interrupted' })
  assert.equal(hostInterrupt.status, 'partial')
  assert.equal(hostInterrupt.resumable, false)

  assert.equal(classifyTurnEnd({ kind: 'completed' }).status, 'done')
  assert.equal(classifyTurnEnd({ kind: 'error', error: { code: 'ACCOUNT_QUOTA' } }).status, 'failed')
  assert.equal(classifyTurnEnd({ kind: 'forked' }).ignore, true)
})

test('ledger：写一次 revision +1，旧版本号写不进去', async () => {
  const batch = blankBatch('版本号测试')
  writeFixture(batch)
  const first = await save(batch)
  assert.equal(first.revision, 1)

  const stale = await load(batch.id)
  stale.title = '别人先写的'
  await save(stale)
  assert.equal((await load(batch.id)).revision, 2)

  await assert.rejects(
    () => save(stale, { expectedRevision: 1 }),
    (error) => error.code === 'revision-conflict',
  )
})

test('design_split：只传 T-2 时不再抹掉 T-1（昨天的台账事故）', async () => {
  const batch = fixture('D-TEST-MERGE')
  writeFixture(batch)
  const result = await splitTool.execute({
    batchId: batch.id,
    tickets: [{
      id: 'T-2',
      title: '验证（改过）',
      brief: 'b2-new',
      riskIds: ['R-1'],
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      modelReason: '因为',
      blockedBy: ['T-1'],
    }],
  })
  assert.equal(result.ok, true)
  const after = await load(batch.id)
  assert.deepEqual(after.tickets.map((ticket) => ticket.id), ['T-1', 'T-2'])
  assert.equal(after.tickets[0].childSessionId, 'session-child-1')
  assert.equal(after.tickets[1].brief, 'b2-new')
  assert.equal(after.tickets[1].blockedBy[0], 'T-1')
})

test('design_split：已派发的票拒绝就地改', async () => {
  const batch = fixture('D-TEST-LOCKED')
  writeFixture(batch)
  const result = await splitTool.execute({
    batchId: batch.id,
    tickets: [{ id: 'T-1', title: '改实施', brief: 'x', riskIds: ['R-1'], model: { provider: 'p', model: 'm' }, modelReason: '因为' }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ticket-locked')
})

test('design_split：校验不过时不落盘（拒绝不留副作用）', async () => {
  const batch = fixture('D-TEST-NOSAVE')
  writeFixture(batch)
  const before = readFileSync(join(HOME, 'designs', batch.id + '.json'), 'utf8')
  const result = await splitTool.execute({
    batchId: batch.id,
    tickets: [{ id: 'T-2', title: '没有模型', brief: 'x', riskIds: ['R-1'], model: {} }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'split-blocked')
  const after = readFileSync(join(HOME, 'designs', batch.id + '.json'), 'utf8')
  assert.equal(after, before)
})

test('envelopeFor：定位 + 结论；没有正文时指向台账', () => {
  const ticket = {
    id: 'T-2',
    status: 'done',
    report: { turn: 2, status: 'done', envelopeId: 'T-2:2', attempts: 1 },
  }
  const text = envelopeFor({ id: 'D-1', title: '批次' }, ticket)
  assert.match(text, /T-2 · turn 2 · done/)
  assert.match(text, /middleman_status/)
  assert.doesNotMatch(text, /最终答复/)
})

test('lastTurnEnd：取最后一个 turn/end', () => {
  const events = [
    { event: { type: 'turn/start', data: { turn: 1 } } },
    { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } } },
    { event: { type: 'turn/start', data: { turn: 2 } } },
    { event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } },
  ]
  assert.deepEqual(lastTurnEnd(events), { turn: 2, reason: { kind: 'completed' } })
})
