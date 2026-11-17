/**
 * 回传：子会话的 turn 结束时，把结果结算进台账，再独立投递一条**信封**给主会话。
 *
 * 三条规矩，都是踩出来的：
 *
 * 1. **结算与投递分开。** 以前两者共用一个 `reportedTurn`：推送抛错只 warn 一句，
 *    可 `reportedTurn` 已经写进去了，于是这条回传永久丢失、也不会重发。
 *    现在先落 `report`（未投递），推送成功才写 `deliveredAt`。
 *
 * 2. **消息里不搬正文。** 信封只带 `batchId / ticketId / turn / 状态`，正文留在
 *    台账里由 `middleman_status` 取（A2A 的做法：通知带 taskId，客户端再 GetTask）。
 *    这样「迟到」和「重投」都不会变成两段互相矛盾的正文。
 *
 * 3. **中断不等于失败。** 人按停止（`aborted`）记 `cancelled`，绝不续跑；
 *    传输断掉（`error.code === 'TRANSPORT'`）记 `interrupted`，自动续跑一次。
 *
 * @module dsh-whale-middleman/observer
 */
import {
  MAX_LAUNCH_ATTEMPTS, TICKET_STATUS, classifyTurnEnd, evaluateBatch, jsonSafe,
} from './core.js'
import { load, list, save } from './ledger.js'
import { buildBrief, lastAssistantText, summarize } from './dispatch.js'
import { isMiddlemanError } from './refusals.js'

/** outbox 扫描间隔。 */
const OUTBOX_INTERVAL_MS = 30_000

/** 一条回传最多投递几次。 */
const MAX_DELIVERY_ATTEMPTS = 5

/** 一张票最多自动续跑几次。 */
const MAX_RESUMES = 1

