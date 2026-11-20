/**
 * P1 宿主侧回归：草稿票、批准 CAS、批准即开跑、单票失败隔离、inbox。
 *
 * 跑：<runtime node> test/p1-host.test.mjs
 *
 * 为什么不用 `node --test`：沙箱下测试运行器会给每个文件起子进程，
 * 本机复现过 EPERM。直接执行这个文件，node:test 照样会把测试跑完，
 * 失败时退出码同样非 0。
 *
 * 所有 dispatcher 都是假的：绝不真的建会话、绝不真的给子会话发消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 台账之前指到临时目录，否则会写到 ~/.dsh 下的真台账。
const HOME = mkdtempSync(join(tmpdir(), 'wt-p1-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { buildTools } = await import('../lib/tools.js')
const { makeRoutes, API_PREFIX } = await import('../lib/routes.js')
const { load } = await import('../lib/ledger.js')

/** 一个能通过拆票闸门的 converged 批次。 */
function convergedBatch(id, overrides = {}) {
  return {
    id,
    title: 'P1 测试批次',
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
    tickets: [],
    parentSessionId: 'session-parent',
    ...overrides,
  }
}

/** 台账里的票：默认草稿态。 */
function ticket(id, overrides = {}) {
  return {
    id,
    title: id + ' 标题',
    brief: id + ' 任务书',
    riskIds: ['R-1'],
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    modelReason: '因为',
    blockedBy: [],
    status: 'draft',
    ...overrides,
  }
}

/** design_split 的入参：不带运行期字段。 */
function ticketInput(id, overrides = {}) {
  const { status: _ignored, childSessionId: _alsoIgnored, ...rest } = ticket(id, overrides)
  return rest
}

function writeFixture(batch) {
  writeFileSync(join(HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2) + '\n')
}

function pathOfBatch(batch) {
  return join(HOME, 'designs', batch.id + '.json')
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
      if (failSpawnFor.has(worker.id)) throw new Error('模型钉不上：' + worker.id)
      return {
        sessionId: 'child-' + worker.id,
        // 宿主会规范化模型：回读值才是子会话真正跑的。
        model: { provider: 'p', model: 'm-effective', reasoningEffort: 'high' },
      }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
    },
  }
}

function facesWith(dispatcher) {
  return { dispatcher, warn: () => {}, testFiles: async () => [] }
}

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

const noopFaces = {
  dispatcher: { run: async () => {} },
  confirmations: { find: async () => undefined },
  testFiles: async () => [],
  warn: () => {},
}
const splitTool = buildTools(noopFaces).find((tool) => tool.name === 'design_split')
const inboxTool = buildTools(noopFaces).find((tool) => tool.name === 'middleman_inbox')

test('/approve：expectedRevision 与盘上不符时 409，台账与 dispatcher 都没动', async () => {
  const batch = convergedBatch('D-P1-CAS', { tickets: [ticket('T-1')] })
  writeFixture(batch)
  const before = readFileSync(pathOfBatch(batch), 'utf8')

  const dispatcher = fakeDispatcher()
  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/approve', {
    batchId: batch.id,
    expectedRevision: 99, // 盘上是 0
  })

  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'revision-conflict')

  // 台账一个字节都不许变：拒绝不能留副作用。
  assert.equal(readFileSync(pathOfBatch(batch), 'utf8'), before)
  assert.equal((await load(batch.id)).status, 'converged')
  assert.equal(dispatcher.spawnCalls.length, 0)
  assert.equal(dispatcher.runCalls.length, 0)
})

test('design_split：converged 批次产出 draft 票（合并语义不变）', async () => {
  const batch = convergedBatch('D-P1-DRAFT')
  writeFixture(batch)

  const result = await splitTool.execute({
    batchId: batch.id,
    tickets: [
      ticketInput('T-1'),
      ticketInput('T-2', { blockedBy: ['T-1'] }),
    ],
  })

  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.draft, true)

  const after = await load(batch.id)
  assert.equal(after.status, 'converged')
  assert.deepEqual(after.tickets.map((row) => row.id), ['T-1', 'T-2'])
  assert.deepEqual(after.tickets.map((row) => row.status), ['draft', 'draft'])
})

