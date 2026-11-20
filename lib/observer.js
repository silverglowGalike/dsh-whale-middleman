/**
 * 回传：子会话的 turn 结束时，把结果结算进台账，再独立投递一条**信封**给主会话。
 *
 * 三条规矩，都是踩出来的：
 *
 * 1. **结算与投递分开。** 以前两者共用一个 `reportedTurn`：推送抛错只 warn 一句，
 *    可 `reportedTurn` 已经写进去了，于是这条回传永久丢失、也不会重发。
 *    现在先落 `report`（未投递），推送成功才写 `deliveredAt`。
 *
 * 2. **消息里带最终汇报。** 信封 = 定位 + 状态 + 子会话交的汇报（≤2000 字），
 *    全文留在台账里由 `middleman_status` 取。这样主会话不用多跳一次，长报告
 *    也不会无限塞进对话。
 *
 * 3. **中断不等于失败，但要分清来源。** 用户按停止 → `user_interrupted`；
 *    主会话 `/cancel` → `lead_interrupted`；网络断掉（`error.code === 'TRANSPORT'`）
 *    先挂 60 秒宽限等后续活动，到点仍无活动才记 `failed`（`NETWORK_FAILED`）。
 *
 * @module dsh-whale-middleman/observer
 */
import {
  LAUNCH_FAILED_CODE, RECEIPT_UNVERIFIABLE, TICKET_STATUS, applyReportedOutcome,
  classifyTurnEnd, evaluateBatch, jsonSafe, transportGraceAction,
} from './core.js'
import { load, list, save } from './ledger.js'
import { buildBrief, lastAssistantText, readReceipt, summarize } from './dispatch.js'
import { isMiddlemanError } from './refusals.js'

/** outbox 扫描间隔。 */
const OUTBOX_INTERVAL_MS = 30_000

/** 一条回传最多投递几次。 */
const MAX_DELIVERY_ATTEMPTS = 5

/**
 * 已经装好的观察器，按宿主上下文记一份。
 *
 * 为什么要记：插件每重载一次就 apply 一次，而重载时旧 fiber 的卸载不一定
 * 来得及跑完——同一个 turn/end 于是被推 N 次，主会话收到一串重复回报。
 */
const installed = new WeakMap()

/**
 * 观察器索引的代际号。
 *
 * 子会话按 `childSessionId` 反查票。票改绑（`middleman_rebind`）或求值刚
 * 建出一个新子会话时，索引里还是旧映射。只按时间轮询（3 秒）会让「新会话
 * 立刻跑完」这一轮彻底落空：turn/end 在索引过期之前就到了，观察器认不出
 * 人，直接 return——票永远停在旧状态，而用户以为新会话已经接管了。
 *
 * 所以改绑/新建会话时把代际号 +1；下一次 `locate` 先看到代际变了，重建
 * 索引再判断。这个计数只影响「按会话找票」，不碰台账。
 */
let indexGeneration = 0

/**
 * 让下一次 `locate` 强制重建「会话 → 票」索引。
 *
 * 改绑与新建子会话的调用方都得喊一声：宁可多扫一遍台账，也不能把一条
 * 真实的回传当成「不认识的会话」丢掉。
 */
export function invalidateSessionIndex() {
  indexGeneration += 1
}

/**
 * 拼给主会话看的信封。
 *
 * 只有定位信息和一句结论；正文在台账里。失败/中断时附一小段摘要，
 * 免得人还得再查一次才知道出了什么事。
 *
 * @param batch - 批次。
 * @param ticket - 工单（带 report）。
 * @returns 消息正文。
 */
export function envelopeFor(batch, ticket) {
  const report = ticket.report ?? {}
  const lines = [
    '[子任务回传] ' + ticket.id + ' · turn ' + String(report.turn ?? '?') + ' · ' + String(report.status ?? ticket.status)
    + ' · envelope=' + String(report.envelopeId ?? (ticket.id + ':' + String(report.turn ?? '?'))),
    '批次: ' + batch.id + ' — ' + String(batch.title ?? ''),
  ]
  if (typeof report.note === 'string' && report.note !== '') lines.push('说明: ' + report.note)
  // 回执里的最终汇报直接带给主会话：它是子会话的自评与交付说明，主会话
  // 要靠它判断下一步。硬上限控制 token，长报告截断后指向台账。
  const REPORT_LIMIT = 2000
  const body = typeof report.text === 'string' ? report.text.replace(/\s+/g, ' ').trim() : ''
  if (body !== '') {
    lines.push('报告: ' + body.slice(0, REPORT_LIMIT)
      + (body.length > REPORT_LIMIT ? ' …（已截断，全文在台账）' : ''))
  }
  // 只有 done 会自动解锁后继（2026-11-18 起）。partial / needs_review /
  // no_receipt / receipt_unverified 的票以前会（或曾经会）自动接力，现在不会了
  // ——信封必须把这件事说出来，否则主会话还以为后继已经在跑了。
  if (['partial', 'needs_review', 'no_receipt', 'receipt_unverified'].includes(report.status)) {
    lines.push('后继不会自动开跑：确认能继续就用 middleman_rewire 摘掉这张票，'
      + '要重做就面板「重跑」，拿不准就问用户。')
  }
  if ((report.attempts ?? 0) > 1) lines.push('（第 ' + report.attempts + ' 次投递，内容相同）')
  if (body === '' || body.length > REPORT_LIMIT) {
    lines.push('全文在台账：middleman_status({ batchId: "' + batch.id + '", ticketId: "' + ticket.id + '" })。')
  }
  return lines.join('\n')
}

