/**
 * P1 客户端半区回归：批准卡 / 收件箱卡 / 面板依赖视图的判断层。
 *
 * 跑：<runtime node> test/p1-client.test.mjs
 *
 * 这里只测纯函数（lib/card-model.js）。真实渲染依赖宿主与浏览器，必须
 * 重启后人工核对——单测绿了不代表卡片真的挂到了对话流里，也不代表
 * 面板上的依赖摘要真的画出来了。
 *
 * 为什么不用 `node --test`：沙箱下测试运行器会给每个文件起子进程，
 * 本机复现过 EPERM（与 test/p1-host.test.mjs 同口径）。直接执行这个文件，
 * node:test 照样把测试跑完，失败时退出码同样非 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchView, inboxView, dependencyView } from '../lib/card-model.js'

/** 一个已收敛、票是草稿的批次：批准卡最常看到的样子。 */
function draftBatch(overrides = {}) {
  return {
    id: 'D-P1-CLIENT',
    title: 'P1 客户端测试批次',
    status: 'converged',
    revision: 3,
    risks: [
      { id: 'R-1', title: 'R1' },
      { id: 'R-2', title: 'R2' },
    ],
    spec: { goal: '在对话里批准并开跑', acceptance: ['a1', 'a2', 'a3'] },
    tickets: [
      {
        id: 'T-1',
        title: '实施',
        status: 'draft',
        model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      },
      {
        id: 'T-2',
        title: '验证',
        status: 'draft',
        model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
        blockedBy: ['T-1'],
      },
    ],
    ...overrides,
  }
}

test('batchView：converged + 草稿票 → 只有「批准并开跑」，四行摘要齐全', () => {
  const view = batchView(draftBatch())

  assert.equal(view.kind, 'ready')
  assert.equal(view.status, 'converged')
  assert.equal(view.title, 'P1 客户端测试批次')
  assert.deepEqual(view.buttons, [{ kind: 'approve', label: '批准并开跑' }])

  // 四行：目标 / 验收条数 / 风险条数 / 票与模型。
  assert.deepEqual(view.fields.map(([label]) => label), ['目标', '验收', '风险', '票与模型'])
  assert.equal(view.fields[0][1], '在对话里批准并开跑')
  assert.equal(view.fields[1][1], '3 条')
  assert.equal(view.fields[2][1], '2 条')
  // 两张票钉同一个模型：只写一次。
  assert.equal(view.fields[3][1], '2 张 · p/m')
  assert.match(view.note, /批准/)
})

test('batchView：converged 但还没拆票 → 不给批准按钮（空批次批准后拆不了票）', () => {
  const view = batchView(draftBatch({ tickets: [] }))

  assert.deepEqual(view.buttons, [])
  assert.equal(view.fields[3][1], '还没有票')
  assert.match(view.note, /拆票中/)
})

test('batchView：approved → 没有动作按钮，只显示「已批准 · 已开跑」', () => {
  const view = batchView(draftBatch({
    status: 'approved',
    tickets: [
      { id: 'T-1', title: '实施', status: 'running', model: { provider: 'p', model: 'm' } },
      { id: 'T-2', title: '验证', status: 'queued', model: { provider: 'p', model: 'm' } },
    ],
  }))

  assert.deepEqual(view.buttons, [])
  assert.equal(view.note, '已批准 · 已开跑')
  // 票照旧列出来，人能看见谁在跑、谁在等前序。
  assert.deepEqual(view.tickets.map((ticket) => ticket.status), ['running', 'queued'])
})

test('batchView：票启动失败 → 标红并带上原因（失败票是 queued，不是 draft）', () => {
  const view = batchView(draftBatch({
    status: 'approved',
    tickets: [
      { id: 'T-1', title: '实施', status: 'running', model: { provider: 'p', model: 'm' } },
      {
        id: 'T-2',
        title: '验证',
        status: 'queued',
        launchError: '模型钉不上：容量不足',
        model: { provider: 'p', model: 'm' },
      },
    ],
  }))

  assert.equal(view.failures.length, 1)
  assert.equal(view.failures[0].ticketId, 'T-2')
  assert.match(view.failures[0].launchError, /容量不足/)

  const failed = view.tickets.find((ticket) => ticket.ticketId === 'T-2')
  assert.equal(failed.color, '#dc2626')
  const ok = view.tickets.find((ticket) => ticket.ticketId === 'T-1')
  assert.notEqual(ok.color, '#dc2626')
})

