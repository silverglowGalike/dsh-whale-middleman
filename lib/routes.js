/**
 * 宿主 HTTP 面：中台面板驱动的六个端点，全部挂在 /middleman/api 下。
 *
 * 每个端点答 JSON。拒绝是一个稳定机器码加一句有界的话，不吐栈、不吐台账
 * 全文、不吐会话正文。围栏只放本机浏览器：socket 必须是环回。
 *
 * 关键端点只有一个：POST /run —— 这就是「执行」按钮打的那一下。它不经过
 * 模型，直接由用户点击触发，所以它不属于工具面。
 *
 * @module dsh-whale-middleman/routes
 */
import { MiddlemanError, isMiddlemanError, statusForCode } from './refusals.js'
import { load, list, save } from './ledger.js'
import { patchBatch, patchTicket } from './commit.js'
import { readyTickets, launchableTickets, openCount, isBatchClosed, LAUNCH_FAILED_CODE } from './core.js'
import { buildBrief } from './dispatch.js'
import { relayBatch, notifyLaunchFailure } from './observer.js'
import { retryTicket } from './retry.js'

/** 路由前缀。 */
export const API_PREFIX = '/middleman/api'

/** 请求体上限。 */
const BODY_LIMIT = 64 * 1024

/**
 * 面板「执行」允许开跑的票状态：挂起（等用户点执行）、排队（等前序结算）、
 * 草稿（旧数据 / 刚拆出来还没派发）。其它状态要先被用户处理。
 */
const RUNNABLE_STATUSES = new Set(['suspended', 'queued', 'draft'])

/**
 * 终态：票自己不会再动了。默认不许「执行」。
 *
 * 为什么单独列出来：2026-11-17 21:33 的现场事故里，一张 20:08 就已经
 * `cancelled` 的票被旧条件（有会话 && 不在跑）画上了「执行」按钮，用户误点
 * 之后 /run 没有任何状态检查，直接给它发了一整轮任务书——白烧额度，
 * 21:34 才被用户中止。终态票要不要再跑是**人的决定**，所以只认请求体里
 * 显式的 `force: true`（面板上的「重跑」按钮）。自动流程永远不带它。
 */
const TERMINAL_STATUSES = new Set([
  'cancelled', 'user_interrupted', 'lead_interrupted',
  'done', 'failed', 'partial', 'interrupted',
  'needs_review', 'no_receipt', 'receipt_unverified',
])

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** 写一份 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 拒绝。 */
function refuse(res, status, code, message) {
  writeJson(res, status, { ok: false, code, error: message })
}

/** 读请求体。必须是 JSON 对象：数组/字符串/null 一律拒绝，免得下游 `.batchId` 读到怪东西。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new MiddlemanError('invalid-request', '请求体超过上限')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MiddlemanError('invalid-request', '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MiddlemanError('invalid-request', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 是否是环回连接。 */
export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Host 是不是回环字面量（可带端口，IPv6 用方括号）。
 *
 * 只校验环回 socket 挡不住 DNS rebinding：恶意页面用自己域名解析到
 * 127.0.0.1 后，Origin 与 Host 都是那个域名，同源校验会通过。所以写操作
 * 还要求 Host 本身就是 127.0.0.1 / localhost / [::1]。
 *
 * @param host - 请求头 Host。
 * @returns 是否回环 Host。
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Origin 与 Host 是否同源。
 *
 * 只靠环回围栏挡不住 CSRF：浏览器里的恶意页面可以往 127.0.0.1 发一个
 * `text/plain` 的简单 POST（不触发预检），如果服务端不看 Content-Type，
 * 这个请求就会真的执行 /run、/cancel 这类动作。三道闸：
 * 1. POST 必须带 `application/json`——跨站表单发不出这个类型；
 * 2. Host 必须是回环字面量——挡住 DNS rebinding；
 * 3. 带了 Origin 的请求必须与 Host 同源。
 *
 * @param origin - 请求头 Origin。
 * @param host - 请求头 Host。
 * @returns 是否同源。
 */