/**
 * 从会话历史里找最后一个 turn/end。
 * @param events - tail() 返回的记录。
 * @returns {turn, reason} 或 undefined。
 */
export function lastTurnEnd(events) {
  let found
  for (const entry of events ?? []) {
    const event = entry?.event ?? entry
    if (event?.type !== 'turn/end') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number') continue
    found = { turn, reason: event.data?.reason }
  }
  return found
}

/**
 * 历史里最后一条事件的时间（用来判断传输中断的宽限期内有没有新活动）。
 *
 * records 形如 `{type:'event', event, time}`，测试里可能只给裸事件；两种都收。
 * @param events - 会话历史。
 * @returns epoch 毫秒；一条都读不到时 undefined。
 */
export function latestEventTime(events) {
  let latest
  for (const entry of events ?? []) {
    const event = entry?.event ?? entry
    const time = entry?.time ?? event?.time
    if (Number.isFinite(time) && (latest === undefined || time > latest)) latest = time
  }
  return latest
}

/** 台账写入撞上 revision 冲突：重读重算，不覆盖别人刚写的。 */
function isRevisionConflict(error) {
  return isMiddlemanError(error) && error.code === 'revision-conflict'
}

/** 观察器与求值路径共用的一行日志；logger 缺失也不能影响主流程。 */
function warnFaces(faces, message) {
  try {
    faces.warn?.(message)
  } catch {
    // 没有 logger 就算了
  }
}

/**
 * 把一张票的运行期字段贴回**盘上最新**那份台账。
 *
 * 为什么不能拿内存里那份直接覆盖：spawn/run 要跟宿主来回几次，这几秒里
 * 观察器可能刚写过心跳或回传。重读 → 只改这张票的运行期字段 → 带 CAS
 * 写回，冲突就重试。
 *
 * @param faces - 派发面，只用 warn。
 * @param batchId - 批次 id。
 * @param ticket - 内存里这张票的启动结果。
 */
async function commitTicketRuntime(faces, batchId, ticket) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let fresh
    try {
      fresh = await load(batchId)
    } catch (error) {
      warnFaces(faces, '[dsh-whale-middleman] 启动结果没写进台账：' + String(error))
      return
    }
    const target = (fresh.tickets ?? []).find((candidate) => candidate.id === ticket.id)
    if (target === undefined) return
    target.status = ticket.status
    if (typeof ticket.childSessionId === 'string') target.childSessionId = ticket.childSessionId
    if (typeof ticket.startedAt === 'number') target.startedAt = ticket.startedAt
    else delete target.startedAt
    if (ticket.model !== undefined && ticket.model !== null) target.model = ticket.model
    if (typeof ticket.launchFailureCode === 'string') target.launchFailureCode = ticket.launchFailureCode
    else delete target.launchFailureCode
    if (typeof ticket.launchError === 'string') target.launchError = ticket.launchError
    else delete target.launchError
    // 票已经离开 queued（启动成功或重新排队），这次评估的 blockedState 就过时了。
    // 下次求值会重新算一份。
    delete target.blockedState
    try {
      await save(fresh, { expectedRevision: fresh.revision })
      return
    } catch (error) {
      if (!isRevisionConflict(error) || attempt === 3) {
        warnFaces(faces, '[dsh-whale-middleman] 启动结果没写进台账：' + String(error))
        return
      }
    }
  }
}

/**
 * 启动一张已经**占好位**的 queued 票：没有会话就 spawn，然后发任务书。
 *
 * 为什么 queued 票可能没有 `childSessionId`：`/approve` 只给「已就绪」的票
 * 建会话，被前序挡住的票只被置成 queued，没有子会话。求值决定启动它时，
 * 会话得由这里补建。
 *
 * 已经有一个会话（上次 spawn 成功但 run 失败）时复用那个会话，不再建第二个。
 *
 * @param faces - 派发面。
 * @param batch - 批次（调用方已读到的版本，用来拼 brief）。
 * @param ticket - 工单。
 */