test('inboxView：waiting 票的选项各是一个回答按钮', () => {
  const batch = draftBatch({
    status: 'approved',
    tickets: [
      {
        id: 'T-1',
        title: '实施',
        status: 'waiting',
        waiting: {
          question: '选 A 还是 B？',
          options: ['A', 'B'],
          recommendation: '选 A，因为改动面小',
          askedAt: 1,
          sessionId: 'child-T-1',
        },
      },
      { id: 'T-2', title: '验证', status: 'running' },
    ],
  })

  const view = inboxView(batch)
  assert.equal(view.kind, 'ready')
  assert.equal(view.count, 1)
  assert.deepEqual(view.items.map((item) => item.ticketId), ['T-1'])

  const item = view.items[0]
  assert.equal(item.question, '选 A 还是 B？')
  assert.equal(item.recommendation, '选 A，因为改动面小')
  assert.deepEqual(item.buttons, [
    { kind: 'answer', label: 'A', answer: 'A' },
    { kind: 'answer', label: 'B', answer: 'B' },
  ])
})

test('inboxView：没有 waiting 票 → 空列表 + 一句说明', () => {
  const view = inboxView(draftBatch({ status: 'approved' }))

  assert.equal(view.count, 0)
  assert.deepEqual(view.items, [])
  assert.match(view.note, /没有票/)
})

test('两个视图对坏输入都不抛错（宿主换形状时卡片给占位，不白屏）', () => {
  for (const bad of [undefined, null, 42, 'x', {}, { tickets: 'nope' }, { spec: null, risks: null }]) {
    assert.doesNotThrow(() => batchView(bad))
    assert.doesNotThrow(() => inboxView(bad))
  }
})

// ── 面板依赖视图（T-5） ────────────────────────────────────────────
//
// blockedState 由 T-3 写进台账，形状是
// { evaluatedAt, blockers: [{id, title, status, satisfied, missing?}], allSatisfied }。
// 面板要把它摊成一行能读的摘要，并且把 launchError / 原始 blockedState
// 收进默认折叠的 debug 区。

/** 固定「现在」，让年龄断言不随运行时间漂移。 */
const NOW = Date.UTC(2026, 10, 17, 13, 0, 0)

/** 一张 queued 票的依赖数据。 */
function queuedTicket(overrides = {}) {
  return {
    id: 'T-3',
    title: '面板 debug 视图',
    status: 'queued',
    blockedBy: ['T-1', 'T-2'],
    ...overrides,
  }
}

test('dependencyView：有 blockedState → 满足打勾、未满足标红并带状态', () => {
  const view = dependencyView(queuedTicket({
    blockedState: {
      evaluatedAt: NOW - 3 * 60 * 1000,
      allSatisfied: false,
      blockers: [
        { id: 'T-1', title: '实施', status: 'done', satisfied: true },
        { id: 'T-2', title: '验证', status: 'failed', satisfied: false },
      ],
    },
  }), NOW)

  assert.equal(view.kind, 'ready')
  assert.equal(view.queued, true)
  assert.equal(view.hasBlockedState, true)
  assert.equal(view.allSatisfied, false)
  // 相对年龄，不是原始毫秒：「3 分钟前评估」能区分「没更新」和「真没动」。
  assert.equal(view.ageLabel, '3 分钟前评估')

  assert.equal(view.blockers[0].label, '✓ T-1 done')
  assert.equal(view.blockers[0].color, '#16a34a')
  assert.equal(view.blockers[1].label, '✗ T-2 failed')
  assert.equal(view.blockers[1].color, '#dc2626')
  assert.equal(view.summary, '✓ T-1 done · ✗ T-2 failed')
})

test('dependencyView：没有 blockedState → 平稳降级为「无依赖数据」，不报错', () => {
  // 老台账的 queued 票：T-3 还没把 blockedState 写进台账时的形状。
  const view = dependencyView(queuedTicket(), NOW)

  assert.equal(view.kind, 'ready')
  assert.equal(view.queued, true)
  assert.equal(view.hasBlockedState, false)
  assert.equal(view.summary, '无依赖数据')
  assert.equal(view.ageLabel, undefined)
  assert.deepEqual(view.blockers, [])
  assert.equal(view.hasDebug, false)
  assert.doesNotThrow(() => JSON.stringify(view))
})

