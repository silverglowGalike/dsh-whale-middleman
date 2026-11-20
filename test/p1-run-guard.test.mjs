/**
 * 现场事故回归（2026-11-17 21:33）：已取消 / 已结束的票被「执行」重新拉起。
 *
 * 事故链有两环，这一套测试两环都盯：
 * 1. `POST /run` 没有状态守卫——旧实现只拦 running，于是 20:08 就已
 *    cancelled 的票被用户误点「执行」，又被发了一整轮任务书，21:34 才被中止。
 * 2. 面板把 old batch 排在最新批次上面 / 终态票也画「执行」按钮——诱因。
 *
 * 另外守住追加需求：`/approve` 启动失败的票必须回 queued（不是 draft），
 * 否则批次已 approved、design_split 锁死，这张票永远没人重试。
 *
 * 跑：<runtime node> test/p1-run-guard.test.mjs
 *
 * 为什么不用 `node --test`：沙箱下测试运行器会给每个文件起子进程，
 * 本机复现过 EPERM（与 p1-host / p1-relay 同口径）。直接执行这个文件，
 * node:test 照样把测试跑完，失败时退出码同样非 0。
 *
 * 所有 dispatcher 都是假的：绝不真的建会话、绝不真的给子会话发消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 台账之前指到临时目录，否则会写到 ~/.dsh 下的真台账。
// 每个测试再切一份新的 HOME：/state 会扫全部批次，混在一起会互相干扰。
const FIRST_HOME = mkdtempSync(join(tmpdir(), 'wt-run-guard-'))
process.env.WT_HOME = FIRST_HOME
mkdirSync(join(FIRST_HOME, 'designs'), { recursive: true })

const { makeRoutes, API_PREFIX } = await import('../lib/routes.js')
const { load } = await import('../lib/ledger.js')
const { relayBatch } = await import('../lib/observer.js')

/** 切一份干净的台账目录。测试之间互不看见对方的批次。 */
function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-run-guard-' + label + '-'))
  process.env.WT_HOME = dir
  mkdirSync(join(dir, 'designs'), { recursive: true })
  return dir
}

/** 一个批次。status 默认 converged；createdAt 可指定，用来测面板排序。 */
function makeBatch(id, status, tickets, overrides = {}) {
  return {
    id,
    title: '守卫测试批次 ' + id,
    createdAt: Date.now(),
    status,
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
    spec: { goal: '加状态守卫', nonGoals: [], acceptance: ['能跑起来'] },
    parentSessionId: 'session-parent',
    tickets,
    ...overrides,
  }
}

/** 一张已经派发过的票：默认挂着一个子会话。 */
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
    childSessionId: 'child-' + id,
    ...overrides,
  }
}

/** 还没派发的草稿票（/approve 的输入形态）。 */
function draftTicket(id, overrides = {}) {
  const { childSessionId: _ignored, ...rest } = ticket(id, 'draft', overrides)
  return rest
}

function writeFixture(batch) {
  writeFileSync(
    join(process.env.WT_HOME, 'designs', batch.id + '.json'),
    JSON.stringify(batch, null, 2) + '\n',
  )
  return batch
}

function pathOf(batch) {
  return join(process.env.WT_HOME, 'designs', batch.id + '.json')
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
        model: { provider: 'p', model: 'm-effective', reasoningEffort: 'high' },
      }
    },
    async run(sessionId, text) {
      runCalls.push({ sessionId, text })
    },
    async tail() {
      return []
    },
  }
}

function facesWith(dispatcher) {
  return { dispatcher, warn: () => {}, testFiles: async () => [] }
}

/** 走真正的路由 handler，造一个最小 req/res。GET 时不带 body。 */
async function callRoute(faces, path, body) {
  const route = makeRoutes(faces).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, '找不到路由 ' + path)
  const req = {
    url: path,
    method: body === undefined ? 'GET' : 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:53827' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
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

test('cancelled 票调 /run：409 ticket-terminal，台账一个字节不变，dispatcher.run 一次都没调', async () => {
  freshHome('cancelled')
  const batch = writeFixture(makeBatch('D-GUARD-CANCELLED', 'approved', [
    ticket('T-1', 'cancelled', {
      finishedAt: 1763380000000,
      report: { turn: 1, status: 'cancelled', text: '上一轮的正文' },
    }),
  ]))
  const before = readFileSync(pathOf(batch), 'utf8')
  const dispatcher = fakeDispatcher()

  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: batch.id,
    ticketId: 'T-1',
  })

  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'ticket-terminal')
  assert.match(result.body.error, /cancelled/)

  // 拒绝不能留任何副作用：不写台账、不发消息。
  assert.equal(readFileSync(pathOf(batch), 'utf8'), before)
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal(dispatcher.spawnCalls.length, 0)
  const after = await load(batch.id)
  assert.equal(after.tickets[0].status, 'cancelled')
  assert.equal(after.tickets[0].finishedAt, 1763380000000)
})