async function startTicket(faces, batch, ticket) {
  let sessionId = typeof ticket.childSessionId === 'string' && ticket.childSessionId !== ''
    ? ticket.childSessionId
    : undefined

  if (sessionId === undefined) {
    // 位置与 /approve 同口径：有 workspaceId 用它，否则用 cwd；
    // 两个都给会被宿主拒绝，所以二选一。
    const workspaceId = batch.workspaceId
    const cwd = workspaceId === undefined ? batch.cwd : undefined
    const spawned = await faces.dispatcher.spawn(ticket, {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
    })
    if (typeof spawned?.sessionId !== 'string' || spawned.sessionId === '') {
      throw new Error('宿主没有返回会话 id')
    }
    sessionId = spawned.sessionId
    ticket.childSessionId = sessionId
    if (spawned.model !== undefined && spawned.model !== null) ticket.model = spawned.model
    // 会话已经建出来了：先把 id 落盘。run 抛错时下一次重试要复用它，
    // 而不是再建一个会话——那会留下一个没人管的孤儿。
    await commitTicketRuntime(faces, batch.id, ticket)
  }

  await faces.dispatcher.run(sessionId, buildBrief(batch, ticket))
  ticket.status = TICKET_STATUS.running
  ticket.startedAt = Date.now()
  delete ticket.launchError
  delete ticket.launchFailureCode
  await commitTicketRuntime(faces, batch.id, ticket)
}

/**
 * 启动失败时给主会话报一条**信封**。
 *
 * 为什么不在 `middleman_status` 里被动等着：票停在 queued 且没有会话，
 * 观察器不会再有 turn/end 来结算；主会话不主动拉台账就永远不知道。
 *
 * 失败本身按报错族处理：主会话用 `middleman_retry`，同一 code 5 次；
 * 用户面板的「重试启动」是人工出口。
 *
 * @param faces - 派发面。
 * @param batch - 批次。
 * @param ticket - 刚启动失败的票（已写 launchError）。
 */
export async function notifyLaunchFailure(faces, batch, ticket) {
  const parentId = batch?.parentSessionId
  if (typeof parentId !== 'string' || parentId === '') return
  const reason = typeof ticket.launchError === 'string' && ticket.launchError !== ''
    ? ticket.launchError
    : '未知'
  const lines = [
    '[启动失败] ' + ticket.id + ' · queued · batch=' + String(batch.id),
    '原因: ' + reason,
    '处理: 面板「重试启动」，或让主会话调 middleman_retry 重试（报错族，同一错误码 5 次）。',
    '不会自动重试；这张票不会开跑，后继也不会自动接力。',
  ]
  try {
    await faces.dispatcher.run(parentId, lines.join('\n'))
  } catch (error) {
    faces.warn?.('[dsh-whale-middleman] 启动失败通知没送到主会话：' + String(error))
  }
}

/**
 * 对整批求值一次，并把结果落成动作：写 `blockedState`、占位、启动。
 *
 * 这是「记录与决策分离」的落点：决策全部来自 `core.evaluateBatch`（纯函数），
 * 这里只做台账读写与宿主调用。结算路径、插件启动对账、outbox 扫描都调它，
 * 所以 DSH 重启后不需要任何内存状态。
 *
 * 启动顺序是**先占位再启动**：用 CAS 把票从 queued 改成 running，抢到才
 * spawn+run。两张前序几乎同时结算时，只有一个调用能抢到，另一个重读后
 * 看到「已经不是 queued」就跳过——不会给同一张票开两个子会话。
 *
 * 单票失败隔离：spawn/run 抛错时票回 queued、写 `launchError` 与
 * `launchFailureCode`，同一个调用里不再重试它，其它票照常启动。票带着
 * `launchError` 时 `evaluateBatch` 不会自动再启动它——启动失败按报错族
 * 交给主会话：`middleman_retry` 清标记后再试（同一 code 5 次），或用户在
 * 面板点「重试启动」。启动失败也会给主会话发一条信封，不让它静默卡住。
 *
 * 被前序失败挡住的票**不推任何消息**：这里没有 `dispatcher.run(parent)`。
 * 票自身的结算信封仍由 settleTurn 按 P0 逻辑投递，那是另一条路径。
 *
 * @param faces - 派发面（spawn / run / warn）。
 * @param batchId - 批次 id。
 * @param options - { skip?: string[] }：本次**已经试过、不要再试**的票 id。
 *   /approve 刚启动失败的票走这里跳过——批准当下再试一次没有意义。
 * @returns {{batchId: string, started: string[], failed: Array<{ticketId: string, error: string}>}}
 */
