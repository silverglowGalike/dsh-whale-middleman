/**
 * 写台账不能整批覆盖：这是 P0 类回归。
 *
 * 旧实现里有 16 处 `await save(batch)`：`load → await 宿主调用 → 整批回写`。
 * 中间那几百毫秒到几秒里，观察器完全可能刚结算了同批另一张票；整批回写
 * 会把那份结算抹掉，而界面上什么都不会报——状态只是「不更新了」。
 *
 * 最值钱的路径：`/run` 在 `dispatcher.run` 期间另一张票被结算，
 * 回写不能盖掉那份结算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-write-race-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { makeRoutes, API_PREFIX } = await import('../lib/routes.js')
const { load } = await import('../lib/ledger.js')
const { patchTicket } = await import('../lib/commit.js')

function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-write-race-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

function ticket(id, status, overrides = {}) {
  return {
    id,
    title: id + ' 标题',
    brief: id + ' 的任务书',
    blockedBy: [],
    riskIds: ['R-1'],
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    modelReason: '测试',
    status,
    childSessionId: 'child-' + id,
    ...overrides,
  }
}

function makeBatch(id, tickets, overrides = {}) {
  return {
    id,
    title: '并发写测试 ' + id,
    createdAt: Date.now(),
    status: 'approved',
    revision: 0,
    decisions: [],
    questions: [
      { question: 'q1', answer: 'a1', kind: 'goal' },
      { question: 'q2', answer: 'a2', kind: 'scope' },
      { question: 'q3', answer: 'a3', kind: 'design' },
    ],
    plan: { steps: '1. 做', output: '做完' },
    risks: [{
      id: 'R-1',
      title: '会失败',
      trigger: '当 X 时',
      impact: '结果不对',
      mitigation: '写 Y 兜住',
      verification: '人工核对：跑一遍',
    }],
    spec: { goal: '测试', nonGoals: [], acceptance: ['能跑'] },
    tickets,
    parentSessionId: 'session-parent',
    cwd: 'C:/tmp',
    ...overrides,
  }
}

function writeFixture(batch) {
  const path = join(process.env.WT_HOME, 'designs', batch.id + '.json')
  writeFileSync(path, JSON.stringify(batch, null, 2) + '\n')
  return batch
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

test('/run 回写不覆盖并发结算：另一张票在 dispatcher.run 期间完成', async () => {
  freshHome('run')
  const batch = writeFixture(makeBatch('D-RACE-RUN', [
    ticket('T-1', 'suspended', { childSessionId: 'child-T-1' }),
    ticket('T-2', 'running', { childSessionId: 'child-T-2' }),
  ]))

  const dispatcher = {
    async run() {
      // 模拟观察器在这个网络往返期间结算了同批的 T-2。
      await patchTicket(batch.id, 'T-2', (target) => {
        target.status = 'done'
        target.finishedAt = 1700000000000
      })
    },
    async tail() { return [] },
  }

  const result = await callRoute({ dispatcher, warn: () => {}, testFiles: async () => [] },
    API_PREFIX + '/run', { batchId: batch.id, ticketId: 'T-1' })
  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'running')

  const after = await load(batch.id)
  const t1 = after.tickets.find((row) => row.id === 'T-1')
  const t2 = after.tickets.find((row) => row.id === 'T-2')
  assert.equal(t1.status, 'running')
  assert.equal(t2.status, 'done', 'T-2 的结算被 /run 的整批回写盖掉了')
  assert.equal(t2.finishedAt, 1700000000000)
})