test('done / failed / partial / needs_review / no_receipt / receipt_unverified / interrupted / 两种中断 默认同样被拒（ticket-terminal），台账与 dispatcher 都没动', async () => {
  freshHome('other-terminal')
  const cases = [
    ['T-DONE', 'done'],
    ['T-FAILED', 'failed'],
    ['T-PARTIAL', 'partial'],
    ['T-NEEDS-REVIEW', 'needs_review'],
    ['T-NO-RECEIPT', 'no_receipt'],
    ['T-UNVERIFIED', 'receipt_unverified'],
    ['T-INTERRUPTED', 'interrupted'],
    ['T-USER-STOP', 'user_interrupted'],
    ['T-LEAD-STOP', 'lead_interrupted'],
  ]
  const batch = writeFixture(makeBatch('D-GUARD-TERMINAL', 'approved',
    cases.map(([id, status]) => ticket(id, status, { finishedAt: 1 }))))

  const before = readFileSync(pathOf(batch), 'utf8')
  const dispatcher = fakeDispatcher()

  for (const [ticketId, status] of cases) {
    const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
      batchId: batch.id,
      ticketId,
    })
    assert.equal(result.status, 409, status + ' 应该被拒')
    assert.equal(result.body.code, 'ticket-terminal', status)
  }

  assert.equal(readFileSync(pathOf(batch), 'utf8'), before)
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal(dispatcher.spawnCalls.length, 0)
})

test('force: true 允许重跑：清掉旧 report / finishedAt，写 rerunAt / rerunFrom', async () => {
  freshHome('force')
  const batch = writeFixture(makeBatch('D-GUARD-FORCE', 'approved', [
    ticket('T-1', 'cancelled', {
      finishedAt: 1763380000000,
      launchError: '上一轮留下的错',
      // 取消时停在「请确认」上的票会把 waiting 留在台账里：不清掉的话，
      // observer 的结算守卫会以为它还在等用户，新一轮的回传就被丢了。
      waiting: { question: '选 A 还是 B？', sessionId: 'child-T-1' },
      report: { turn: 1, status: 'cancelled', text: '上一轮的正文' },
    }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: batch.id,
    ticketId: 'T-1',
    force: true,
  })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.status, 'running')
  assert.equal(result.body.rerun, true)
  assert.equal(result.body.rerunFrom, 'cancelled')

  assert.equal(dispatcher.runCalls.length, 1)
  assert.equal(dispatcher.runCalls[0].sessionId, 'child-T-1')

  const after = (await load(batch.id)).tickets[0]
  assert.equal(after.status, 'running')
  assert.equal(typeof after.startedAt, 'number')
  // 上一轮的产出与结束时间不能再挂着：否则面板一边「运行中」、一边显示旧回传。
  assert.equal(after.report, undefined)
  assert.equal(after.finishedAt, undefined)
  assert.equal(after.launchError, undefined)
  assert.equal(after.waiting, undefined)
  assert.equal(typeof after.rerunAt, 'number')
  assert.equal(after.rerunFrom, 'cancelled')
})

test('suspended / queued 票正常开跑（不写 rerun 字段）', async () => {
  freshHome('runnable')
  const suspended = writeFixture(makeBatch('D-GUARD-SUSPENDED', 'approved', [
    ticket('T-1', 'suspended'),
  ]))
  const queued = writeFixture(makeBatch('D-GUARD-QUEUED', 'approved', [
    ticket('T-2', 'queued'),
  ]))
  const dispatcher = fakeDispatcher()

  const first = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: suspended.id,
    ticketId: 'T-1',
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.status, 'running')
  assert.equal(first.body.rerun, undefined)

  const second = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: queued.id,
    ticketId: 'T-2',
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.status, 'running')

  assert.deepEqual(dispatcher.runCalls.map((row) => row.sessionId), ['child-T-1', 'child-T-2'])
  const afterSuspended = (await load(suspended.id)).tickets[0]
  assert.equal(afterSuspended.status, 'running')
  assert.equal(afterSuspended.rerunFrom, undefined)
  const afterQueued = (await load(queued.id)).tickets[0]
  assert.equal(afterQueued.status, 'running')
})

test('waiting 票不能点执行（ticket-not-runnable）；它走 /answer', async () => {
  freshHome('waiting')
  const batch = writeFixture(makeBatch('D-GUARD-WAITING', 'approved', [
    ticket('T-1', 'waiting', {
      waiting: { question: '选 A 还是 B？', sessionId: 'child-T-1' },
    }),
  ]))
  const dispatcher = fakeDispatcher()

  const result = await callRoute(facesWith(dispatcher), API_PREFIX + '/run', {
    batchId: batch.id,
    ticketId: 'T-1',
  })

  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'ticket-not-runnable')
  assert.equal(dispatcher.runCalls.length, 0)
  assert.equal((await load(batch.id)).tickets[0].status, 'waiting')
})