/** 自动续跑的指令：只让它接着做，不提落盘（落盘是收尾时的事）。 */
const CONTINUE_TEXT = '继续上次被中断的工作，从断点接着做，不要重复已完成的部分。'

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
 * 人，直接 return——票永远停在旧状态，而人以为新会话已经接管了。
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
    '[子任务回报] ' + ticket.id + ' · turn ' + String(report.turn ?? '?') + ' · ' + String(report.status ?? ticket.status)
    + ' · envelope=' + String(report.envelopeId ?? (ticket.id + ':' + String(report.turn ?? '?'))),
    '批次: ' + batch.id + ' — ' + String(batch.title ?? ''),
  ]
  if (typeof report.note === 'string' && report.note !== '') lines.push('说明: ' + report.note)
  if (report.status === 'failed' || report.status === 'interrupted') {
    const head = typeof report.text === 'string' && report.text !== '' ? report.text.slice(0, 300) : ''
    if (head !== '') lines.push('摘要: ' + head.replace(/\s+/g, ' '))
  }
  if ((report.attempts ?? 0) > 1) lines.push('（第 ' + report.attempts + ' 次投递，内容相同）')
  lines.push('正文在台账取：middleman_status({ batchId: "' + batch.id + '", ticketId: "' + ticket.id + '" })，不要自己去读 json 文件。')
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
    if (typeof ticket.launchAttempts === 'number') target.launchAttempts = ticket.launchAttempts
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
    // 位置与 dispatch_task / /approve 同口径：有 workspaceId 用它，否则用 cwd；
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
  await commitTicketRuntime(faces, batch.id, ticket)
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
 * 单票失败隔离：spawn/run 抛错时票回 queued、写 `launchError`，同一个
 * 调用里不再重试它（留给下一次结算或 outbox 扫描），其它票照常启动。
 * 重试上限 `MAX_LAUNCH_ATTEMPTS`（2 次），超过后保持 queued+launchError
 * 让人处理，绝不无限重试。
 *
 * 被前序失败挡住的票**不推任何消息**：这里没有 `dispatcher.run(parent)`。
 * 票自身的结算信封仍由 settleTurn 按 P0 逻辑投递，那是另一条路径。
 *
 * @param faces - 派发面（spawn / run / warn）。
 * @param batchId - 批次 id。
 * @param options - { skip?: string[] }：本次**已经试过、不要再试**的票 id。
 *   /approve 刚启动失败的票走这里跳过——批准当下再试一次只会把
 *   MAX_LAUNCH_ATTEMPTS 的两发子弹在同一毫秒里打光，留给下一次结算 / 30 秒
 *   outbox 扫描 / 重启对账去重试。
 * @returns {{batchId: string, started: string[], failed: Array<{ticketId: string, error: string, attempts: number}>}}
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
    ticket.launchAttempts = (ticket.launchAttempts ?? 0) + 1
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
      skip.add(ticket.id)
      const message = error instanceof Error ? error.message : String(error)
      ticket.status = TICKET_STATUS.queued
      delete ticket.startedAt
      ticket.launchError = message
      summary.failed.push({
        ticketId: ticket.id,
        error: message,
        attempts: ticket.launchAttempts,
      })
      await commitTicketRuntime(faces, batchId, ticket)
    }
  }

  return summary
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

  /** 票状态是不是「还没跑」或「正在等人」。 */
  const skipReason = (ticket) => {
    if (ticket.status === 'pending' || ticket.status === 'suspended') return 'not-started'
    if (ticket.status === 'waiting' || ticket.waiting !== undefined) return 'waiting'
    return undefined
  }

  /**
   * 投递一次信封。成功才写 deliveredAt。
   * @param batch - 批次（会被就地更新并保存）。
   * @param ticket - 工单。
   */
  const deliver = async (batch, ticket) => {
    const report = ticket.report
    if (report === undefined) return
    if (report.deliveredAt !== undefined) return
    if (typeof batch.parentSessionId !== 'string' || batch.parentSessionId === '') return
    if ((report.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) return

    report.attempts = (report.attempts ?? 0) + 1
    try {
      await faces.dispatcher.run(batch.parentSessionId, envelopeFor(batch, ticket))
      report.deliveredAt = Date.now()
      delete report.lastError
    } catch (error) {
      report.lastError = error instanceof Error ? error.message : String(error)
      warn('[dsh-whale-middleman] 回传没送到主会话（第 ' + report.attempts + ' 次）：' + report.lastError)
    }
    try {
      await save(batch, { expectedRevision: batch.revision })
    } catch (error) {
      warn('[dsh-whale-middleman] 回传状态没写进台账：' + String(error))
    }
  }

  /**
   * 结算一轮：写台账 → 需要时自动续跑 → 投递。
   *
   * @param sessionId - 子会话 id。
   * @param turn - turn 号。
   * @param reason - turn/end 的 reason。
   * @param depth - 冲突重试深度（内部用）。
   */
  const settleTurn = async (sessionId, turn, reason, depth = 0) => {
    const located = await locate(sessionId)
    if (located === undefined) return
    const { batch, ticket } = located
    if (skipReason(ticket) !== undefined) return
    if (ticket.reportedTurn === turn) return

    const verdict = classifyTurnEnd(reason)
    if (verdict.ignore === true) return

    let tail = []
    let tailError
    try {
      tail = await faces.dispatcher.tail(sessionId)
    } catch (error) {
      tailError = error instanceof Error ? error.message : String(error)
      warn('[dsh-whale-middleman] 读子会话历史失败，回传不带正文：' + tailError)
    }
    const text = lastAssistantText(tail)
    const summary = summarize(tail)

    ticket.status = verdict.status
    ticket.finishedAt = Date.now()
    ticket.reportedTurn = turn
    ticket.lastEventAt = Date.now()
    ticket.result = jsonSafe({
      text: text.slice(0, 8000),
      summary,
      note: verdict.note,
      events: tail.length,
      ...(tailError === undefined ? {} : { tailError }),
    })
    ticket.report = jsonSafe({
      turn,
      status: verdict.status,
      note: verdict.note,
      summary,
      text: text.slice(0, 8000),
      settledAt: Date.now(),
      envelopeId: ticket.id + ':' + turn,
      attempts: 0,
      ...(tailError === undefined ? {} : { tailError }),
    })

    try {
      await save(batch, { expectedRevision: batch.revision })
    } catch (error) {
      if (isMiddlemanError(error) && error.code === 'revision-conflict' && depth < 2) {
        // 台账在「读历史」那段时间被改过：重新读一次再结算，别覆盖别人的写入。
        return await settleTurn(sessionId, turn, reason, depth + 1)
      }
      throw error
    }

    // 自动续跑：只对可续的传输中断，且每张票只续一次。
    if (verdict.resumable === true && (ticket.resumeCount ?? 0) < MAX_RESUMES) {
      ticket.resumeCount = (ticket.resumeCount ?? 0) + 1
      try {
        await faces.dispatcher.run(sessionId, CONTINUE_TEXT)
        ticket.report.note = String(ticket.report.note ?? '') + '（已自动续跑第 ' + ticket.resumeCount + ' 次）'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ticket.report.note = String(ticket.report.note ?? '') + '（自动续跑失败：' + message + '，需要人点续跑）'
      }
      try {
        await save(batch, { expectedRevision: batch.revision })
      } catch (error) {
        warn('[dsh-whale-middleman] 续跑结果没写进台账：' + String(error))
      }
    }

    await deliver(batch, ticket)

    // 结算只做两件事：写台账（上面已经写了）、触发一次整批求值（这里）。
    // 后继能不能启动全由 evaluateBatch 决定；被前序失败挡住的票安静地
    // 留在 queued，这里不会给它发任何消息。
    try {
      await relayBatch(faces, batch.id)
    } catch (error) {
      warn('[dsh-whale-middleman] 依赖求值失败：' + String(error))
    }
  }

  /** 扫一遍台账，把没投递出去的回传补投。 */
  const flushOutbox = async () => {
    for (const row of await list()) {
      let batch
      try {
        batch = await load(row.id)
      } catch {
        continue
      }
      for (const ticket of batch.tickets ?? []) {
        if (ticket.report === undefined || ticket.report.deliveredAt !== undefined) continue
        await deliver(batch, ticket)
      }
      // 启动失败的重试也挂在 outbox 扫描上：结算不一定再来第二次
      //（比如前序早就结算完了，只有一张票启动失败），30 秒后要有人再试。
      // 已经重试到上限的票由 evaluateBatch 排除，不会无限开跑。
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
        if (typeof ticket.childSessionId !== 'string') continue
        if (skipReason(ticket) !== undefined) continue
        let tail
        try {
          tail = await faces.dispatcher.tail(ticket.childSessionId)
        } catch {
          continue
        }
        const last = lastTurnEnd(tail)
        if (last === undefined) continue
        if (ticket.reportedTurn === last.turn) continue
        await settleTurn(ticket.childSessionId, last.turn, last.reason)
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
        // 票状态不能只在结束时改：被人用别的方式拉起来的子会话，
        // 否则会一直停在 suspended，结束时还会被 skip 掉——永远不更新。
        const { batch, ticket } = located
        ticket.lastEventAt = Date.now()
        if (ticket.status === 'suspended' || ticket.status === 'queued') ticket.status = 'running'
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