export async function relayBatch(faces, batchId, options = {}) {
  const summary = { batchId, started: [], failed: [] }
  // 这一次求值里已经失败过的票不再重试：重试属于「下一次结算或 outbox 扫描」。
  // 调用方（/approve）也能塞进来一批：刚失败的票不要在同一次请求里复活。
  const skip = new Set(Array.isArray(options.skip) ? options.skip : [])

  // 上限是防御性的：正常一轮要么启动成功（票离开 queued），要么失败进 skip，
  // 要么冲突重读。不会真的转 200 圈。
  for (let round = 0; round < 200; round++) {
    let batch
    try {
      batch = await load(batchId)
    } catch {
      return summary
    }
    const tickets = (Array.isArray(batch.tickets) ? batch.tickets : [])
      .filter((ticket) => ticket !== null && typeof ticket === 'object')

    // 只有批准过的批次才允许启动。evaluateBatch 只看票状态；如果台账里
    // 因为手工修改 / 旧数据 / 未来新路径出现「未批准批次 + queued 票」，
    // 这条闸门会把它挡在「人批准才开跑」之外。
    if (batch.status !== 'approved') return summary

    const evaluation = evaluateBatch(batch)

    // 记录：每张 queued 票都写一份 blockedState（成功启动时会在占位那步清掉）。
    let recorded = false
    for (const ticket of tickets) {
      if (ticket.status !== TICKET_STATUS.queued) continue
      const state = evaluation.blockedStates[ticket.id]
      if (state === undefined) continue
      ticket.blockedState = state
      recorded = true
    }

    const nextId = evaluation.startable.find((id) => !skip.has(id))
    if (nextId === undefined) {
      // 没有可启动的了：只把 blockedState 落盘。冲突就重读重算。
      if (!recorded) return summary
      try {
        await save(batch, { expectedRevision: batch.revision })
        return summary
      } catch (error) {
        if (isRevisionConflict(error)) continue
        warnFaces(faces, '[dsh-whale-middleman] blockedState 没写进台账：' + String(error))
        return summary
      }
    }

    const ticket = tickets.find((candidate) => candidate.id === nextId)
    if (ticket === undefined) {
      skip.add(nextId)
      continue
    }

    // 先占位：queued → running。抢到才启动；抢不到说明别人先处理了这张票。
    ticket.status = TICKET_STATUS.running
    ticket.startedAt = Date.now()
    delete ticket.blockedState
    try {
      await save(batch, { expectedRevision: batch.revision })
    } catch (error) {
      if (isRevisionConflict(error)) continue
      warnFaces(faces, '[dsh-whale-middleman] 启动占位没写进台账：' + String(error))
      return summary
    }

    try {
      await startTicket(faces, batch, ticket)
      summary.started.push(ticket.id)
      // 刚建出来的子会话不在观察器索引里。不主动作废索引的话，它 3 秒内
      // 结束的那一轮 turn/end 会在「索引还新」的窗口里被当成陌生会话丢掉。
      invalidateSessionIndex()
    } catch (error) {
      // 失败隔离：这一张回 queued，写原因，其它票接着来。
      //
      // 写 launchError 同时就是「别自动重试」的标记：evaluateBatch 会跳过
      // 带这个字段的 queued 票。重试只能由主会话 middleman_retry 或用户
      // 面板「重试启动」显式发起；launchFailureCode 是报错族的记账码，
      // 要跨多次重试保持不变，否则每次清掉标记再失败会被算成换了问题。
      skip.add(ticket.id)
      const message = error instanceof Error ? error.message : String(error)
      ticket.status = TICKET_STATUS.queued
      delete ticket.startedAt
      ticket.launchError = message
      ticket.launchFailureCode = LAUNCH_FAILED_CODE
      summary.failed.push({ ticketId: ticket.id, error: message })
      await commitTicketRuntime(faces, batchId, ticket)
      await notifyLaunchFailure(faces, batch, ticket)
    }
  }

  return summary
}

/**
 * 正在投递的信封（进程内去重）。
 *
 * I-02 的根因：`settleTurn` 的即时投递和 outbox 的兜底重投是两条路径，两边都
 * 先看 `deliveredAt === undefined` 再发送；发送要 await 宿主，几百毫秒里另一条
 * 路径可能已经读过同一份「未投递」快照。`ledger.save()` 的 CAS 只保护台账写入，
 * 保护不了「谁来发这条消息」。
 *
 * 单进程里两层就够：进程内 Set 挡住同时在飞的两条；发送前**重新从盘上读**，
 * 挡住「快照过期」的那条（A 发完写盘后，B 拿着旧快照还会以为没投过）。
 * 跨进程不保护——DSH 只有一个插件宿主进程。
 */
const inflightEnvelopes = new Set()

/**
 * 投递一次信封（幂等）。
 *
 * @param faces - 派发面（dispatcher.run / warn）。
 * @param batchId - 批次 id。
 * @param ticketId - 工单 id。
 */
