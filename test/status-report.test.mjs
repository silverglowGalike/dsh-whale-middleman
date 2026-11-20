/**
 * 回传信封指向的「取正文」必须真的拿得到正文。
 *
 * 现场撞到过：信封写「正文用 middleman_status 取」，而那个工具只返回状态，
 * 没有正文——模型只能去读 json 文件，正好是信封机制想避免的事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-status-'))
process.env.WT_HOME = HOME
mkdirSync(join(HOME, 'designs'), { recursive: true })

const { buildTools } = await import('../lib/tools.js')

const batch = {
  id: 'D-STATUS-1',
  title: '取正文',
  status: 'approved',
  revision: 3,
  updatedAt: 1700000000000,
  decisions: [],
  questions: [],
  risks: [],
  tickets: [{
    id: 'T-1',
    title: '实施',
    status: 'done',
    blockedBy: [],
    report: {
      turn: 2,
      status: 'done',
      note: '',
      settledAt: 1700000001000,
      deliveredAt: 1700000002000,
      text: '这是子会话的完整答复正文',
      summary: { files: ['a.js'], commands: [] },
    },
  }, {
    id: 'T-2',
    title: '干扰项：它的大正文不该出现在点名的响应里',
    status: 'done',
    blockedBy: ['T-1'],
    report: {
      turn: 1,
      status: 'done',
      note: '',
      settledAt: 1700000003000,
      text: 'X'.repeat(6000),
      summary: { files: [], commands: [] },
    },
  }],
}
writeFileSync(join(HOME, 'designs', 'D-STATUS-1.json'), JSON.stringify(batch, null, 2))

const statusTool = buildTools({ dispatcher: {}, confirmations: { find: async () => undefined }, testFiles: async () => [], warn: () => {} })
  .find((tool) => tool.name === 'middleman_status')

test('middleman_status：不点名时给指针，不给正文', async () => {
  const result = await statusTool.execute({ batchId: 'D-STATUS-1' })
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'batch')
  const ticket = result.tickets[0]
  assert.equal(ticket.report.turn, 2)
  assert.equal(ticket.report.deliveredAt, 1700000002000)
  assert.equal(ticket.reportBody, undefined)
})

test('middleman_status：点名 ticketId 时只回那一张票的投影', async () => {
  const result = await statusTool.execute({ batchId: 'D-STATUS-1', ticketId: 'T-1' })
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'ticket')
  assert.equal(result.ticket.reportBody.text, '这是子会话的完整答复正文')
  assert.deepEqual(result.ticket.reportBody.summary.files, ['a.js'])
  // 整批的票列表、风险、前沿都不该跟过来——这正是 I-06 的毛病。
  assert.equal(result.tickets, undefined)
  assert.equal(result.risks, undefined)
  assert.equal(result.frontier, undefined)
  assert.equal(JSON.stringify(result).includes('干扰项'), false)
})

test('middleman_status：点名不存在的票给明确拒绝，而不是空数组', async () => {
  const result = await statusTool.execute({ batchId: 'D-STATUS-1', ticketId: 'T-9' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ticket-missing')
})
