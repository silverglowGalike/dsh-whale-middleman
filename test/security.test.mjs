/**
 * 安全回归：批次 id 的路径穿越、写操作的 CSRF 闸、请求体形状。
 *
 * 跑：node test/security.test.mjs
 *
 * 这些用例守的是「本机围栏之外还差的那一层」：
 * - 环回连接的恶意页面可以发 text/plain 的简单 POST（不触发预检），
 *   所以 POST 必须要求 application/json，且 Origin 必须与 Host 同源；
 * - batchId 会被拼进台账路径，必须挡住 `..` / 分隔符 / 盘符。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 台账之前指到临时目录，否则会写到 ~/.dsh 下的真台账。
const HOME = mkdtempSync(join(tmpdir(), 'wt-sec-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { makeRoutes, API_PREFIX, isSameOrigin, isLoopback, isLoopbackHost } = await import('../lib/routes.js')
const { load, isValidBatchId } = await import('../lib/ledger.js')
const { buildTools } = await import('../lib/tools.js')

/** 一张可执行、可重复读写的票。 */
function fixture(id) {
  return {
    id,
    title: '安全测试批次',
    createdAt: Date.now(),
    status: 'approved',
    revision: 0,
    decisions: [],
    questions: [],
    risks: [],
    tickets: [{
      id: 'T-1',
      title: 'T-1 标题',
      brief: 'T-1 任务书',
      status: 'suspended',
      childSessionId: 'child-1',
      model: { provider: 'p', model: 'm' },
    }],
    parentSessionId: 'parent-1',
  }
}

function writeFixture(batch) {
  writeFileSync(join(HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2) + '\n')
}

/** 一个只记调用、绝不建会话的 dispatcher。 */
function fakeDispatcher() {
  const calls = { run: 0, spawn: 0 }
  return {
    calls,
    async run() { calls.run += 1 },
    async spawn() { calls.spawn += 1; return { sessionId: 'child-x' } },
  }
}

/** 走真正的路由 handler，造一个最小 req/res。 */
async function callRoute(faces, path, options = {}) {
  const method = options.method ?? 'POST'
  const headers = {
    ...(method === 'POST' ? { 'content-type': 'application/json', host: '127.0.0.1:53827' } : {}),
    ...(options.headers ?? {}),
  }
  const req = {
    url: options.url ?? path,
    method,
    headers,
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body), 'utf8')
    },
  }
  let status = 0
  let raw = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk !== undefined) raw += String(chunk) },
  }
  const route = makeRoutes(faces).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, '找不到路由 ' + path)
  await route.handler(req, res)
  return { status, body: raw === '' ? undefined : JSON.parse(raw) }
}

test('批次 id 只接受字母数字下划线短横线', () => {
  assert.equal(isValidBatchId('D-20261120-abcd'), true)
  assert.equal(isValidBatchId('batch_1'), true)
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'C:\\x', '.hidden', 'a b', 'a.b', null, 42]) {
    assert.equal(isValidBatchId(bad), false, '不该接受：' + String(bad))
  }
})

test('load：id 带 .. 或分隔符时拒绝，不会读到台账目录之外', async () => {
  for (const bad of ['../secret', '..\\..\\secret', 'C:\\Windows\\win.ini', 'a/b']) {
    await assert.rejects(load(bad), (error) => error.code === 'invalid-request', '该拒绝：' + bad)
  }
})

test('路由：非环回连接 403', async () => {
  const batch = fixture('D-20261120-sec1')
  writeFixture(batch)
  const dispatcher = fakeDispatcher()
  const result = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/run', {
    address: '10.0.0.7',
    body: { batchId: batch.id, ticketId: 'T-1' },
  })
  assert.equal(result.status, 403)
  assert.equal(dispatcher.calls.run, 0)
})

test('路由：text/plain 的 POST 被拒（CSRF），且不产生副作用', async () => {
  const batch = fixture('D-20261120-sec2')
  writeFixture(batch)
  const dispatcher = fakeDispatcher()
  const result = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/run', {
    headers: { 'content-type': 'text/plain' },
    body: { batchId: batch.id, ticketId: 'T-1', force: true },
  })
  assert.equal(result.status, 415)
  assert.equal(result.body.code, 'unsupported-media-type')
  assert.equal(dispatcher.calls.run, 0)
})

test('路由：跨站 Origin 被拒，同源 Origin 放行', async () => {
  const batch = fixture('D-20261120-sec3')
  writeFixture(batch)
  const dispatcher = fakeDispatcher()

  const evil = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/run', {
    headers: { origin: 'https://evil.example', host: '127.0.0.1:53827' },
    body: { batchId: batch.id, ticketId: 'T-1' },
  })
  assert.equal(evil.status, 403)
  assert.equal(dispatcher.calls.run, 0)

  const sameOrigin = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/run', {
    headers: { origin: 'http://127.0.0.1:53827', host: '127.0.0.1:53827' },
    body: { batchId: batch.id, ticketId: 'T-1' },
  })
  assert.equal(sameOrigin.status, 200)
  assert.equal(dispatcher.calls.run, 1)
})