export async function deliverEnvelope(faces, batchId, ticketId) {
  const key = batchId + '::' + ticketId
  if (inflightEnvelopes.has(key)) return
  inflightEnvelopes.add(key)
  try {
    let batch
    try {
      batch = await load(batchId)
    } catch {
      return
    }
    const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === ticketId)
    const report = ticket?.report
    if (report === undefined) return
    if (report.deliveredAt !== undefined) return
    // 重启对账的静默结算：状态照写，但不推信封（用户可能只是自己关了 DSH）。
    if (report.deliverySuppressed !== undefined) return
    if (typeof batch.parentSessionId !== 'string' || batch.parentSessionId === '') return
    if ((report.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) return

    report.attempts = (report.attempts ?? 0) + 1
    try {
      await faces.dispatcher.run(batch.parentSessionId, envelopeFor(batch, ticket))
      report.deliveredAt = Date.now()
      delete report.lastError
    } catch (error) {
      report.lastError = error instanceof Error ? error.message : String(error)
      warnFaces(faces, '[dsh-whale-middleman] 回传没送到主会话（第 ' + report.attempts + ' 次）：' + report.lastError)
    }
    try {
      await save(batch, { expectedRevision: batch.revision })
    } catch (error) {
      warnFaces(faces, '[dsh-whale-middleman] 回传状态没写进台账：' + String(error))
    }
  } finally {
    inflightEnvelopes.delete(key)
  }
}

/**
 * 装一个观察器。
 * @param ctx - 插件上下文，只用到 ctx.on。
 * @param faces - 派发面（读历史、往会话发消息）。
 * @returns 卸载函数。
 */
