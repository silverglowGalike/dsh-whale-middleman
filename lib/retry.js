/**
 * 重试：把一张没跑成的票重新送进子会话，或清掉启动失败标记让求值再启动一次。
 *
 * 为什么需要（I-04）：启动失败后票停在 queued、带 `launchError`，而
 * `/run` 要求已有会话、`middleman_rewire` 只改依赖——工具面没有恢复入口，
 * 只能手改台账。而「子会话的活是主会话拆的」，让主会话自己修简单报错，
 * 比让用户去 debug 快得多（用户定位）。
 *
 * 两条入口、一套机制：
 * - 模型：`middleman_retry`（主会话），受 `core.planLeadRetry` 约束；
 * - 用户：`POST /retry`（面板按钮），受 `core.planUserRetry` 约束。
 *
 * 额度规则见 `core.LEAD_ERROR_RETRY_LIMIT` 的注释：复核族不限、报错族 5 次、
 * 用户动手即还额度。启动失败按 `LAUNCH_FAILED` 记在报错族里。
 *
 * @module dsh-whale-middleman/retry
 */
import { load } from './ledger.js'
import { patchTicket } from './commit.js'
import {
  planLeadRetry, planUserRetry, RETRY_FAMILY, TICKET_STATUS,
} from './core.js'
import { buildBrief } from './dispatch.js'
import { relayBatch } from './observer.js'

/**
 * 把策略拒绝翻成调用方能读懂的形状。
 *
 * @param plan - planLeadRetry / planUserRetry 的结果。
 * @returns `{ ok: false, code, message, problems, retry }`。
 */
function refusalOf(plan) {
  return {
    ok: false,
    code: plan.refusalCode ?? 'retry-not-allowed',
    message: plan.problems.join('；'),
    problems: plan.problems,
    retry: { family: plan.family, code: plan.code, used: plan.used, limit: plan.limit },
  }
}

/** 回执里带的策略快照：用了哪族、什么码、还剩几次。 */
function summarize(plan, by) {
  return {
    by,
    family: plan.family,
    code: plan.code,
    used: plan.used,
    limit: plan.limit,
    ...(plan.family === RETRY_FAMILY.error && by === 'lead'
      ? { remaining: Math.max(0, (plan.limit ?? 0) - plan.used - 1) }
      : {}),
  }
}

/**
 * 记账 + 消耗额度。
 *
 * 额度按「同一错误码内累计」记：换了一个错误码就是换了一个问题，从新额度
 * 开始算。用户重试会把额度清掉——人是最终决策者。
 *
 * @param target - 最新读出的工单。
 * @param facts - `{ by, plan, at, mode, reason }`。
 */