test('dependencyView：部分满足 → allSatisfied=false，running/partial 都不算满足', () => {
  const view = dependencyView(queuedTicket({
    blockedState: {
      evaluatedAt: NOW - 2 * 60 * 60 * 1000,
      allSatisfied: false,
      blockers: [
        { id: 'T-1', title: '实施', status: 'done', satisfied: true },
        { id: 'T-2', title: '验证', status: 'running', satisfied: false },
        // 2026-11-18 起 partial 也不满足依赖（只有 done 自动解锁）。
        { id: 'T-3', title: '复核', status: 'partial', satisfied: false },
      ],
    },
  }), NOW)

  assert.equal(view.allSatisfied, false)
  assert.equal(view.ageLabel, '2 小时前评估')
  assert.deepEqual(view.blockers.map((blocker) => blocker.satisfied), [true, false, false])
  assert.deepEqual(view.blockers.map((blocker) => blocker.label), [
    '✓ T-1 done',
    '✗ T-2 running',
    '✗ T-3 partial',
  ])
  assert.equal(view.summary, '✓ T-1 done · ✗ T-2 running · ✗ T-3 partial')
})

test('dependencyView：missing 前序 → 单独提示，不混进「失败」', () => {
  const view = dependencyView(queuedTicket({
    blockedState: {
      evaluatedAt: NOW - 10 * 1000,
      allSatisfied: false,
      blockers: [
        { id: 'T-1', title: '实施', status: 'done', satisfied: true },
        { id: 'GONE', title: '(不存在的工单)', status: 'missing', satisfied: false, missing: true },
      ],
    },
  }), NOW)

  assert.equal(view.ageLabel, '刚刚评估')
  assert.deepEqual(view.missing.map((blocker) => blocker.id), ['GONE'])
  assert.equal(view.blockers[1].missing, true)
  assert.equal(view.blockers[1].label, '⚠ GONE 不在台账')
  assert.match(view.missingNote, /GONE/)
  // missing 不写进「已满足 / 卡在谁」的正常摘要，避免被当成失败前序。
  assert.equal(view.summary, '✓ T-1 done')
})

test('dependencyView：launchError 收进可折叠 debug，不混进依赖摘要', () => {
  const noState = dependencyView(queuedTicket({
    launchError: '模型钉不上：容量不足',
  }), NOW)
  assert.equal(noState.hasDebug, true)
  assert.equal(noState.debugSummary, '调试信息：启动失败')
  assert.equal(noState.launchError, '模型钉不上：容量不足')
  // debug 内容不污染主摘要：没有 blockedState 仍然是「无依赖数据」。
  assert.equal(noState.summary, '无依赖数据')

  const withState = dependencyView(queuedTicket({
    launchError: '起不来：T-3',
    blockedState: {
      evaluatedAt: NOW - 60 * 1000,
      allSatisfied: true,
      blockers: [{ id: 'T-1', title: '实施', status: 'done', satisfied: true }],
    },
  }), NOW)
  assert.equal(withState.debugSummary, '调试信息：启动失败 · 依赖状态')
  assert.equal(withState.ageLabel, '1 分钟前评估')
  // 原始 blockedState 交给面板折叠区展示（JSON），这里只确认数据没丢。
  assert.equal(withState.blockedState.allSatisfied, true)
})

test('dependencyView：非 queued 票不出依赖行；坏输入不抛错', () => {
  const running = dependencyView({ id: 'T-1', status: 'running' }, NOW)
  assert.equal(running.queued, false)
  assert.equal(running.summary, undefined)

  for (const bad of [undefined, null, 42, 'x']) {
    assert.doesNotThrow(() => dependencyView(bad, NOW))
  }
  // blockedState 形状写坏（没有 blockers 数组）也当没数据，不崩。
  const broken = dependencyView(queuedTicket({ blockedState: { evaluatedAt: NOW } }), NOW)
  assert.equal(broken.summary, '无依赖数据')
  assert.deepEqual(broken.blockers, [])
})