test('/state：批次按 createdAt 降序（最新在最上面），面板不再重复排序', async () => {
  freshHome('order')
  const oldest = writeFixture(makeBatch('D-ORDER-OLDEST', 'approved', [], { createdAt: 1000 }))
  const newest = writeFixture(makeBatch('D-ORDER-NEWEST', 'grilling', [], { createdAt: 3000 }))
  const middle = writeFixture(makeBatch('D-ORDER-MIDDLE', 'converged', [], { createdAt: 2000 }))

  const result = await callRoute(facesWith(fakeDispatcher()), API_PREFIX + '/state')

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  // 三个不同 createdAt：必须是新的在上。这是「误点旧批次」的第一道防线。
  assert.deepEqual(
    result.body.batches.map((row) => row.id),
    [newest.id, middle.id, oldest.id],
  )
  assert.deepEqual(
    result.body.batches.map((row) => row.createdAt),
    [3000, 2000, 1000],
  )
})

test('/state：closed 只给「批准过 + 每张票都是终态」的批次（面板据此折叠置灰）', async () => {
  freshHome('closed')
  const allDone = writeFixture(makeBatch('D-CLOSED-ALL-DONE', 'approved', [
    ticket('T-1', 'done'),
    ticket('T-2', 'cancelled'),
  ], { createdAt: 100 }))
  const stillRunning = writeFixture(makeBatch('D-CLOSED-RUNNING', 'approved', [
    ticket('T-1', 'running'),
  ], { createdAt: 200 }))
  const notApproved = writeFixture(makeBatch('D-CLOSED-CONVERGED', 'converged', [
    ticket('T-1', 'draft'),
  ], { createdAt: 300 }))
  const empty = writeFixture(makeBatch('D-CLOSED-EMPTY', 'approved', [], { createdAt: 400 }))

  const result = await callRoute(facesWith(fakeDispatcher()), API_PREFIX + '/state')
  const byId = new Map(result.body.batches.map((row) => [row.id, row]))

  // 批次自己没有结束状态（批准后一直是 approved），所以宿主得从票上算。
  assert.equal(byId.get(allDone.id).closed, true)
  assert.equal(byId.get(stillRunning.id).closed, false)
  assert.equal(byId.get(notApproved.id).closed, false)
  assert.equal(byId.get(empty.id).closed, false)
  // 顺带守住每行都带创建时间：面板卡片要显示它。
  assert.equal(byId.get(allDone.id).createdAt, 100)
})

test('/approve 时启动失败 → queued + launchError（不是 draft），不会自动重试；显式重试才启动', async () => {
  freshHome('approve-retry')
  const batch = writeFixture(makeBatch('D-GUARD-APPROVE-RETRY', 'converged', [
    draftTicket('T-1'),
    draftTicket('T-2'),
    draftTicket('T-3'),
  ]))
  const failing = fakeDispatcher({ failSpawnFor: ['T-2'] })

  const approved = await callRoute(facesWith(failing), API_PREFIX + '/approve', {
    batchId: batch.id,
    expectedRevision: batch.revision,
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.ok, true)
  assert.deepEqual([...approved.body.launched].sort(), ['T-1', 'T-3'])
  assert.deepEqual(approved.body.failed.map((row) => row.ticketId), ['T-2'])

  // 批准当下只 spawn 3 次（T-1 / T-2 / T-3）：失败票不在同一次请求里复活。
  assert.deepEqual(failing.spawnCalls.map((row) => row.ticketId), ['T-1', 'T-2', 'T-3'])
  // 启动失败会立刻给主会话报一条信封。
  assert.equal(failing.runCalls.filter((row) => row.sessionId === 'session-parent').length, 1)

  const afterApprove = await load(batch.id)
  const byId = new Map(afterApprove.tickets.map((row) => [row.id, row]))
  // 关键：queued 而不是 draft。批次已 approved，design_split 被锁死，
  // draft 票会永远没人再看它一眼。
  assert.equal(byId.get('T-2').status, 'queued')
  assert.match(byId.get('T-2').launchError, /起不来：T-2/)
  assert.equal(byId.get('T-2').launchFailureCode, 'LAUNCH_FAILED')
  assert.equal(byId.get('T-2').childSessionId, undefined)
  assert.equal(byId.get('T-1').status, 'running')
  assert.equal(byId.get('T-3').status, 'running')

  // 自动求值不会再启动它：launchError 是「别自动重试」的标记。
  const healthy = fakeDispatcher()
  const relayed = await relayBatch(facesWith(healthy), batch.id)
  assert.deepEqual(relayed.started, [])
  assert.deepEqual(healthy.spawnCalls, [])

  // 显式重试（面板 /retry 或 middleman_retry）才清标记、再启动。
  const retried = await callRoute(facesWith(healthy), API_PREFIX + '/retry', {
    batchId: batch.id,
    ticketId: 'T-2',
  })
  assert.equal(retried.status, 200)
  assert.equal(retried.body.ok, true)
  assert.deepEqual(healthy.spawnCalls.map((row) => row.ticketId), ['T-2'])

  const afterRetry = (await load(batch.id)).tickets.find((row) => row.id === 'T-2')
  assert.equal(afterRetry.status, 'running')
  assert.equal(afterRetry.childSessionId, 'child-T-2')
  assert.equal(afterRetry.launchError, undefined)
  assert.equal(afterRetry.launchFailureCode, undefined)
  assert.equal(afterRetry.blockedState, undefined)
})
