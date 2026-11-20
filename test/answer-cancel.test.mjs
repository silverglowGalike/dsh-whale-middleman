/**
 * 主会话闭环：回答 waiting 票、取消跑歪的票。
 *
 * 定位（用户 2026-11-20）：技术性确认让主会话直接答，用户专注设计与决策；
 * 方向/范围/取舍仍走用户。取消记 lead_interrupted，和用户按停止分开审计。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-answer-cancel-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { buildTools } = await import('../lib/tools.js')
const { load } = await import('../lib/ledger.js')

function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-answer-cancel-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

function makeBatch(id, tickets) {
  return {
    id,
    title: '答复/取消测试 ' + id,
    createdAt: Date.now(),
    status: 'approved',
    revision: 0,
    decisions: [],
    questions: [],
    risks: [],
    tickets,
    parentSessionId: 'session-parent',
    cwd: 'C:/tmp',
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
    model: { provider: 'p', model: 'm' },
    status,
    childSessionId: 'child-' + id,
    ...overrides,
  }
}

function writeFixture(batch) {
  writeFileSync(join(process.env.WT_HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2) + '\n')
  return batch
}

function fakeDispatcher(options = {}) {
  const runCalls = []
  const cancelCalls = []
  return {
    runCalls,
    cancelCalls,
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
      if (options.failRun === true) throw new Error('送不进去')
    },
    async cancel(sessionId) {
      cancelCalls.push(sessionId)
      if (options.failCancel === true) throw new Error('取消失败')
    },
  }
}

function facesWith(dispatcher) {
  return {
    dispatcher,
    warn: () => {},
    testFiles: async () => [],
    confirmations: { find: async () => undefined },
  }
}

function tool(name, faces) {
  return buildTools(faces).find((candidate) => candidate.name === name)
}

test('middleman_answer：waiting 票 → 答复送进子会话，票回 running，记 by: lead', async () => {
  freshHome('answer')
  const batch = writeFixture(makeBatch('D-ANSWER', [
    ticket('T-1', 'waiting', {
      waiting: {
        question: '用哪个目录跑测试？',
        options: ['C:/tmp', 'D:/tmp'],
        recommendation: 'C:/tmp',
        askedAt: Date.now(),
        sessionId: 'child-T-1',
      },
    }),
  ]))
  const dispatcher = fakeDispatcher()
  const result = await tool('middleman_answer', facesWith(dispatcher)).execute({
    batchId: batch.id,
    ticketId: 'T-1',
    answer: '用 C:/tmp，别碰 D 盘',
  })

  assert.equal(result.ok, true)
  assert.equal(dispatcher.runCalls.length, 1)
  assert.equal(dispatcher.runCalls[0].sessionId, 'child-T-1')
  assert.match(dispatcher.runCalls[0].text, /^\[主会话的答复\]/)
  assert.match(dispatcher.runCalls[0].text, /用哪个目录跑测试/)
  assert.match(dispatcher.runCalls[0].text, /用 C:\/tmp/)

  const after = await load(batch.id)
  const row = after.tickets[0]
  assert.equal(row.status, 'running')
  assert.equal(row.waiting, undefined)
  assert.equal(row.answers.at(-1).by, 'lead')
  assert.equal(row.answers.at(-1).answer, '用 C:/tmp，别碰 D 盘')
})

test('middleman_answer：非 waiting 拒绝；空答复拒绝；送不进去不写台账', async () => {
  freshHome('answer-refuse')
  const batch = writeFixture(makeBatch('D-ANSWER-REFUSE', [
    ticket('T-1', 'running'),
    ticket('T-2', 'waiting', { waiting: { question: 'q', sessionId: 'child-T-2' } }),
  ]))
  const dispatcher = fakeDispatcher({ failRun: true })

  const notWaiting = await tool('middleman_answer', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-1', answer: 'x',
  })
  assert.equal(notWaiting.ok, false)
  assert.equal(notWaiting.code, 'ticket-not-waiting')

  const empty = await tool('middleman_answer', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-2', answer: '   ',
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'invalid-request')

  const failedSend = await tool('middleman_answer', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-2', answer: '用 A',
  })
  assert.equal(failedSend.ok, false)
  assert.equal(failedSend.code, 'answer-failed')

  const after = await load(batch.id)
  assert.equal(after.tickets.find((row) => row.id === 'T-2').status, 'waiting')
})

test('middleman_cancel：running 票停会话并记 lead_interrupted；queued 无会话也能取消', async () => {
  freshHome('cancel')
  const batch = writeFixture(makeBatch('D-CANCEL', [
    ticket('T-1', 'running'),
    ticket('T-2', 'queued', { childSessionId: undefined }),
  ]))
  const dispatcher = fakeDispatcher()

  const running = await tool('middleman_cancel', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-1', reason: '跑歪了',
  })
  assert.equal(running.ok, true)
  assert.deepEqual(dispatcher.cancelCalls, ['child-T-1'])

  const queued = await tool('middleman_cancel', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-2',
  })
  assert.equal(queued.ok, true)
  assert.deepEqual(dispatcher.cancelCalls, ['child-T-1'])

  const after = await load(batch.id)
  for (const row of after.tickets) {
    assert.equal(row.status, 'lead_interrupted')
    assert.equal(row.interruptedBy, 'lead')
  }
  assert.equal(after.tickets.find((row) => row.id === 'T-1').interruptReason, '跑歪了')
})

test('middleman_answer / middleman_cancel：子会话调用被拒（不是主会话的工具）', async () => {
  freshHome('not-lead')
  const batch = writeFixture(makeBatch('D-NOT-LEAD', [
    ticket('T-1', 'waiting', { waiting: { question: 'q', sessionId: 'child-T-1' } }),
  ]))
  const dispatcher = fakeDispatcher()
  const faces = {
    ...facesWith(dispatcher),
    confirmations: {
      find: async (sessionId) => (sessionId === 'child-T-1'
        ? { batch: { id: batch.id }, ticket: { id: 'T-9' } }
        : undefined),
    },
  }
  const exec = { agent: { session: { id: 'child-T-1' } } }

  const answer = await tool('middleman_answer', faces).execute(
    { batchId: batch.id, ticketId: 'T-1', answer: 'x' },
    exec,
  )
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'not-a-lead')

  const cancel = await tool('middleman_cancel', faces).execute(
    { batchId: batch.id, ticketId: 'T-1' },
    exec,
  )
  assert.equal(cancel.ok, false)
  assert.equal(cancel.code, 'not-a-lead')

  const after = await load(batch.id)
  assert.equal(after.tickets[0].status, 'waiting')
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal(dispatcher.cancelCalls.length, 0)
})

test('middleman_cancel：终态票拒绝；取消失败仍记主会话取消', async () => {
  freshHome('cancel-refuse')
  const batch = writeFixture(makeBatch('D-CANCEL-REFUSE', [
    ticket('T-1', 'done'),
    ticket('T-2', 'waiting', { waiting: { question: 'q', sessionId: 'child-T-2' } }),
  ]))
  const dispatcher = fakeDispatcher({ failCancel: true })

  const done = await tool('middleman_cancel', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-1',
  })
  assert.equal(done.ok, false)
  assert.equal(done.code, 'ticket-not-cancellable')

  // 子会话可能已经结束：cancel 抛错不能阻止台账记成主会话取消。
  const waiting = await tool('middleman_cancel', facesWith(dispatcher)).execute({
    batchId: batch.id, ticketId: 'T-2',
  })
  assert.equal(waiting.ok, true)
  const after = await load(batch.id)
  const row = after.tickets.find((candidate) => candidate.id === 'T-2')
  assert.equal(row.status, 'lead_interrupted')
  assert.equal(row.waiting, undefined)
})