test('批准后 design_split 被拒（ticket-locked），台账行数与内容都不变', async () => {
  const batch = convergedBatch('D-P1-LOCK', {
    tickets: [ticket('T-1'), ticket('T-2', { blockedBy: ['T-1'] })],
  })
  writeFixture(batch)

  const dispatcher = fakeDispatcher()
  const approved = await callRoute(facesWith(dispatcher), API_PREFIX + '/approve', {
    batchId: batch.id,
    expectedRevision: batch.revision,
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.ok, true)
  assert.equal(approved.body.status, 'approved')

  const before = readFileSync(pathOfBatch(batch), 'utf8')
  const beforeRows = (await load(batch.id)).tickets.length

  // 传一张**全新**的票：只靠「子会话已存在」那条检查是拦不住的，
  // 这里要证明的是批次级锁定——批准后不许再新增票。
  const result = await splitTool.execute({
    batchId: batch.id,
    tickets: [ticketInput('T-9', { title: '批准后新增' })],
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'ticket-locked')
  const after = await load(batch.id)
  assert.equal(after.tickets.length, beforeRows)
  assert.equal(after.tickets.some((row) => row.id === 'T-9'), false)
  assert.equal(readFileSync(pathOfBatch(batch), 'utf8'), before)
  // 原票没有被就地改掉。
  assert.equal(after.tickets.find((row) => row.id === 'T-1').title, 'T-1 标题')
})

test('/approve：逐票 spawn+run，单票失败隔离（回 queued），且不向主会话发消息', async () => {
  const batch = convergedBatch('D-P1-LAUNCH', {
    tickets: [
      ticket('T-1'),
      ticket('T-2'),
      ticket('T-3'),
      ticket('T-4', { blockedBy: ['T-1'] }),
    ],
  })
  writeFixture(batch)

  const dispatcher = fakeDispatcher({ failSpawnFor: ['T-2'] })
  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/approve', {
    batchId: batch.id,
    expectedRevision: batch.revision,
  })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual([...result.body.launched].sort(), ['T-1', 'T-3'])
  assert.deepEqual(result.body.failed.map((row) => row.ticketId), ['T-2'])
  assert.deepEqual(result.body.queued, ['T-4'])

  // ready 票 3 张（T-4 的前序还没结算，不启动）：spawn 3 次，
  // 成功启动 2 次，另有 1 条启动失败信封发给主会话。
  assert.equal(dispatcher.spawnCalls.length, 3)
  assert.deepEqual(dispatcher.spawnCalls.map((row) => row.ticketId), ['T-1', 'T-2', 'T-3'])
  assert.equal(dispatcher.runCalls.length, 3)
  const toParent = dispatcher.runCalls.filter((row) => row.sessionId === 'session-parent')
  assert.equal(toParent.length, 1)
  assert.match(toParent[0].text, /\[启动失败\] T-2/)
  assert.match(toParent[0].text, /模型钉不上/)
  const toChild = dispatcher.runCalls.filter((row) => row.sessionId !== 'session-parent')
  assert.deepEqual(toChild.map((row) => row.sessionId), ['child-T-1', 'child-T-3'])
  // 批准成功不叫醒主会话；但启动失败的票会单独报一条「启动失败」信封。

  const after = await load(batch.id)
  assert.equal(after.status, 'approved')
  assert.equal(after.approvedBy, 'human')
  assert.equal(typeof after.approvedAt, 'number')

  const byId = new Map(after.tickets.map((row) => [row.id, row]))
  assert.equal(byId.get('T-1').status, 'running')
  assert.equal(byId.get('T-1').childSessionId, 'child-T-1')
  // 回读宿主实际钉上的模型，而不是把请求值当成结果。
  assert.equal(byId.get('T-1').model.model, 'm-effective')
  // 起不来的票回 queued，不回 draft：批次已 approved，design_split 锁死，
  // draft 票永远没人再看它一眼。launchError 同时是「别自动重试」的标记，
  // launchFailureCode 是报错族的记账码。
  assert.equal(byId.get('T-2').status, 'queued')
  assert.equal(byId.get('T-2').childSessionId, undefined)
  assert.match(byId.get('T-2').launchError, /模型钉不上/)
  assert.equal(byId.get('T-2').launchFailureCode, 'LAUNCH_FAILED')
  assert.equal(byId.get('T-3').status, 'running')
  assert.equal(byId.get('T-4').status, 'queued')
})

test('/approve：0 票的 converged 批次被拒（empty-batch），台账不变', async () => {
  const batch = convergedBatch('D-P1-EMPTY')
  writeFixture(batch)
  const before = readFileSync(pathOfBatch(batch), 'utf8')

  const result = await callRoute(facesWith(fakeDispatcher()), API_PREFIX + '/approve', {
    batchId: batch.id,
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'empty-batch')
  // 拒绝不能留下任何副作用：批次不能变成 approved。
  assert.equal(readFileSync(pathOfBatch(batch), 'utf8'), before)
})

test('middleman_inbox：列出全部 waiting 票（问题/选项/建议/批次/票号）', async () => {
  const first = convergedBatch('D-P1-INBOX-1', {
    tickets: [
      ticket('T-1', {
        status: 'waiting',
        childSessionId: 'child-T-1',
        waiting: {
          question: '选 A 还是 B？',
          options: ['A', 'B'],
          recommendation: '选 A，因为改动面小',
          askedAt: 123,
          sessionId: 'child-T-1',
        },
      }),
      ticket('T-2', { status: 'running', childSessionId: 'child-T-2' }),
    ],
  })
  const second = convergedBatch('D-P1-INBOX-2', {
    tickets: [
      ticket('T-1', {
        status: 'waiting',
        childSessionId: 'child-B1',
        waiting: {
          question: '要不要删掉旧台账？',
          options: [],
          recommendation: '先不删，留着对账',
          askedAt: 456,
          sessionId: 'child-B1',
        },
      }),
    ],
  })
  writeFixture(first)
  writeFixture(second)

  const all = await inboxTool.execute({})
  assert.equal(all.ok, true)
  assert.equal(all.count, 2)
  const row = all.waiting.find((entry) => entry.batchId === first.id)
  assert.ok(row !== undefined)
  assert.equal(row.ticketId, 'T-1')
  assert.equal(row.question, '选 A 还是 B？')
  assert.deepEqual(row.options, ['A', 'B'])
  assert.equal(row.recommendation, '选 A，因为改动面小')
  assert.equal(row.status, 'waiting')

  // 可选按批次过滤。
  const scoped = await inboxTool.execute({ batchId: second.id })
  assert.equal(scoped.count, 1)
  assert.equal(scoped.waiting[0].batchId, second.id)
})