export function installObserver(ctx, faces) {
  const previous = installed.get(ctx)
  if (previous !== undefined) {
    try {
      previous()
    } catch {
      // 卸不掉就算了：新观察器照样装，至少不会两个并存。
    }
    installed.delete(ctx)
  }

  const warn = (message) => {
    try {
      faces.warn?.(message)
    } catch {
      // 没有 logger 就算了
    }
  }

  /** 子会话 id → {batchId, ticketId}。 */
  let index = new Map()
  let indexAt = 0
  let indexGenerationSeen = indexGeneration

  /**
   * 本进程的启动时间。
   *
   * 用来识别「重启后遗留的 running 票」：票的 running 是中台自己写的台账，
   * 不是 DSH 的会话状态；DSH 重启后子会话不会自己继续跑，所以**最后活动时间
   * 早于本进程启动**的 running 票一定是僵尸。降级成 `suspended`，用户就能在
   * 面板上点「执行」；不这样做的话 `/run` 会以 `already-running` 拒绝，票永远
   * 卡住。热重载时进程启动时间更早，正在跑的票不会被误伤。
   */
  const bootAt = (() => {
    try {
      const uptime = typeof process?.uptime === 'function' ? process.uptime() : NaN
      return Number.isFinite(uptime) && uptime > 0 ? Date.now() - uptime * 1000 : 0
    } catch {
      return 0
    }
  })()

  const reindex = async () => {
    // 代际号在**开始**时拿下：扫台账期间如果又发生改绑/新建会话，代际会
    // 再 +1，这次扫出来的索引就可能已经过时——把 seen 记成开始时的值，
    // 下一次 locate 看到不一致会再扫一遍，而不是把过时索引当成最新。
    const generation = indexGeneration
    const next = new Map()
    for (const row of await list()) {
      for (const ticket of row.tickets ?? []) {
        if (typeof ticket.childSessionId === 'string') {
          next.set(ticket.childSessionId, { batchId: row.id, ticketId: ticket.id })
        }
      }
    }
    index = next
    indexAt = Date.now()
    indexGenerationSeen = generation
    return next
  }

  /**
   * 命中索引；没命中且索引太旧就重建一次（新派发的票要能被认出来）。
   *
   * 除了「旧」还要看代际：改绑/新建会话会显式把索引标记为过时，即使
   * 索引刚建好不到 3 秒也得重建——否则新会话的第一轮 turn/end 会被丢掉。
   */
  const locate = async (sessionId) => {
    let hit = index.get(sessionId)
    const generationChanged = indexGenerationSeen !== indexGeneration
    if (generationChanged || (hit === undefined && Date.now() - indexAt > 3_000)) {
      await reindex()
      hit = index.get(sessionId)
    }
    if (hit === undefined) return undefined
    let batch
    try {
      batch = await load(hit.batchId)
    } catch {
      return undefined
    }
    const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === hit.ticketId)
    if (ticket === undefined) return undefined
    return { batch, ticket }
  }

  /** 票状态是不是「还没跑」或「正在等用户」。 */
  const skipReason = (ticket) => {
    if (ticket.status === 'pending' || ticket.status === 'suspended') return 'not-started'
    if (ticket.status === 'waiting' || ticket.waiting !== undefined) return 'waiting'
    return undefined
  }


  /**
   * 结算一轮：写台账 → 需要时自动续跑 → 投递。
   *
   * @param sessionId - 子会话 id。
   * @param turn - turn 号。
   * @param reason - turn/end 的 reason。
   * @param depth - 冲突重试深度（内部用）。
   */
  const settleTurn = async (sessionId, turn, reason, depth = 0, options = {}) => {
    const located = await locate(sessionId)
    if (located === undefined) return
    const { batch, ticket } = located
    if (skipReason(ticket) !== undefined) return
    if (ticket.reportedTurn === turn) return

    const verdict = classifyTurnEnd(reason, { interruptedBy: ticket.interruptedBy })
    if (verdict.ignore === true) return

    let tail = []
    let tailError
    try {
      tail = await faces.dispatcher.tail(sessionId)
    } catch (error) {
      tailError = error instanceof Error ? error.message : String(error)
      warn('[dsh-whale-middleman] 读子会话历史失败，回传不带正文：' + tailError)
    }
    const text = lastAssistantText(tail, turn)
    const summary = summarize(tail)
    // I-01：`turn/end` 是 completed 只说明这一轮正常结束，不说明活干了。
    // 判据是子会话自己交的回执（自评 outcome + 最终汇报）——中台只记账，
    // 不读报告判断内容。读不到历史时是「无法核实」，不是「没有回执」。
    const receipt = tailError === undefined ? readReceipt(tail, turn) : RECEIPT_UNVERIFIABLE
    const settled = applyReportedOutcome(verdict, receipt)
    const reportedText = receipt !== undefined && receipt !== RECEIPT_UNVERIFIABLE
      && typeof receipt.report === 'string' && receipt.report.trim() !== ''
      ? receipt.report
      : text
    const receiptState = receipt === RECEIPT_UNVERIFIABLE
      ? 'unverifiable'
      : (receipt === undefined ? 'no' : 'yes')

    // 网络中断：DSH 的请求重试（0.5s 起步、每轮翻倍、5 轮约 15.5s）发生在
    // turn/end 之前；中台看到 TRANSPORT 时它已经结束。中台不抢跑，只挂 60 秒
    // 宽限等后续活动（手动继续 / 新一轮）；期间有活动就撤销，到点仍无活动才
    // 按 failed + NETWORK_FAILED 结算并报一次，避免重复报错。
    if (verdict.network === true && options.force !== true && options.quiet !== true) {
      ticket.transportGrace = { at: Date.now(), turn, reason, sessionId }
      ticket.lastEventAt = Date.now()
      try {
        await save(batch, { expectedRevision: batch.revision })
      } catch (error) {
        warn('[dsh-whale-middleman] 传输宽限没写进台账：' + String(error))
      }
      return
    }

    // 结算时清掉可能残留的宽限标记。
    delete ticket.transportGrace
    // 这一轮真的干完了：主会话的重试额度重新计起（下一张票/下一轮从 0 开始）。
    if (settled.status === TICKET_STATUS.done) delete ticket.leadRetries
    ticket.status = settled.status
    ticket.finishedAt = Date.now()
    ticket.reportedTurn = turn
    ticket.lastEventAt = Date.now()
    const reportedTextClipped = reportedText.slice(0, 8000)
    const outcome = settled.outcome
      ?? (receipt !== undefined && receipt !== RECEIPT_UNVERIFIABLE ? receipt.outcome : undefined)
    ticket.result = jsonSafe({
      text: reportedTextClipped,
      summary,
      note: settled.note,
      receipt: receiptState,
      ...(outcome === undefined ? {} : { outcome }),
      events: tail.length,
      ...(tailError === undefined ? {} : { tailError }),
    })
    ticket.report = jsonSafe({
      turn,
      status: settled.status,
      note: settled.note,
      receipt: receiptState,
      ...(outcome === undefined ? {} : { outcome }),
      summary,
      text: reportedTextClipped,
      settledAt: Date.now(),
      envelopeId: ticket.id + ':' + turn,
      attempts: 0,
      ...(settled.code === undefined ? {} : { code: settled.code }),
      ...(tailError === undefined ? {} : { tailError }),
      // 重启对账的静默结算：状态照写，但不推信封。用户可能只是自己关了 DSH，
      // 给已经结束的主会话推报错只会制造噪音；要细节时主会话可以自己拉台账。
      ...(options.quiet === true ? { deliverySuppressed: 'restart' } : {}),
    })

    try {
      await save(batch, { expectedRevision: batch.revision })
    } catch (error) {
      if (isMiddlemanError(error) && error.code === 'revision-conflict' && depth < 2) {
        // 台账在「读历史」那段时间被改过：重新读一次再结算，别覆盖别人的写入。
        return await settleTurn(sessionId, turn, reason, depth + 1, options)
      }
      throw error
    }

    // 静默结算：不投递、不触发后继（重启后要不要继续由用户/主会话决定）。
    if (options.quiet === true) return

    await deliverEnvelope(faces, batch.id, ticket.id)

    // 结算只做两件事：写台账（上面已经写了）、触发一次整批求值（这里）。
    // 后继能不能启动全由 evaluateBatch 决定；被前序失败挡住的票安静地
    // 留在 queued，这里不会给它发任何消息。
    try {
      await relayBatch(faces, batch.id)
    } catch (error) {
      warn('[dsh-whale-middleman] 依赖求值失败：' + String(error))
    }
  }

  /** 扫一遍台账，把没投递出去的回传补投，并处理传输中断的宽限期。 */
  const flushOutbox = async () => {
    for (const row of await list()) {
      let batch
      try {
        batch = await load(row.id)
      } catch {
        continue
      }
      // 网络中断宽限：到点仍无活动 → 结算 failed/NETWORK_FAILED（只报一次）；
      // 期间有新活动 → 撤销标记，等新的 turn/end 正常结算。
      for (const ticket of batch.tickets ?? []) {
        if (ticket.transportGrace === undefined) continue
        // 宽限记的是发出 TRANSPORT 的那个会话。票在此期间改绑过新会话时，
        // 旧的宽限已经不作数——继续按它结算会把新会话判成假失败。
        if (typeof ticket.transportGrace.sessionId === 'string'
          && ticket.transportGrace.sessionId !== ticket.childSessionId) {
          delete ticket.transportGrace
          try {
            await save(batch, { expectedRevision: batch.revision })
          } catch {
            // 下一轮再处理
          }
          continue
        }
        if (typeof ticket.childSessionId !== 'string') {
          delete ticket.transportGrace
          try {
            await save(batch, { expectedRevision: batch.revision })
          } catch {
            // 写不进去下一轮再试
          }
          continue
        }
        let tail
        try {
          tail = await faces.dispatcher.tail(ticket.childSessionId)
        } catch {
          continue
        }
        const last = lastTurnEnd(tail)
        const action = transportGraceAction(ticket.transportGrace, {
          now: Date.now(),
          lastEventTime: latestEventTime(tail),
          lastTurnEndTurn: last?.turn,
        })
        if (action === 'wait') continue
        if (action === 'activity') {
          delete ticket.transportGrace
          try {
            await save(batch, { expectedRevision: batch.revision })
          } catch {
            // 下一轮再处理
          }
          if (last !== undefined && last.turn !== ticket.reportedTurn) {
            await settleTurn(ticket.childSessionId, last.turn, last.reason)
          }
          continue
        }
        // expired：DSH 重连也没救回来，结算成 failed（NETWORK_FAILED）并报一次。
        await settleTurn(ticket.childSessionId, ticket.transportGrace.turn, ticket.transportGrace.reason, 0, { force: true })
      }
      for (const ticket of batch.tickets ?? []) {
        if (ticket.report === undefined || ticket.report.deliveredAt !== undefined) continue
        await deliverEnvelope(faces, batch.id, ticket.id)
      }
      // outbox 继续求值 queued 票：前序可能在别处结算完，这里补一次启动。
      // 带 launchError 的票由 evaluateBatch 排除，不会被这条扫描反复重试。
      if ((batch.tickets ?? []).some((ticket) => ticket.status === TICKET_STATUS.queued)) {
        try {
          await relayBatch(faces, batch.id)
        } catch (error) {
          warn('[dsh-whale-middleman] outbox 求值失败：' + String(error))
        }
      }
    }
  }

  /**
   * 启动对账：宿主重启/插件重载期间发生的 turn/end 没人听，
   * 这里按会话历史补结算。
   */
  const reconcile = async () => {
    for (const row of await list()) {
      let batch
      try {
        batch = await load(row.id)
      } catch {
        continue
      }
      for (const ticket of batch.tickets ?? []) {
        if (typeof ticket.childSessionId !== 'string') {
          // 占位后崩溃：票被写成 running 却没有任何子会话。重启后它既不会
          // 被结算（没有会话），/run 又会以 already-running 拒绝，票永远卡住。
          // 降级成 suspended，用户才能点「执行」重新拉起。
          if (ticket.status === TICKET_STATUS.running) {
            ticket.status = TICKET_STATUS.suspended
            ticket.staleAt = Date.now()
            ticket.staleReason = 'restart-no-session'
            try {
              await save(batch, { expectedRevision: batch.revision })
            } catch (error) {
              warn('[dsh-whale-middleman] 无会话的 running 票降级失败：' + String(error))
            }
          }
          continue
        }
        if (skipReason(ticket) !== undefined) continue
        let tail
        try {
          tail = await faces.dispatcher.tail(ticket.childSessionId)
        } catch {
          continue
        }
        const last = lastTurnEnd(tail)
        if (last !== undefined && ticket.reportedTurn !== last.turn) {
          // 重启/插件重载后的补结算：状态照写，但不推信封、不触发后继。
          // 用户可能只是自己关了 DSH；真要看细节，主会话自己拉台账。
          await settleTurn(ticket.childSessionId, last.turn, last.reason, 0, { quiet: true })
          continue
        }
        // 没有可补的结算：如果它是重启前遗留的 running，降级成 suspended。
        // 否则 /run 会以 already-running 拒绝，用户永远点不动这张票。
        // 只处理**有活动时间戳**的票：没有时间戳的多半是旧台账/测试夹具，
        // 不能凭「没时间戳」就断定它是僵尸。
        const stamp = ticket.lastEventAt ?? ticket.startedAt
        if (ticket.status === TICKET_STATUS.running && Number.isFinite(stamp) && stamp < bootAt) {
          ticket.status = TICKET_STATUS.suspended
          ticket.staleAt = Date.now()
          ticket.staleReason = 'restart'
          try {
            await save(batch, { expectedRevision: batch.revision })
          } catch (error) {
            warn('[dsh-whale-middleman] 僵尸票降级没写进台账：' + String(error))
          }
        }
      }
    }
  }

  /**
   * 修复「批准中途崩溃」留下的 approved + draft 票。
   *
   * /approve 先把批次锁成 approved 再逐票启动；可启动票在这一小段时间里
   * 还是 draft。进程若在这个窗口里被杀，票就永远停在 draft：approve 会回
   * alreadyApproved、relayBatch 只启动 queued、/retry 和 /run 都没有会话。
   *
   * 只在启动对账时修一次，不和正在进行的 /approve 抢。
   */
  const repairApprovedDrafts = async () => {
    for (const row of await list()) {
      let batch
      try {
        batch = await load(row.id)
      } catch {
        continue
      }
      if (batch.status !== 'approved') continue
      let changed = false
      for (const ticket of batch.tickets ?? []) {
        if (ticket.status !== 'draft' && ticket.status !== 'pending') continue
        ticket.status = TICKET_STATUS.queued
        delete ticket.launchError
        delete ticket.launchFailureCode
        changed = true
      }
      if (!changed) continue
      try {
        await save(batch, { expectedRevision: batch.revision })
      } catch (error) {
        warn('[dsh-whale-middleman] 批准中途残留的草稿票修复失败：' + String(error))
      }
    }
  }

  /**
   * 重启恢复：对全部批次重放一遍求值。
   *
   * DSH 重启/插件重载期间可能刚好有前序结算完，后继还停在 queued。
   * 台账是唯一真相，重放同一个纯函数就能把该跑的票补起来——不需要内存状态。
   */
  const relayAll = async () => {
    for (const row of await list()) {
      try {
        await relayBatch(faces, row.id)
      } catch (error) {
        warn('[dsh-whale-middleman] 启动补跑失败：' + String(error))
      }
    }
  }

  const dispose = ctx.on('session/event', async (session, event) => {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      if (event?.type !== 'turn/start' && event?.type !== 'turn/end') return

      const located = await locate(sessionId)
      // 先认人：不是中台派出去的会话，一律不碰。
      if (located === undefined) return

      if (event.type === 'turn/start') {
        // 票状态不能只在结束时改：被用户用别的方式拉起来的子会话，
        // 否则会一直停在 suspended，结束时还会被 skip 掉——永远不更新。
        const { batch, ticket } = located
        ticket.lastEventAt = Date.now()
        if (ticket.status === 'suspended' || ticket.status === 'queued') ticket.status = 'running'
        // 用户在子会话里直接答了「请确认」，或宿主自动续跑：新一轮已经开始，
        // 票不该再被当成 waiting——否则这一轮的 turn/end 会被 skipReason 丢掉。
        if (ticket.status === 'waiting' || ticket.waiting !== undefined) {
          delete ticket.waiting
          ticket.status = 'running'
        }
        // 新一轮开始了：传输中断的宽限标记作废——DSH 的续跑已经生效，
        // 这一轮结束时会正常结算，不需要再报错。
        if (ticket.transportGrace !== undefined) delete ticket.transportGrace
        try {
          await save(batch, { expectedRevision: batch.revision })
        } catch {
          // 心跳写不进去不影响主流程
        }
        return
      }

      await settleTurn(sessionId, event.data?.turn, event.data?.reason)
    } catch (error) {
      warn('[dsh-whale-middleman] 处理会话事件失败：' + String(error))
    }
  })

  // outbox 定时器：投递失败的回传、以及漏掉的结算。
  const timer = setInterval(() => {
    void flushOutbox().catch((error) => warn('[dsh-whale-middleman] outbox 扫描失败：' + String(error)))
  }, OUTBOX_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  // 启动对账之后补跑一次依赖求值：重启期间结算完的前序，其 queued 后继
  // 要在这里被补启动。顺序放在对账之后，先补结算、再按最新台账求值。
  void reindex()
    .then(() => reconcile())
    .then(() => repairApprovedDrafts())
    .then(() => relayAll())
    .catch((error) => warn('[dsh-whale-middleman] 启动对账失败：' + String(error)))

  const uninstall = () => {
    dispose()
    clearInterval(timer)
    if (installed.get(ctx) === uninstall) installed.delete(ctx)
  }
  installed.set(ctx, uninstall)
  return uninstall
}