function recordRetry(target, { by, plan, at, mode, reason, briefChanged }) {
  const used = by === 'lead' && plan.family === RETRY_FAMILY.error
    ? (plan.used ?? 0) + 1
    : undefined
  target.retries = [
    ...(Array.isArray(target.retries) ? target.retries : []),
    {
      at,
      by,
      mode,
      family: plan.family,
      code: plan.code,
      ...(used === undefined ? {} : { used }),
      ...(typeof reason === 'string' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
      ...(briefChanged === true ? { briefChanged: true } : {}),
    },
  ].slice(-20)
  if (used !== undefined) {
    target.leadRetries = { code: plan.code, used, at }
  } else if (by === 'user') {
    delete target.leadRetries
  }
}

/**
 * 重试一张票。
 *
 * `queued`（启动失败/依赖满足但没起来）：清 `launchError`（保留
 * `launchFailureCode` 作为报错族记账码），让 `relayBatch` 按最新台账重新求值启动。
 *
 * 其余可重试状态（failed / partial / needs_review / no_receipt /
 * receipt_unverified / lead_interrupted）：
 * 把任务书重发给已有子会话，票回 `running`；上一轮的 report、中断来源、
 * 传输宽限、`waiting` 一并清掉——它们属于上一轮，留着会让结算守卫误判。
 *
 * @param faces - 派发面（dispatcher / warn）。
 * @param options - `{ batchId, ticketId, by, reason?, now? }`。
 * @returns `{ ok: true, ... }` 或 `{ ok: false, code, message }`。
 */
export async function retryTicket(faces, options = {}) {
  const { batchId, ticketId, by = 'lead', reason } = options
  const now = typeof options.now === 'number' ? options.now : Date.now()
  // 可选：重试时换一份任务书，等于「重设计这张票」。
  //
  // 为什么允许：批准后 `design_split` 锁死，主会话改不了 brief；如果子会话
  // 自评 needs_review 的原因是「任务书写歪了」，只重跑同一份 brief 只会
  // 再错一次。这里让重试带上新 brief，写进 `retries` 审计（briefChanged），
  // 是主会话能动性的一部分，也仍然留痕。
  const brief = typeof options.brief === 'string' && options.brief.trim() !== ''
    ? options.brief.trim()
    : undefined
  if (typeof batchId !== 'string' || batchId === '') {
    return { ok: false, code: 'invalid-request', message: '必须带 batchId' }
  }
  if (typeof ticketId !== 'string' || ticketId === '') {
    return { ok: false, code: 'invalid-request', message: '必须带 ticketId' }
  }
  const batch = await load(batchId)
  if (batch.status !== 'approved') {
    return {
      ok: false,
      code: 'batch-not-approved',
      message: '批次还没批准（当前 ' + batch.status + '）：批准时该启动的票会自动开跑，不需要重试',
    }
  }
  const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
  const ticket = tickets.find((candidate) => candidate !== null && typeof candidate === 'object'
    && candidate.id === ticketId)
  if (ticket === undefined) {
    return { ok: false, code: 'ticket-missing', message: '没有这张工单：' + ticketId }
  }

  const pick = by === 'user' ? planUserRetry : planLeadRetry
  const initial = pick(ticket)
  if (!initial.allowed) return refusalOf(initial)

  // 启动失败：清掉「别自动重试」的标记，让这一次求值可以再试。
  // launchFailureCode 留着：它是报错族的记账码，要跨多次重试保持不变。
  if (ticket.status === TICKET_STATUS.queued) {
    const outcome = await patchTicket(batchId, ticketId, (target) => {
      const plan = pick(target)
      if (!plan.allowed) return { refuse: refusalOf(plan) }
      let briefChanged = false
      if (brief !== undefined && brief !== target.brief) {
        target.brief = brief
        briefChanged = true
      }
      delete target.launchError
      delete target.blockedState
      recordRetry(target, { by, plan, at: now, mode: 'launch', reason, briefChanged })
      return { result: summarize(plan, by) }
    })
    if (outcome.ok !== true) return outcome
    const relay = await relayBatch(faces, batchId)
    const started = relay.started.includes(ticketId)
    const failure = relay.failed.find((row) => row.ticketId === ticketId)
    return {
      ok: true,
      batchId,
      ticketId,
      status: started ? TICKET_STATUS.running : TICKET_STATUS.queued,
      retry: outcome.result,
      relay,
      ...(failure === undefined ? {} : { launchError: failure.error }),
      note: started
        ? '已清除启动失败标记并重新启动。'
        : failure !== undefined
          ? '这次启动仍然失败：' + failure.error
          : '已清除启动失败标记，但这次求值没有启动它：前置未完成，或又被判成不可启动（看 relay 与 blockedState）。',
    }
  }

  if (typeof ticket.childSessionId !== 'string' || ticket.childSessionId === '') {
    return {
      ok: false,
      code: 'no-session',
      message: '这张票没有子会话可重跑：让用户点「执行」，或重开一张票',
    }
  }

  // 重发任务书时用**新的** brief（如果这次重试带了重设计）。
  const effective = brief === undefined ? ticket : { ...ticket, brief }
  await faces.dispatcher.run(ticket.childSessionId, buildBrief(batch, effective))
  const outcome = await patchTicket(batchId, ticketId, (target) => {
    const plan = pick(target)
    if (!plan.allowed) return { refuse: refusalOf(plan) }
    let briefChanged = false
    if (brief !== undefined && brief !== target.brief) {
      target.brief = brief
      briefChanged = true
    }
    target.rerunAt = now
    target.rerunFrom = target.status
    delete target.report
    delete target.finishedAt
    delete target.launchError
    delete target.interruptedBy
    delete target.transportGrace
    delete target.blockedState
    delete target.waiting
    target.status = TICKET_STATUS.running
    target.startedAt = now
    recordRetry(target, { by, plan, at: now, mode: 'rerun', reason, briefChanged })
    return { result: summarize(plan, by) }
  })
  if (outcome.ok !== true) return outcome
  return {
    ok: true,
    batchId,
    ticketId,
    status: TICKET_STATUS.running,
    retry: outcome.result,
    note: '已把任务书重发进子会话；这一轮结束时会照常结算。',
  }
}
