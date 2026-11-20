/**
 * 换主会话后回传不能断（I-11）。
 *
 * 旧实现只能手改台账的 `parentSessionId`：交接会话结束、新主会话接手后，
 * 回传信封仍然发给旧会话，新主会话永远收不到。补一个工具入口，并守住
 * 两条不能松的边：子会话不能给自己改收件人；目标会话不能是别的子会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-reparent-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { buildTools } = await import('../lib/tools.js')
const { load } = await import('../lib/ledger.js')

const batch = {
  id: 'D-REPARENT-1',
  title: '换主会话',
  status: 'approved',
  revision: 0,
  decisions: [],
  questions: [],
  risks: [],
  tickets: [{
    id: 'T-1',
    title: '实施',
    brief: '做',
    status: 'running',
    childSessionId: 'child-T-1',
    riskIds: [],
    riskFree: true,
    riskFreeReason: '夹具',
    model: { provider: 'p', model: 'm' },
    modelReason: '夹具',
    blockedBy: [],
  }],
  parentSessionId: 'session-old',
}
writeFileSync(join(HOME, 'designs', batch.id + '.json'), JSON.stringify(batch, null, 2) + '\n')

/** 子会话映射：只有 T-1 的子会话与另一个批次的子会话。 */
const otherBatch = {
  id: 'D-REPARENT-2',
  title: '另一个批次',
  status: 'approved',
  revision: 0,
  decisions: [],
  questions: [],
  risks: [],
  tickets: [{ id: 'T-9', title: '别的活', status: 'running', childSessionId: 'child-other' }],
  parentSessionId: 'session-someone',
}
writeFileSync(join(HOME, 'designs', otherBatch.id + '.json'), JSON.stringify(otherBatch, null, 2) + '\n')

function faces() {
  return {
    dispatcher: { async run() {}, async tail() { return [] } },
    warn: () => {},
    testFiles: async () => [],
    confirmations: {
      find: async (sessionId) => {
        if (sessionId === 'child-T-1') return { batch, ticket: batch.tickets[0] }
        if (sessionId === 'child-other') return { batch: otherBatch, ticket: otherBatch.tickets[0] }
        return undefined
      },
    },
  }
}

function reparentTool() {
  return buildTools(faces()).find((tool) => tool.name === 'middleman_reparent')
}

function execAs(sessionId) {
  return { agent: { session: { id: sessionId } } }
}

test('主会话认领：parentSessionId 改到当前会话，并写审计', async () => {
  const result = await reparentTool().execute(
    { batchId: batch.id, reason: '交接：旧会话结束了' },
    execAs('session-new'),
  )
  assert.equal(result.ok, true)
  assert.equal(result.parentSessionId, 'session-new')
  assert.equal(result.changed, true)
  assert.equal(result.previousSessionId, 'session-old')

  const after = await load(batch.id)
  assert.equal(after.parentSessionId, 'session-new')
  assert.equal(after.reparents.length, 1)
  assert.equal(after.reparents[0].from, 'session-old')
  assert.equal(after.reparents[0].to, 'session-new')
  assert.equal(after.reparents[0].reason, '交接：旧会话结束了')
})

test('重复认领是幂等的：不重复写审计', async () => {
  const result = await reparentTool().execute({ batchId: batch.id }, execAs('session-new'))
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  const after = await load(batch.id)
  assert.equal(after.reparents.length, 1)
})

test('子会话不能给自己改收件人', async () => {
  const before = JSON.stringify(await load(batch.id))
  const result = await reparentTool().execute({ batchId: batch.id }, execAs('child-T-1'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-a-lead')
  assert.equal(JSON.stringify(await load(batch.id)), before, '拒绝时一个字节都不写')
})

test('不能把回传改绑到另一个子会话', async () => {
  const result = await reparentTool().execute(
    { batchId: batch.id, sessionId: 'child-other' },
    execAs('session-lead'),
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-a-lead')
})

test('显式指定别的主会话 id 可以改绑', async () => {
  const result = await reparentTool().execute(
    { batchId: batch.id, sessionId: 'session-handed-off' },
    execAs('session-lead'),
  )
  assert.equal(result.ok, true)
  assert.equal(result.parentSessionId, 'session-handed-off')
  const after = await load(batch.id)
  assert.equal(after.parentSessionId, 'session-handed-off')
})