export function isSameOrigin(origin, host) {
  if (typeof origin !== 'string' || origin === '' || typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 造六个路由。
 * @param faces - 台账、派发面与配置。
 * @returns WebRoute 数组。
 */
export function makeRoutes(faces) {
  /** 统一包一层：环回围栏 + 错误映射。 */
  const route = (kind, path, handler) => ({
    kind,
    path,
    async handler(req, res) {
      if (!isLoopback(req.socket?.remoteAddress)) {
        refuse(res, 403, 'forbidden', '只接受本机连接')
        return
      }
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') {
        refuse(res, 405, 'method-not-allowed', '只接受 GET 与 POST')
        return
      }
      if (method === 'POST') {
        // 三道 CSRF 闸，见 isLoopbackHost / isSameOrigin 的注释。
        const host = req.headers?.host
        if (!isLoopbackHost(host)) {
          refuse(res, 403, 'forbidden', '只接受回环 Host 的写请求')
          return
        }
        const contentType = req.headers?.['content-type']
        if (typeof contentType !== 'string' || !/^application\/json\b/i.test(contentType.trim())) {
          refuse(res, 415, 'unsupported-media-type', '写操作必须使用 application/json')
          return
        }
        const origin = req.headers?.origin
        if (typeof origin === 'string' && origin !== '' && !isSameOrigin(origin, host)) {
          refuse(res, 403, 'forbidden', '拒绝跨站请求')
          return
        }
      }
      try {
        await handler(req, res)
      } catch (error) {
        if (isMiddlemanError(error)) {
          refuse(res, statusForCode(error.code), error.code, error.message)
          return
        }
        faces.warn?.('[dsh-whale-middleman] 路由失败：' + String(error))
        // 只在本机回环上回显原因：这条围栏已经确认过 socket 是环回，
        // 把原因说出来比让用户去翻日志快得多。
        refuse(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      }
    },
  })

  /**
   * 把一张票的启动结果写回台账。
   *
   * 为什么每张都重读再写：spawn 一张票要跟宿主来回几次，这几秒里观察器
   * 可能刚好写了心跳或回传。拿内存里那份直接覆盖会把这些改动抹掉；用
   * CAS 写又会被一次心跳打断，剩下的票全停在草稿态。所以：重读最新 →
   * 只贴这张票的运行期字段 → 按盘上的 revision 写；冲突重试，不覆盖别人的字段。
   *
   * @param batchId - 批次 id。
   * @param ticket - 内存里这张票的启动结果。
   */
  const commitTicket = async (batchId, ticket) => {
    const outcome = await patchTicket(batchId, ticket.id, (target) => {
      target.status = ticket.status
      if (typeof ticket.childSessionId === 'string') target.childSessionId = ticket.childSessionId
      if (typeof ticket.startedAt === 'number') target.startedAt = ticket.startedAt
      if (ticket.model !== undefined && ticket.model !== null) target.model = ticket.model
      if (typeof ticket.launchFailureCode === 'string') target.launchFailureCode = ticket.launchFailureCode
      else delete target.launchFailureCode
      if (typeof ticket.launchError === 'string') target.launchError = ticket.launchError
      else delete target.launchError
    })
    if (outcome.ok !== true) {
      // 票在 settle 之间被别人删掉/改名：不能因为一张票就中断整批批准
      //（其它票的会话已经建出来了，重来会再建一批）。
      faces.warn?.('[dsh-whale-middleman] 启动结果没写进台账：' + (outcome.message ?? outcome.code))
    }
  }

  return [
    // 状态：全部批次，或一个批次的详情。
    route('prefix', API_PREFIX + '/state', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const id = url.searchParams.get('batchId')
      if (id === null || id === '') {
        const rows = await list()
        writeJson(res, 200, {
          ok: true,
          batches: rows.map((row) => {
            const tickets = Array.isArray(row.tickets) ? row.tickets : []
            // 批次没有自己的「结束」状态：批准之后 status 一直是 approved。
            // 所以「已结束」只能从票上算——口径统一在 core.isBatchClosed，
            // 面板、工具面与这里读同一份，不再手写第二套。
            return {
              id: row.id, title: row.title, status: row.status,
              open: openCount(row),
              tickets: tickets.length,
              createdAt: row.createdAt,
              closed: isBatchClosed(row),
            }
          }),
        })
        return
      }
      const batch = await load(id)
      writeJson(res, 200, {
        ok: true,
        batch,
        ready: readyTickets(batch).map((t) => t.id),
        closed: isBatchClosed(batch),
      })
    }),

    // 批准：只有用户点得到。这是与工具面的分工。
    //
    // 一按就开跑，且**不叫醒主会话**：批准是人的动作，模型不需要被通知。
    route('exact', API_PREFIX + '/approve', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))

      // 已经批过了：再点一次不算错。这条必须放在 CAS 之前——面板上的
      // 批准按钮带着点下去那一刻的 revision，第一次成功后 revision 已经
      // 变了，再点会拿 409 吓用户「批准失败」。
      if (batch.status === 'approved') {
        writeJson(res, 200, {
          ok: true, status: batch.status, alreadyApproved: true, revision: batch.revision,
        })
        return
      }

      // CAS：卡片带着它看到的 revision 来。对不上说明台账在人看卡与点按钮
      // 之间被改过（多半是又一轮 design_split），这时不能拿旧视图批准新内容，
      // 也不能把别人刚写的状态盖回去——409，让用户重读一次再点。
      const expected = body.expectedRevision
      if (expected !== undefined && expected !== null && expected !== batch.revision) {
        refuse(res, 409, 'revision-conflict',
          '台账已被改过（期望 r' + String(expected) + '，盘上是 r' + String(batch.revision)
          + '）：重新读一次再点批准')
        return
      }

      // 没有票的批次不能批准：批准会把整批锁死，而 design_split 在 approved
      // 之后会 ticket-locked。空批次批下去就再也拆不了票，只能重开批次。
      // 正常流程是「收敛 → 拆草稿票 → 批准」，这里守住最后一道。
      if ((batch.tickets ?? []).length === 0) {
        refuse(res, 409, 'empty-batch',
          '这个批次还没有工单：先 design_split 拆票，再批准（批准会立刻开跑）')
        return
      }
      if (batch.status !== 'converged') {
        refuse(res, 409, 'not-converged', '只有收敛后的批次才能批准，当前状态：' + batch.status)
        return
      }

      // 先锁住批次与票，再逐张开跑。
      //
      // 开跑要建会话，一张就可能卡几秒。全攒到最后写的话，中途崩一次
      // 批次还停在 converged，人再点一次就会给已经开跑的票再建一个子会话。
      batch.status = 'approved'
      batch.approvedAt = Date.now()
      batch.approvedBy = 'human'

      const launchable = launchableTickets(batch)
      const launchableIds = new Set(launchable.map((ticket) => ticket.id))
      const queued = []
      for (const ticket of batch.tickets ?? []) {
        if (launchableIds.has(ticket.id)) continue
        if (ticket.status === undefined || ticket.status === 'draft' || ticket.status === 'pending') {
          // 前置未完成的票不是「失败」，只是还没轮到：标 queued，等前序结算。
          ticket.status = 'queued'
          queued.push(ticket.id)
        }
      }
      await save(batch, { expectedRevision: batch.revision })

      // 位置与求值启动同口径：有 workspaceId 就用它，否则用批次记的 cwd。
      // 两个都给会被宿主拒绝，所以这里二选一。
      const workspaceId = batch.workspaceId
      const cwd = workspaceId === undefined ? batch.cwd : undefined

      const launched = []
      const failed = []
      for (const ticket of launchable) {
        try {
          const spawned = await faces.dispatcher.spawn(ticket, {
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(cwd === undefined ? {} : { cwd }),
          })
          ticket.childSessionId = spawned.sessionId
          // 回读宿主真正钉上的模型写进台账，而不是把请求值当成结果。
          if (spawned.model !== undefined && spawned.model !== null) ticket.model = spawned.model
          // 第一条消息只发给子会话。批准**不叫醒主会话**。
          await faces.dispatcher.run(spawned.sessionId, buildBrief(batch, ticket))
          ticket.status = 'running'
          ticket.startedAt = Date.now()
          delete ticket.launchError
          delete ticket.launchFailureCode
          launched.push(ticket.id)
        } catch (error) {
          // 一张票起不来不能连累其它票，也不能让用户以为批准成功却
          // 什么都没跑。但失败票**不能回 draft**：批次已经是 approved，
          // design_split 被 ticketsLocked 锁死，draft 票永远不会再被用户看一眼，
          // 人只能重开整个批次（现场踩过）。
          //
          // 回 queued 才接得上恢复路径：`launchError` 是「别自动重试」的
          // 标记，`launchFailureCode` 是报错族的记账码。主会话 middleman_retry
          // 或用户面板「重试启动」显式清掉标记后才再试。
          ticket.status = 'queued'
          delete ticket.startedAt
          ticket.launchError = error instanceof Error ? error.message : String(error)
          ticket.launchFailureCode = LAUNCH_FAILED_CODE
          failed.push({ ticketId: ticket.id, error: ticket.launchError })
        }
        // 逐票落盘：已经起来的票不能因为后面某张失败而把状态丢回去。
        await commitTicket(batch.id, ticket)
        // 启动失败的票不会再有 turn/end 来结算；批完立刻给主会话报一条，
        // 否则它要等用户去面板上发现「怎么没跑」。
        if (ticket.status === 'queued' && typeof ticket.launchError === 'string') {
          await notifyLaunchFailure(faces, batch, ticket)
        }
      }

      // 批准那一刻就求值一次：被前序挡住的票要立刻拿到 `blockedState`
      // （面板据此显示「卡在谁身上」），已满足依赖的票也顺手补启动。
      // 启动决策不在这里：全部在 core.evaluateBatch / observer.relayBatch。
      //
      // skip 是刚启动失败的票：这一下求值只补 blockedState，**不重试**它们
      //（带 launchError 的票本来也会被 evaluateBatch 排除）。
      try {
        await relayBatch(faces, batch.id, { skip: failed.map((row) => row.ticketId) })
      } catch (error) {
        faces.warn?.('[dsh-whale-middleman] 批准后依赖求值失败：' + String(error))
      }

      writeJson(res, 200, {
        ok: true,
        status: batch.status,
        approvedAt: batch.approvedAt,
        approvedBy: batch.approvedBy,
        launched,
        ...(queued.length === 0 ? {} : { queued }),
        ...(failed.length === 0 ? {} : { failed }),
        note: '已批准。开跑 ' + launched.length + ' 张'
          + (queued.length === 0 ? '' : '，等前序 ' + queued.length + ' 张')
          + (failed.length === 0 ? '' : '，起不来 ' + failed.length + ' 张（保持排队，等下一次重试）')
          + '。没有向主会话发任何消息。',
      })
    }),

    // 执行：把挂起的子会话真正跑起来。这一下由用户点击触发，不经过模型。
    //
    // 状态守卫是 2026-11-17 现场事故的补丁：一张 20:08 就已 cancelled 的票
    // 被误点「执行」，旧实现只拦 running，于是它又被拉起跑了一整轮。
    // 现在只有 suspended / queued / draft 能开跑；终态票默认 409
    //（ticket-terminal），除非请求体显式带 force: true——那是面板上
    // 「重跑」按钮的人工语义，不是自动流程能发出来的东西。
    route('exact', API_PREFIX + '/run', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单：' + String(body.ticketId))
        return
      }
      if (typeof ticket.childSessionId !== 'string') {
        if (ticket.status === 'queued' && typeof ticket.launchError === 'string') {
          // 启动失败过的排队票没有子会话：这不是「还没派发」，而是「起不来」。
          // 让它去 /retry（面板「重试启动」），走报错族的重试预算。
          refuse(res, 409, 'launch-retry-required',
            ticket.id + ' 启动失败过（' + ticket.launchError + '），还没有子会话：'
            + '点「重试启动」（POST /retry），或让主会话调 middleman_retry')
          return
        }
        refuse(res, 409, 'not-dispatched',
          ticket.id + ' 还没有子会话：先等批准，或让主会话重试启动')
        return
      }
      if (ticket.status === 'running') {
        refuse(res, 409, 'already-running', ticket.id + ' 已经在跑了')
        return
      }

      const status = ticket.status
      const force = body.force === true
      const terminal = TERMINAL_STATUSES.has(status)
      if (!RUNNABLE_STATUSES.has(status)) {
        if (!terminal) {
          // waiting（在等用户确认）走 /answer；pending 是旧台账的遗留状态。
          refuse(res, 409, 'ticket-not-runnable',
            ticket.id + ' 当前状态是 ' + String(status) + '，不能点「执行」；先处理完它当前的事')
          return
        }
        if (!force) {
          refuse(res, 409, 'ticket-terminal',
            ticket.id + ' 已经是终态（' + status + '），不再自动开跑；'
            + '要重跑请显式带 force: true（面板上的「重跑」按钮）')
          return
        }
      }

      // 拒绝必须发生在任何副作用之前：上面每次 refuse 之后都直接 return，
      // 一次 dispatcher.run、一次 save 都不该发生（台账一个字节都不能变）。
      await faces.dispatcher.run(ticket.childSessionId, buildBrief(batch, ticket))

      // 回写只贴这一轮真正改过的字段：`dispatcher.run` 是网络往返，这几百
      // 毫秒到几秒里观察器可能刚结算了同批另一张票。拿旧副本整批覆盖会把
      // 那份结算抹掉——所以走 patchTicket，它每次重读最新台账再写。
      // force 重跑：上一轮的产出与结束时间已经不作数了。
      //
      // 不清掉的话，面板会一边显示「运行中」、一边挂着上一轮的回传正文，
      // 人分不清看到的是哪一轮。rerunFrom 记下从哪个终态重跑的（cancelled
      // 与 done 的「重跑」语义不一样），rerunAt 留个时间戳好对账。
      const outcome = await patchTicket(batch.id, ticket.id, (target) => {
        if (terminal) {
          target.rerunAt = Date.now()
          target.rerunFrom = status
          delete target.report
          delete target.finishedAt
        }
        delete target.launchError
        delete target.launchFailureCode
        // 用户动手了：主会话的重试额度还回去（人是最终决策者）。
        delete target.leadRetries
        // 重跑是从头再来：上一轮的中断来源、传输宽限都不再作数。
        delete target.interruptedBy
        delete target.transportGrace
        // 票开始跑了，「卡在谁身上」那份求值数据就过时了。
        delete target.blockedState
        // 上一轮留下的「请确认」也要清掉：observer 的结算守卫只要看到
        // ticket.waiting 还在，就会把这一轮的回传当成「还在等用户」丢掉。
        delete target.waiting
        target.status = 'running'
        target.startedAt = Date.now()
      })
      if (outcome.ok !== true) {
        refuse(res, statusForCode(outcome.code), outcome.code, outcome.message)
        return
      }
      writeJson(res, 200, {
        ok: true,
        ticketId: ticket.id,
        status: 'running',
        ...(terminal ? { rerun: true, rerunFrom: status } : {}),
      })
    }),

    // 重试：用户侧的重试入口。
    //
    // 面板上的「重试」按钮打这一下。它主要接住 /run 接不住的票：启动失败
    // 启动失败过、没有子会话的 queued 票（/run 会 409 launch-retry-required）。
    // 用户重试会把主会话的重试额度清掉——人是最终决策者。
    route('exact', API_PREFIX + '/retry', async (req, res) => {
      const body = await readBody(req)
      const result = await retryTicket(faces, {
        batchId: String(body.batchId ?? ''),
        ticketId: typeof body.ticketId === 'string' ? body.ticketId : '',
        by: 'user',
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      })
      if (result.ok !== true) {
        refuse(res, statusForCode(result.code), result.code, result.message)
        return
      }
      writeJson(res, 200, result)
    }),

    // 修改意见：写进工单，并送到该去的地方。
    //
    // 卡片上的「有修改意见」按钮走这里。意见不能只留在浏览器里——
    // 得有人真的收到它。
    //
    // 送到哪儿取决于这张票在什么状态：
    //   - 子会话正在跑：直接 steer 那个子会话（session.prompt 的 steer 模式）。
    //     用户看到子会话跑偏了，当场就能拉回来，不用等它跑完再返工。
    //   - 票还挂着没跑：没有活着的子会话可 steer，于是推给主会话——
    //     主会话是唯一会读这张票的人，它得在下一轮就看见人说了什么。
    route('exact', API_PREFIX + '/feedback', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单')
        return
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (message === '') {
        refuse(res, 400, 'invalid-request', '意见不能为空')
        return
      }
      const outcome = await patchTicket(batch.id, ticket.id, (target) => {
        target.feedback = [
          ...(Array.isArray(target.feedback) ? target.feedback : []),
          { message, at: Date.now() },
        ]
      })
      if (outcome.ok !== true) {
        refuse(res, statusForCode(outcome.code), outcome.code, outcome.message)
        return
      }
      // 送到哪儿按**盘上最新**的状态判：读请求体那一下与写入之间，票可能
      // 刚好跑完或者刚被判成 waiting。
      const current = outcome.batch
      const currentTicket = (current.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      const running = currentTicket?.status === 'running'
        && typeof currentTicket.childSessionId === 'string'
      if (running) {
        try {
          await faces.dispatcher.steer(currentTicket.childSessionId, message)
          writeJson(res, 200, { ok: true, ticketId: ticket.id, deliveredTo: 'child' })
          return
        } catch (error) {
          // steer 失败不能吞掉——用户以为说到了，其实没送到。
          refuse(res, 502, 'steer-failed', error instanceof Error ? error.message : String(error))
          return
        }
      }

      if (typeof current.parentSessionId === 'string') {
        await faces.dispatcher.run(
          current.parentSessionId,
          '[工单修改意见] ' + ticket.id + ' ' + ticket.title + '\n' + message,
        )
        writeJson(res, 200, { ok: true, ticketId: ticket.id, deliveredTo: 'parent' })
        return
      }
      // 没有主会话可推：意见留在了票上，但没人收到。
      //
      // 不能回 deliveredTo: 'parent'——那是谎报，用户以为说到了。
      // 说清楚它哪儿也没送到，让用户知道得另想办法。
      writeJson(res, 200, {
        ok: true,
        ticketId: ticket.id,
        deliveredTo: 'nowhere',
        note: '这个批次没有记着主会话，意见只存在票上（' + ticket.id + '），没有送出去',
      })
    }),

    // 改模型：立刻换。
    //
    // 票还没派出去（没有子会话）时只改账本，等派发时按新的建；
    // 已经有子会话时直接给它 selectModel——子会话下一次请求就用新模型。
    route('exact', API_PREFIX + '/retarget', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单：' + String(body.ticketId))
        return
      }
      const model = body.model
      if (model === undefined || model === null || typeof model.model !== 'string') {
        refuse(res, 400, 'invalid-request', '必须带 model: {provider, model}')
        return
      }
      // 子会话还没建出来（票还没派）：只改账本上的模型，等派发时按新的建。
      let applied
      if (typeof ticket.childSessionId === 'string') {
        try {
          applied = await faces.dispatcher.selectModel(ticket.childSessionId, model)
        } catch (error) {
          // 会话钉不上模型时不能装作成功——账本改了、实际没改，
          // 卡片上显示的强度就和子会话真正跑的对不上，正是修掉的那个毛病。
          refuse(res, 502, 'model-pin-failed', error instanceof Error ? error.message : String(error))
          return
        }
      }
      // 写回**宿主真正选中的**，不是我们请求的。
      //
      // 为什么：宿主会把模型 id 规范化（m2 → m2-preview），还会在没指定
      // 强度时填上它自己的默认值。写回请求值的话，账本与卡片显示的是
      // 「我们要的」，子会话跑的却是「宿主给定的」——显示的与实际跑的不是
      // 一回事，跟前两天修掉的那个毛病是同一类。
      const effective = applied === undefined || applied === null
        ? model
        : {
          provider: applied.provider ?? model.provider,
          model: applied.model ?? model.model,
          ...(typeof applied.reasoningEffort === 'string'
            ? { reasoningEffort: applied.reasoningEffort }
            : (typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {})),
        }
      const outcome = await patchTicket(batch.id, ticket.id, (target) => {
        target.model = effective
        // 强度只有一个真相来源：model.reasoningEffort。
        // effort 对齐过去，免得两个字段各写各的，卡片显示的与实际跑的又分叉。
        if (typeof effective.reasoningEffort === 'string') {
          target.effort = effective.reasoningEffort
        }
        target.modelReason = typeof body.modelReason === 'string' ? body.modelReason : target.modelReason
      })
      if (outcome.ok !== true) {
        refuse(res, statusForCode(outcome.code), outcome.code, outcome.message)
        return
      }
      writeJson(res, 200, { ok: true, ticketId: ticket.id, model: effective })
    }),

    // 回答子会话的「请确认」。
    //
    // 子会话停下来问时，票变成 waiting。人在这里答一句，票回到 running，
    // 答案作为**新的用户消息**送进那个子会话——它接着往下跑。
    //
    // 为什么不用 steer：steer 是打断正在跑的轮次用的。这时候那一轮已经
    // 结束了（子会话停下来了），要的是「再给它一条消息让它继续」，
    // 那是 queue 模式，不是 steer。
    route('exact', API_PREFIX + '/answer', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单')
        return
      }
      if (ticket.status !== 'waiting') {
        refuse(res, 409, 'not-waiting',
          '这张票没在等用户确认，当前状态：' + String(ticket.status))
        return
      }
      const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
      if (answer === '') {
        refuse(res, 400, 'invalid-request', '回答不能为空')
        return
      }
      const sessionId = ticket.waiting?.sessionId ?? ticket.childSessionId
      if (typeof sessionId !== 'string') {
        refuse(res, 409, 'no-session', '这张票没有可送达的子会话')
        return
      }

      // 先把答案送出去，再改状态。
      //
      // 顺序很重要：反过来的话，发送失败时票已经显示「继续跑」，
      // 而子会话其实没收到——正是这几轮反复修的那类「显示的和实际的
      // 对不上」。
      try {
        await faces.dispatcher.run(
          sessionId,
          '[用户的答复] ' + (ticket.waiting?.question ?? '') + '\n\n' + answer,
        )
      } catch (error) {
        refuse(res, 502, 'deliver-failed',
          '答复没送到子会话：' + (error instanceof Error ? error.message : String(error)))
        return
      }

      const outcome = await patchTicket(batch.id, ticket.id, (target) => {
        target.answers = [
          ...(Array.isArray(target.answers) ? target.answers : []),
          { question: target.waiting?.question, answer, at: Date.now() },
        ]
        delete target.waiting
        target.status = 'running'
      })
      if (outcome.ok !== true) {
        refuse(res, statusForCode(outcome.code), outcome.code, outcome.message)
        return
      }
      writeJson(res, 200, {
        ok: true,
        ticketId: ticket.id,
        status: 'running',
        note: '答复已送到子会话，它接着跑。',
      })
    }),

      // 取消。来源必须记下来：用户按的停止（面板）和主会话调的取消
      // （`by: 'lead'`）是两件事，旧版都记成 cancelled，审计时分不清（I-03）。
      route('exact', API_PREFIX + '/cancel', async (req, res) => {
        const body = await readBody(req)
        const batch = await load(String(body.batchId ?? ''))
        const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
        if (ticket === undefined) {
          refuse(res, 404, 'ticket-missing', '没有这张工单')
          return
        }
        // 与工具面 middleman_cancel 同一套状态守卫：终态票不能被 HTTP
        // 接口翻成 user_interrupted——完成结果会被抹掉，后继也永远不开跑。
        if (!['running', 'waiting', 'queued', 'suspended'].includes(ticket.status)) {
          refuse(res, 409, 'ticket-not-cancellable',
            ticket.id + ' 当前是 ' + String(ticket.status) + '：已经停了或已经结束，不用再取消')
          return
        }
        const by = body.by === 'lead' ? 'lead' : 'user'
        // 先记「谁取消的」，再停会话：宿主在 cancel 期间派发的 aborted
        // turn/end 会读到 interruptedBy，按正确的来源结算；反过来会被
        // 当成用户按的停止（I-03 的审计混淆）。
        const outcome = await patchTicket(batch.id, ticket.id, (target) => {
          target.interruptedBy = by
          target.status = by === 'lead' ? 'lead_interrupted' : 'user_interrupted'
          target.finishedAt = Date.now()
          delete target.waiting
          delete target.transportGrace
        })
        if (outcome.ok !== true) {
          refuse(res, statusForCode(outcome.code), outcome.code, outcome.message)
          return
        }
        if (typeof ticket.childSessionId === 'string' && ticket.childSessionId !== '') {
          try {
            await faces.dispatcher.cancel(ticket.childSessionId)
          } catch (error) {
            faces.warn?.('[dsh-whale-middleman] 取消失败：' + String(error))
          }
        }
        writeJson(res, 200, {
          ok: true,
          ticketId: ticket.id,
          status: by === 'lead' ? 'lead_interrupted' : 'user_interrupted',
          interruptedBy: by,
        })
      }),

    // 模型目录：面板的模型下拉读它。这一条永不失败——拿不到就回空列表，
    // 面板据此退化成手填 provider/model，而不是让整页报错。
    route('exact', API_PREFIX + '/models', async (_req, res) => {
      let diagnostic = null
      try {
        diagnostic = faces.diagnostic?.() ?? null
      } catch (error) {
        diagnostic = { diagnosticFailed: String(error) }
      }
      try {
        const catalog = await faces.dispatcher.modelCatalog()
        writeJson(res, 200, { ok: true, catalog, diagnostic })
      } catch (error) {
        writeJson(res, 200, {
          ok: false,
          code: 'catalog-unavailable',
          error: error instanceof Error ? error.message : String(error),
          diagnostic,
        })
      }
    }),
  ]
}

// 兼容旧的 import 路径：实现搬到了 dispatch.js（观察器自动启动后继票时
// 也要拼同一条消息，不能让它反过来 import HTTP 路由）。
export { buildBrief }