test('路由：请求体不是 JSON 对象时 400', async () => {
  const result = await callRoute({ dispatcher: fakeDispatcher(), warn: () => {} }, API_PREFIX + '/run', {
    body: ['not', 'an', 'object'],
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid-request')
})

test('路由：/state?batchId=../.. 拒绝，不会把目录之外的 JSON 读出来', async () => {
  const result = await callRoute({ dispatcher: fakeDispatcher(), warn: () => {} }, API_PREFIX + '/state', {
    method: 'GET',
    url: API_PREFIX + '/state?batchId=' + encodeURIComponent('../../secret'),
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid-request')
})

test('路由：DNS rebinding（Origin=Host=恶意域名）被 Host 白名单拦住', async () => {
  const batch = fixture('D-20261120-sec4')
  writeFixture(batch)
  const dispatcher = fakeDispatcher()
  const result = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/run', {
    headers: { origin: 'http://evil.example:53827', host: 'evil.example:53827' },
    body: { batchId: batch.id, ticketId: 'T-1' },
  })
  assert.equal(result.status, 403)
  assert.equal(dispatcher.calls.run, 0)
})

test('路由：缺 Host 的写请求 403', async () => {
  const result = await callRoute({ dispatcher: fakeDispatcher(), warn: () => {} }, API_PREFIX + '/run', {
    headers: { host: '' },
    body: { batchId: 'D-20261120-sec5', ticketId: 'T-1' },
  })
  assert.equal(result.status, 403)
})

test('路由：/cancel 对终态票返回 409，不把 done 翻成 user_interrupted', async () => {
  const batch = fixture('D-20261120-sec6')
  batch.tickets[0].status = 'done'
  writeFixture(batch)
  const dispatcher = fakeDispatcher()
  const result = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/cancel', {
    body: { batchId: batch.id, ticketId: 'T-1' },
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'ticket-not-cancellable')
  const after = await load(batch.id)
  assert.equal(after.tickets[0].status, 'done')
})

test('路由：/approve 第二次点击是幂等的，不因旧 revision 回 409', async () => {
  const batch = fixture('D-20261120-sec7')
  batch.status = 'converged'
  batch.tickets[0].status = 'draft'
  batch.tickets[0].childSessionId = undefined
  writeFixture(batch)
  const dispatcher = fakeDispatcher()
  const first = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/approve', {
    body: { batchId: batch.id, expectedRevision: 0 },
  })
  assert.equal(first.status, 200)
  assert.equal(dispatcher.calls.run, 1)

  const second = await callRoute({ dispatcher, warn: () => {} }, API_PREFIX + '/approve', {
    body: { batchId: batch.id, expectedRevision: 0 },
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.alreadyApproved, true)
  assert.equal(dispatcher.calls.run, 1)
})

test('子会话不能调 design_open / rewire / rebind（改台账、绕开人批准）', async () => {
  const batch = fixture('D-20261120-sec8')
  writeFixture(batch)
  const faces = {
    dispatcher: fakeDispatcher(),
    warn: () => {},
    testFiles: async () => [],
    confirmations: {
      find: async (sessionId) => (sessionId === 'child-1' ? { batch, ticket: batch.tickets[0] } : undefined),
    },
  }
  const tools = buildTools(faces)
  const exec = { agent: { session: { id: 'child-1' } } }
  const cases = [
    ['design_open', { title: 'x' }],
    ['middleman_rewire', { batchId: batch.id, ticketId: 'T-1', blockedBy: [] }],
    ['middleman_rebind', { batchId: batch.id, ticketId: 'T-1', sessionId: 'child-2' }],
  ]
  for (const [name, args] of cases) {
    const definition = tools.find((candidate) => candidate.name === name)
    assert.ok(definition !== undefined, '找不到工具 ' + name)
    const result = await definition.execute(args, exec)
    assert.equal(result.ok, false, name + ' 不该让子会话通过')
    assert.equal(result.code, 'not-a-lead', name + ' 应以 not-a-lead 拒绝')
  }
})

test('isSameOrigin / isLoopback / isLoopbackHost 的口径', () => {
  assert.equal(isSameOrigin('http://127.0.0.1:53827', '127.0.0.1:53827'), true)
  assert.equal(isSameOrigin('https://evil.example', '127.0.0.1:53827'), false)
  assert.equal(isSameOrigin('not a url', '127.0.0.1:53827'), false)
  assert.equal(isSameOrigin('', ''), false)
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('10.0.0.7'), false)
  assert.equal(isLoopback(undefined), false)
  assert.equal(isLoopbackHost('127.0.0.1:53827'), true)
  assert.equal(isLoopbackHost('localhost:53827'), true)
  assert.equal(isLoopbackHost('[::1]:53827'), true)
  assert.equal(isLoopbackHost('evil.example:53827'), false)
  assert.equal(isLoopbackHost('127.0.0.1.evil.example:53827'), false)
  assert.equal(isLoopbackHost(''), false)
  assert.equal(isLoopbackHost(undefined), false)
})
