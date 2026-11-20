/**
 * 模型可调用的工具面。
 *
 * 十六个工具：盘问（design_open / design_round / design_question /
 * design_answer / design_plan）、收敛与闸门（design_converge / design_split）、
 * 派发与回传（request_confirmation / middleman_report_done /
 * middleman_status / middleman_inbox）、恢复（middleman_rewire /
 * middleman_rebind / middleman_retry / middleman_reparent，让「失败」和
 * 「换了主会话」都变成可恢复的中间态）。
 *
 * 一条硬规则：**approve 不在这个面上**。批准只能由用户在面板上点，模型
 * 没有对应的工具可调。这就是「模型不能批准自己的设计」这句话的实现。
 *
 * @module dsh-whale-middleman/tools
 */
import {
  frontier, blocked, openCount, nextRound, riskGaps,
  convergeProblems, splitProblems, ticketsLocked,
  launchableTickets, waitingTickets, RISK_FIELDS,
  designGateProblems, MIN_ANSWERED_QUESTIONS, verificationTestGap, answeredQuestionCount,
  evaluateBatch, ticketCycle, TICKET_STATUS, isBatchClosed,
} from './core.js'
import { blankBatch, load, save, list } from './ledger.js'
import { patchBatch, patchTicket } from './commit.js'
import { MiddlemanError } from './refusals.js'
import { relayBatch, invalidateSessionIndex } from './observer.js'
import { retryTicket } from './retry.js'

/** 改依赖表允许的票状态：还没结束的票。批准前是 draft，批准后是 queued。 */
const REWIRABLE_STATUSES = new Set([
  TICKET_STATUS.draft,
  TICKET_STATUS.pending,
  TICKET_STATUS.queued,
])

/** 改绑会话拒绝的票状态：结算过的票再改绑等于改写历史。 */
const REBIND_LOCKED_STATUSES = new Set([
  TICKET_STATUS.done,
  TICKET_STATUS.partial,
  TICKET_STATUS.needs_review,
  TICKET_STATUS.no_receipt,
  TICKET_STATUS.receipt_unverified,
  TICKET_STATUS.cancelled,
  TICKET_STATUS.user_interrupted,
  TICKET_STATUS.lead_interrupted,
])

/** 工具的 JSON Schema 片段：一个必填字符串。 */
const str = (description) => ({ type: 'string', description })

/** 输出统一是一个 JSON 字符串，面板与模型读同一份。 */
const jsonOut = (schema) => ({ schema, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** 把一串拒绝包成一个可读的 ok:false。 */
function refusal(code, problems) {
  return { ok: false, code, problems }
}

/**
 * 安全地取一个字符串。
 *
 * 为什么不能直接 String(x)：String(undefined) 是字符串 "undefined"，
 * 非空，于是它能骗过下游所有 trim() !== '' 的检查。
 *
 * 真出过：design_question 不给 answer 时写成 answer: "undefined"，
 * 设计闸门数它当「已回答」——于是「至少 3 个已回答的问题」这道闸门
 * 一道就能绕过。同理 plan.steps / plan.output。
 *
 * 所以这里只接受真正的字符串；不是字符串就当没给。
 *
 * @param value - 候选值。
 * @param fallback - 不是字符串时的替代值。
 * @returns 字符串。
 */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * 取一个非空字符串；空的话返回 undefined。
 * @param value - 候选值。
 * @returns 字符串或 undefined。
 */
function requiredText(value) {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/**
 * 设计拆票的合并规则。
 *
 * 单独拎出来是因为它有三条互相牵制的约束，而且每条都踩过现场：
 * 1. **合并而不是替换**：原来的写法整份替换 tickets，`childSessionId`、
 *    `reportedTurn`、`result`、`feedback` 全被抹掉——子会话还在跑，台账上
 *    那张票却不见了，再派一次就是第二个子会话，第一个成了孤儿还在计费。
 *    （真机撞到过：第二次只传 T-2，T-1 被抹掉，校验报「T-2 被不存在的
 *    工单阻塞：T-1」并拒绝——拒绝的理由正是它自己刚写坏的状态。）
 * 2. **已派发的票不动**：有 `childSessionId` 的票拒绝改、拒绝删。
 * 3. **先在副本上校验**：不合格就返回 refuse，调用方不落盘。
 *
 * @param batch - 最新读出的批次。
 * @param args - 工具入参（tickets / remove）。
 * @returns `{ refuse }` 或 `{ tickets, draftMode }`。
 */
function planSplit(batch, args) {
  if (args.tickets.some((ticket) => ticket === null || typeof ticket !== 'object')) {
    return { refuse: refusal('invalid-request', ['每张票都得是一个对象，不能有 null']) }
  }
  // 批准之后票就锁死了（F3）：不再改设计、不再新增票。
  //
  // 这条按**批次状态**判，不只看 childSessionId。只看会话 id 的话，
  // 批准后传一张全新的票就能绕过锁定——账本上会多出一张永远没人开跑的
  // 草稿票，「已批准」的批次里又冒出可改的票。
  if (ticketsLocked(batch)) {
    return {
      refuse: refusal('ticket-locked', [
        '批次已' + batch.status + '，票已锁定：要改就用 /feedback 追加指令，要停就 /cancel',
      ]),
    }
  }
  // 拆票只发生在收敛后、批准前：产出的票是草稿态，人批准时才开跑。
  // 批准后由上面的 ticketsLocked 拒绝；盘问中还没收敛，没有规格可拆。
  if (batch.status !== 'converged') {
    return {
      refuse: refusal('split-blocked', [
        '只有收敛后的批次才能拆票，当前状态：' + String(batch.status)
        + '；先把 design_converge 走完',
      ]),
    }
  }
  const draftMode = true
  const previous = new Map((batch.tickets ?? []).map((ticket) => [ticket.id, ticket]))
  const dispatchedIds = new Set(
    (batch.tickets ?? [])
      .filter((ticket) => typeof ticket.childSessionId === 'string')
      .map((ticket) => ticket.id),
  )
  const incomingIdOf = (ticket, index) => (
    typeof ticket.id === 'string' && ticket.id !== '' ? ticket.id : 'T-' + (index + 1)
  )
  const incomingIds = new Set(args.tickets.map((ticket, index) => incomingIdOf(ticket, index)))
  const touchingDispatched = [...incomingIds].filter((id) => dispatchedIds.has(id))
  if (touchingDispatched.length > 0) {
    return {
      refuse: refusal('ticket-locked', [
        '这些票已经启动了，不能就地改：' + touchingDispatched.join('、')
        + '（它们的子会话还在跑。要改就用 /feedback 追加指令，要停就 /cancel）',
      ]),
    }
  }

  const removals = new Set(Array.isArray(args.remove) ? args.remove.filter((id) => typeof id === 'string') : [])
  const lockedRemoval = [...removals].filter((id) => dispatchedIds.has(id))
  if (lockedRemoval.length > 0) {
    return { refuse: refusal('ticket-locked', ['已启动的票不能删：' + lockedRemoval.join('、')]) }
  }

  const merged = []
  for (const [id, old] of previous) {
    if (removals.has(id)) continue
    merged.push(old)
  }
  args.tickets.forEach((ticket, index) => {
    // 推理强度只有一个真相来源：model.reasoningEffort。
    // 派发时钉模型传的就是它（lib/dispatch.js 的 session.selectModel）。
    // 工单里另一个同名字段 effort 只是给用户看的冗余，写进来就以
    // model.reasoningEffort 为准——否则两者会各写各的，卡片显示的强度和
    // 子会话真正跑的不是一回事。
    const model = ticket.model === undefined || ticket.model === null
      ? undefined
      : {
        ...ticket.model,
        ...(typeof ticket.model.reasoningEffort === 'string'
          ? {}
          : (typeof ticket.effort === 'string' && ticket.effort !== ''
            ? { reasoningEffort: ticket.effort }
            : {})),
      }
    const effort = typeof model?.reasoningEffort === 'string'
      ? model.reasoningEffort
      : (typeof ticket.effort === 'string' ? ticket.effort : undefined)
    const id = incomingIdOf(ticket, index)
    const old = previous.get(id)
    const slot = merged.findIndex((candidate) => candidate.id === id)

    // 就地更新：设计字段以传入为准，运行期状态一律保留。
    // 局部更新（只传 id/title/brief）时，没传的可选字段继承旧值——否则
    // 一次「改个标题」会把工单文件、发送内容、执行提示与模型理由全部清空。
    const next = {
      ...(old ?? {}),
      id,
      title: text(ticket.title, old?.title ?? '未命名工单'),
      brief: text(ticket.brief, old?.brief ?? ''),
      blockedBy: Array.isArray(ticket.blockedBy) ? ticket.blockedBy : (old?.blockedBy ?? []),
      riskIds: Array.isArray(ticket.riskIds) ? ticket.riskIds : (old?.riskIds ?? []),
      riskFree: ticket.riskFree === true ? true : (old?.riskFree === true),
      riskFreeReason: typeof ticket.riskFreeReason === 'string'
        ? ticket.riskFreeReason
        : old?.riskFreeReason,
      model: model ?? old?.model,
      modelReason: typeof ticket.modelReason === 'string' ? ticket.modelReason : (old?.modelReason ?? ''),
      // 卡片要给用户看的东西：工单文件、要发送的内容、推理强度、执行提示。
      source: typeof ticket.source === 'string' ? ticket.source : old?.source,
      payload: typeof ticket.payload === 'string' ? ticket.payload : old?.payload,
      effort: effort ?? old?.effort,
      notes: ticket.notes !== undefined && typeof ticket.notes === 'object' && ticket.notes !== null ? {
        before: typeof ticket.notes.before === 'string' ? ticket.notes.before : undefined,
        order: typeof ticket.notes.order === 'string' ? ticket.notes.order : undefined,
        parallel: typeof ticket.notes.parallel === 'string' ? ticket.notes.parallel : undefined,
      } : old?.notes,
      // 草稿态只在「未批准」时存在：批准前可以反复改，批准后整批锁定。
      status: 'draft',
    }
    if (slot >= 0) merged[slot] = next
    else merged.push(next)
  })

  // 先在副本上校验：不合格就不写盘。
  const candidate = { ...batch, tickets: merged }
  const problems = splitProblems(candidate)
  if (problems.length > 0) return { refuse: refusal('split-blocked', problems) }

  return { tickets: merged, draftMode }
}

/**
 * 建工具面。
 * @param faces - 宿主能力与台账。
 * @returns 工具定义数组。
 */
export function buildTools(faces) {
  /** 取一个批次，找不到就抛可读拒绝。 */
  const need = async (id) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new MiddlemanError('invalid-request', '必须带 batchId')
    }
    return await load(id)
  }

  /**
   * 给每个工具套一层参数兜底。
   *
   * 为什么需要：插件用裸 tools.register() 注册，宿主**不按 JSON Schema
   * 校验参数**——模型传 null / undefined / 少传字段都是可能的。除了
   * 各个工具内部已经做的字段校验，还得先保证 args 本身是个对象，
   * 否则第一行 `args.batchId` 就抛 TypeError。
   *
   * 套在一处而不是每个工具各写一遍：写十几遍必然漏一两处。
   */
  /**
   * 当前调用方是不是某个批次的子会话。
   *
   * 子会话不能调 design_* / rewire / rebind：它们会改台账，还可能触发计费
   * 会话（启动后继）。低信任的仓库内容能诱导子会话调工具，这一层必须挡。
   *
   * @param exec - 宿主给的执行上下文。
   * @returns {Promise<boolean>}
   */
  const isChildSession = async (exec) => {
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (faces.confirmations === undefined || typeof faces.confirmations.find !== 'function') return false
    return (await faces.confirmations.find(sessionId)) !== undefined
  }

  /** 只给主会话用的工具。 */
  const LEAD_ONLY = new Set([
    'design_open', 'design_round', 'design_question', 'design_answer',
    'design_plan', 'design_converge', 'design_split',
    'middleman_rewire', 'middleman_rebind',
  ])

  const guarded = (definitions) => definitions.map((definition) => ({
    ...definition,
    async execute(args, exec) {
      const safe = args === null || typeof args !== 'object' || Array.isArray(args) ? {} : args
      if (LEAD_ONLY.has(definition.name) && await isChildSession(exec)) {
        return refusal('not-a-lead', [
          definition.name + ' 是主会话的工具：你是子会话，停下来用 request_confirmation，别自己改台账',
        ])
      }
      return await definition.execute(safe, exec)
    },
  }))

  /**
   * 带 CAS 的改写：每次尝试都重读台账，先在内存里校验并改好，通过了才写盘。
   *
   * 为什么重读：rewire / rebind 是主会话或面板上的一次动作，落盘前可能
   * 刚有结算写过台账；拿旧副本直接写会把它盖掉。CAS 对不上就重来一次。
   * 关键约定：mutate 返回 { refuse } 时**一个字节都不写**——参数校验失败、
   * 票状态不符，都不该在台账上留痕。
   *
   * @param batchId - 批次 id。
   * @param mutate - 接收最新批次；返回 {refuse} 表示拒绝，返回别的表示已就地改好。
   * @returns 成功时 {ok: true, batch}；拒绝时是那个拒绝值。
   */
  const rewriteWithCas = async (batchId, mutate) => {
    const outcome = await patchBatch(batchId, mutate)
    if (outcome.ok !== true) return outcome
    return { ok: true, batch: outcome.batch }
  }

  /**
   * 改完台账后立刻按依赖表求值，并把启动决策交给真正会启动票的那条路径。
   *
   * 决策只来自 `core.evaluateBatch`（纯函数，T-3 抽出来的那一份）；这里不
   * 另写一套「就绪」判断。relayBatch 只负责记录 blockedState 与启动。
   * 宿主没有派发面时（单测里只给了空 dispatcher）跳过启动，但仍带回求值
   * 结果——不假装启动了。
   *
   * @param batch - 刚写完的批次。
   * @returns {{evaluation, relay, canRelay, relayError?}}。
   */
  const evaluateAndRelay = async (batch) => {
    const evaluation = evaluateBatch(batch)
    const dispatcher = faces.dispatcher
    const canRelay = dispatcher !== undefined
      && typeof dispatcher.spawn === 'function'
      && typeof dispatcher.run === 'function'
    if (!canRelay) return { evaluation, relay: { started: [], failed: [] }, canRelay: false }
    try {
      return { evaluation, relay: await relayBatch(faces, batch.id), canRelay: true }
    } catch (error) {
      faces.warn?.('[dsh-whale-middleman] 改完依赖后求值失败：' + String(error))
      return {
        evaluation,
        relay: { started: [], failed: [] },
        canRelay: true,
        relayError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return guarded([
    {
      name: 'design_open',
      description: '开一个设计批次：盘问阶段的容器。拆票之前必须先有批次。中文触发词：设计批次 / 开个设计。',
      parameters: {
        type: 'object',
        properties: {
          title: str('这次要做的事，一句话'),
          decisions: {
            type: 'array',
            description: '初始设计树。每项是 {id, title, body, dependsOn, kind}；kind 取 goal/scope/design/risk/verify。省略时由插件给一棵默认树。',
            items: { type: 'object' },
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        const batch = blankBatch(args.title)
        // 记下开批次的那个会话：子会话结束时，回传要推给它；
        // 同时记下它所在的工作目录与工作区，派发时子会话要落在同一个地方，
        // 否则会掉进 profile 目录（应用自己的目录），跟你的项目完全无关。
        const parent = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof parent === 'string' && parent !== '') batch.parentSessionId = parent
        const cwd = exec?.agent?.session?.header?.cwd
          ?? exec?.agent?.session?.cwd
          ?? exec?.agent?.cwd
          ?? exec?.cwd
        if (typeof cwd === 'string' && cwd !== '') batch.cwd = cwd
        const workspaceId = exec?.agent?.session?.header?.workspaceId
        if (typeof workspaceId === 'string' && workspaceId !== '') batch.workspaceId = workspaceId
        const seeded = Array.isArray(args.decisions) && args.decisions.length > 0
          ? args.decisions.map((decision, index) => ({
            id: typeof decision?.id === 'string' && decision.id !== '' ? decision.id : 'D' + (index + 1),
            kind: typeof decision?.kind === 'string' ? decision.kind : 'design',
            title: text(decision?.title, '未命名决定'),
            body: text(decision?.body),
            dependsOn: Array.isArray(decision?.dependsOn) ? decision.dependsOn : [],
          }))
          : defaultTree()
        batch.decisions = seeded
        // 新批次第一次落盘：expectedRevision: 0 保证「这个 id 还没人写过」。
        // 生成的 id 是随机四位，撞上就报冲突，而不是悄悄盖掉别人的批次。
        await save(batch, { expectedRevision: 0 })
        return {
          ok: true,
          batchId: batch.id,
          status: batch.status,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => d.id),
          blocked: blocked(batch).map((d) => d.id),
          next: nextRound(batch),
        }
      },
    },

    {
      name: 'design_round',
      description: '取下一轮要问的问题。前沿是「前置条件都已满足、现在就能问」的决定。代码保证：只要一条风险都还没登记，这一轮一定带一个风险探测问。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          size: { type: 'number', description: '一轮最多几问，默认 4' },
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        const round = nextRound(batch, typeof args.size === 'number' ? args.size : 4)
        return { ok: true, ...round, risks: batch.risks.length, open: openCount(batch) }
      },
    },

    {
      name: 'design_answer',
      description: '把一个决定定下来，或登记一条风险。定决定用 decisionId + answer；登记风险必须四栏齐全（trigger/impact/mitigation/verification），缺一栏就拒绝——风险不是聊完就忘的段落。验证方式里如果写了「单测」，必须指出是哪个测试文件（如 risk-r1.test.mjs）且那条测试真的存在，否则登记与拆票都会被拒；做不了自动化验证就写「人工核对：…」。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          decisionId: str('决定 id，例如 D3'),
          answer: str('这个决定的答案'),
          deferred: { type: 'boolean', description: '明确推迟这个决定' },
          risk: {
            type: 'object',
            description: '要登记的风险：{title, trigger, impact, mitigation, verification}',
          },
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        // 先确认批次存在（空 batchId 报 invalid-request，而不是「批次不存在」）。
        await need(args.batchId)

        // 同时给 risk 与 decisionId 会让 risk 分支提前返回，那个决定就被
        // 静默丢掉了——调用方以为两个都办了，其实只有风险登记了。
        if (args.risk !== undefined && args.decisionId !== undefined) {
          return refusal('invalid-request', [
            'risk 与 decisionId 只能给一个：两个都给了的话，决定会被静默丢掉',
          ])
        }

        if (args.risk !== undefined) {
          const draft = args.risk
          if (draft === null || typeof draft !== 'object') {
            return refusal('invalid-request', ['risk 得是一个对象'])
          }
          const gaps = riskGaps({
            trigger: draft.trigger,
            impact: draft.impact,
            mitigation: draft.mitigation,
            verification: draft.verification,
          })
          if (gaps.length > 0) {
            return refusal('risk-incomplete', ['风险缺：' + gaps.join('、') + '。四栏是 ' + RISK_FIELDS.map(([, label]) => label).join(' / ')])
          }
          const outcome = await patchBatch(args.batchId, async (fresh) => {
            const risk = {
              id: 'R-' + ((Array.isArray(fresh.risks) ? fresh.risks.length : 0) + 1),
              title: text(draft.title, '未命名风险'),
              trigger: text(draft.trigger),
              impact: text(draft.impact),
              mitigation: text(draft.mitigation),
              verification: text(draft.verification),
              createdAt: Date.now(),
            }
            // 验证方式承诺了单测，就得真有那条测试：写了不等于有。
            const gap = verificationTestGap(risk, await faces.testFiles?.(fresh) ?? [])
            if (gap !== '') return { refuse: refusal('verification-unbacked', [gap]) }
            fresh.risks = Array.isArray(fresh.risks) ? fresh.risks : []
            fresh.risks.push(risk)
            return { result: risk }
          })
          if (outcome.ok !== true) return outcome
          return { ok: true, risk: outcome.result, risks: outcome.batch.risks.length }
        }

        if (typeof args.decisionId !== 'string' || args.decisionId === '') {
          return refusal('invalid-request', ['要么带 decisionId 定一个决定，要么带 risk 登记一条风险'])
        }
        const outcome = await patchBatch(args.batchId, (fresh) => {
          const decision = (fresh.decisions ?? []).find((candidate) => candidate.id === args.decisionId)
          if (decision === undefined) {
            return { refuse: refusal('invalid-request', ['没有这个决定：' + args.decisionId]) }
          }
          if (args.deferred === true) {
            decision.deferred = args.answer ?? '(推迟)'
          } else {
            if (typeof args.answer !== 'string' || args.answer.trim() === '') {
              return { refuse: refusal('invalid-request', ['answer 不能为空；要推迟就传 deferred: true']) }
            }
            decision.answer = args.answer.trim()
          }
          decision.decidedAt = Date.now()
          return { result: decision.id }
        })
        if (outcome.ok !== true) return outcome
        return {
          ok: true,
          decided: outcome.result,
          open: openCount(outcome.batch),
          frontier: frontier(outcome.batch).map((d) => d.id),
        }
      },
    },

    {
      name: 'design_question',
      description: '记一个问过用户的问题和他的答案。这条是盘问的账本：拆票之前至少要有 3 个已回答的问题，否则 design_split 会拒绝。问的时候把「你为什么这么选」「什么情况下这个会失败」这类问题问出来，别自己替用户回答。中文触发词：盘问 / 提问。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          question: str('问用户的问题，原话'),
          answer: str('用户的答案，原话'),
          kind: {
            type: 'string',
            description: '这个问题的性质：goal 目标 / scope 范围 / design 设计 / risk 风险 / verify 验收 / fact 需要自己查的事实',
            enum: ['goal', 'scope', 'design', 'risk', 'verify', 'fact'],
          },
          recommendation: str('你给的推荐答案，以及理由'),
        },
        required: ['batchId', 'question', 'answer'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        await need(args.batchId)
        // 问题与答案都必须真的给了。
        //
        // 不能靠 String(args.answer) —— 那会把「没给」变成字符串
        // "undefined"，非空，于是这道闸门形同虚设。
        const question = requiredText(args.question)
        const answer = requiredText(args.answer)
        if (question === undefined || answer === undefined) {
          return refusal('invalid-request', [
            'question 与 answer 都得给：没给的记下来不算数——盘问的账本记的是「问过什么、用户答了什么」',
          ])
        }
        const outcome = await patchBatch(args.batchId, (batch) => {
          const entry = {
            id: 'Q' + ((Array.isArray(batch.questions) ? batch.questions.length : 0) + 1),
            question,
            answer,
            kind: typeof args.kind === 'string' ? args.kind : 'design',
            ...(args.recommendation === undefined ? {} : { recommendation: text(args.recommendation) }),
            at: Date.now(),
          }
          batch.questions = Array.isArray(batch.questions) ? batch.questions : []
          batch.questions.push(entry)
          return { result: entry }
        })
        if (outcome.ok !== true) return outcome
        const entry = outcome.result
        // 口径跟闸门共用同一个函数——两处各数一遍必然漂。
        const answered = answeredQuestionCount(outcome.batch.questions)
        return {
          ok: true,
          question: entry.id,
          answered,
          needed: MIN_ANSWERED_QUESTIONS,
          note: answered < MIN_ANSWERED_QUESTIONS
            ? '还要再问 ' + (MIN_ANSWERED_QUESTIONS - answered) + ' 个问题才能拆票'
            + (entry.kind === 'fact' ? '（事实型的问题不算盘问——事实是你自己的活）' : '')
            : '盘问够了，接下来写流程规划',
        }
      },
    },

    {
      name: 'design_plan',
      description: '写下这次要做的事的流程规划：分几步、每步产出什么、什么能并行、卡点在哪。拆票之前必须写——没规划就拆票，等于把「怎么做」丢给了子会话自己猜。中文触发词：流程规划 / 怎么分工。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          steps: str('分几步，每步一行，写清楚每步做什么'),
          output: str('做完之后留下什么：文件、报告、还是一次可运行的东西'),
          parallel: str('哪几步可以同时做，为什么'),
          blockers: { type: 'array', description: '已知会卡住的地方', items: { type: 'string' } },
        },
        required: ['batchId', 'steps', 'output'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        await need(args.batchId)
        // steps 与 output 都得真的给了——String(undefined) 是 "undefined"，
        // 非空，能骗过「流程规划缺 steps」这道检查。
        const steps = requiredText(args.steps)
        const output = requiredText(args.output)
        if (steps === undefined || output === undefined) {
          return refusal('invalid-request', [
            'steps 与 output 都得给：没写的规划等于没规划——拆票时子会话会自己猜「怎么做」',
          ])
        }
        const outcome = await patchBatch(args.batchId, (batch) => {
          batch.plan = {
            steps,
            output,
            ...(args.parallel === undefined ? {} : { parallel: text(args.parallel) }),
            ...(Array.isArray(args.blockers) ? { blockers: args.blockers.map((b) => text(b)) } : {}),
            at: Date.now(),
          }
          return { result: batch.plan }
        })
        if (outcome.ok !== true) return outcome
        return { ok: true, plan: outcome.result, gate: designGateProblems(outcome.batch) }
      },
    },

    {
      name: 'design_converge',
      description: '把批次收敛成一份规格。会检查：前沿清空、规格有目标与验收标准、风险四栏齐全、依赖边合法。任何一条不过就返回 problems，不落状态。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          goal: str('一句话目标'),
          nonGoals: { type: 'array', description: '明确不做什么', items: { type: 'string' } },
          acceptance: { type: 'array', description: '验收标准，每条要能跑出红绿', items: { type: 'string' } },
        },
        required: ['batchId', 'goal', 'acceptance'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        await need(args.batchId)
        const goal = requiredText(args.goal)
        if (goal === undefined) {
          return refusal('invalid-request', ['goal 得给一句话目标'])
        }
        const outcome = await patchBatch(args.batchId, (batch) => {
          batch.spec = {
            goal,
            nonGoals: Array.isArray(args.nonGoals) ? args.nonGoals.map((v) => text(v)) : [],
            acceptance: Array.isArray(args.acceptance) ? args.acceptance.map((v) => text(v)) : [],
          }
          // 规格照写（人要看），状态只有全部通过才动。
          const problems = convergeProblems(batch)
          if (problems.length > 0) return { result: { problems } }
          batch.status = 'converged'
          batch.convergedAt = Date.now()
          return { result: { problems: [] } }
        })
        if (outcome.ok !== true) return outcome
        const problems = outcome.result.problems
        if (problems.length > 0) return refusal('converge-blocked', problems)
        return {
          ok: true,
          status: outcome.batch.status,
          note: '已收敛。批准只能由人在中台面板上点，模型没有对应的工具。',
        }
      },
    },

    {
      name: 'design_split',
      description: '把收敛后的设计拆成工单。批次 converged 时产出 status=draft 的草稿票，批准前可以反复改；批准后票锁定、调它会被拒。每张票必须挂至少一条风险（或写 riskFree 加理由）、必须定 model。阻塞边不能成环。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          tickets: {
            type: 'array',
            description: '工单数组，每项 {id, title, brief, blockedBy, riskIds, riskFree, riskFreeReason, model:{provider,model,reasoningEffort}, source, payload, effort, notes:{before,order,parallel}}。**合并语义**：同 id 的票就地更新，没传进来的票原样保留；已派发的票拒绝修改。推理强度只认 model.reasoningEffort——派发时钉模型传的就是它；effort 只是冗余，只在 model 里没写时才用。notes 是给用户看的执行提示：before=开始前要做什么，order=顺序，parallel=可以和谁同时做。',
            items: { type: 'object' },
          },
          remove: {
            type: 'array',
            description: '要删掉的票 id 列表。只允许删还没启动的票。',
            items: { type: 'string' },
          },
        },
        required: ['batchId', 'tickets'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        await need(args.batchId)
        if (!Array.isArray(args.tickets)) {
          return refusal('invalid-request', ['tickets 必须是数组'])
        }
        // 合并在最新副本上算，校验也在副本上：拒绝时一个字节都不落盘。
        const outcome = await patchBatch(args.batchId, (batch) => {
          const plan = planSplit(batch, args)
          if (plan.refuse !== undefined) return { refuse: plan.refuse }
          batch.tickets = plan.tickets
          return { result: { draftMode: plan.draftMode } }
        })
        if (outcome.ok !== true) return outcome
        const batch = outcome.batch
        return {
          ok: true,
          status: batch.status,
          revision: batch.revision,
          ...(outcome.result.draftMode
            ? { draft: true, note: '票是草稿态：人批准后自动开跑；批准前可以反复改。' }
            : {}),
          tickets: batch.tickets.map((t) => ({ id: t.id, title: t.title, blockedBy: t.blockedBy, status: t.status })),
          ready: launchableTickets(batch).map((t) => t.id),
        }
      },
    },

    {
      name: 'middleman_rewire',
      description: '改一张票的依赖表（blockedBy）：上级失败了不想再等它，就把下级从依赖里摘掉；或把新票加进依赖。只允许改还没结束的票（draft / pending / queued）；running / done / failed / waiting / cancelled 一律拒绝。写台账带 CAS，并把这次改动追加进票的 rewires: [{at, from, to}] 审计字段；改完立刻按 core.evaluateBatch 重算整批依赖，满足条件就启动。不向子会话发任何消息。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          ticketId: str('工单 id，例如 T-2'),
          blockedBy: {
            type: 'array',
            description: '这张票新的依赖表（前序工单 id）。空数组表示不依赖任何票',
            items: { type: 'string' },
          },
        },
        required: ['batchId', 'ticketId', 'blockedBy'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const ticketId = requiredText(args.ticketId)
        if (ticketId === undefined) return refusal('invalid-request', ['必须带 ticketId'])
        if (!Array.isArray(args.blockedBy)) {
          return refusal('invalid-request', ['blockedBy 必须是数组；空数组表示不依赖任何票'])
        }
        const next = []
        for (const dep of args.blockedBy) {
          if (typeof dep !== 'string' || dep.trim() === '') {
            return refusal('invalid-request', [
              'blockedBy 里每一项都得是工单 id 字符串（收到 ' + JSON.stringify(dep) + '）',
            ])
          }
          // 去掉重复：同一张票写两遍没有意义，还会让审计里的 from/to 难读。
          if (!next.includes(dep)) next.push(dep)
        }

        const outcome = await rewriteWithCas(args.batchId, (batch) => {
          const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
          const ticket = tickets.find((candidate) => candidate.id === ticketId)
          if (ticket === undefined) {
            return { refuse: refusal('ticket-missing', ['没有这张工单：' + ticketId]) }
          }
          const status = ticket.status ?? TICKET_STATUS.pending
          if (!REWIRABLE_STATUSES.has(status)) {
            return {
              refuse: refusal('ticket-not-rewirable', [
                ticketId + ' 当前是 ' + status
                + '：只有还没结束的票能改依赖表（draft / pending / queued）'
                + '。跑着的票改依赖没有意义；已结束的票要重做请先重开一张票。',
              ]),
            }
          }
          if (next.includes(ticketId)) {
            return { refuse: refusal('invalid-request', [ticketId + ' 不能依赖它自己']) }
          }
          const ids = new Set(tickets.map((candidate) => candidate.id))
          const missing = next.filter((id) => !ids.has(id))
          if (missing.length > 0) {
            return {
              refuse: refusal('dependency-missing', [
                '这些前序工单不存在：' + missing.join('、')
                + '。依赖指向不存在的票，求值会永远判它不满足——先把票建出来，或换一个 id。',
              ]),
            }
          }
          // 按**改完的样子**检环：环里的票互相等，谁也不会有 startable，
          // 也不会有回传；人只会看到「卡住了」。
          const cycle = ticketCycle(tickets.map((candidate) => (
            candidate.id === ticketId ? { ...candidate, blockedBy: next } : candidate
          )))
          if (cycle !== undefined) {
            return {
              refuse: refusal('dependency-cycle', [
                '改完会让依赖成环：' + cycle.join(' -> ') + '（环里的票互相阻塞，永远不会启动）',
              ]),
            }
          }
          const from = Array.isArray(ticket.blockedBy) ? [...ticket.blockedBy] : []
          ticket.blockedBy = next
          ticket.rewires = [
            ...(Array.isArray(ticket.rewires) ? ticket.rewires : []),
            { at: Date.now(), from, to: [...next] },
          ]
          return {}
        })
        if (outcome.ok !== true) return outcome

        const batch = outcome.batch
        const { evaluation, relay, canRelay, relayError } = await evaluateAndRelay(batch)
        // 求值/启动可能又改过台账（queued → running）：回报用盘上的最新状态。
        let current = batch
        try {
          current = await load(batch.id)
        } catch {
          // 读不回来就用内存里这份，至少字段是对的
        }
        const ticketNow = (current.tickets ?? []).find((candidate) => candidate.id === ticketId)
        const started = relay.started.includes(ticketId)
        const note = started
          ? '依赖已改，求值满足，票已自动启动。'
          : canRelay === false
            ? '依赖已改；这个宿主没有可用的派发面，只重算了依赖，没有启动任何票。'
            : batch.status !== 'approved'
              ? '依赖已改；批次还没批准，票不会自己开跑（批准时才开跑）。'
              : '依赖已改，但这次求值没有启动它：看 evaluation.blockedState 卡在谁身上。'
        return {
          ok: true,
          batchId: batch.id,
          batch: { status: current.status, revision: current.revision },
          ticket: {
            id: ticketId,
            status: ticketNow?.status ?? ticket.status,
            blockedBy: ticketNow?.blockedBy ?? next,
            sessionId: ticketNow?.childSessionId,
            rewires: ticketNow?.rewires ?? ticket.rewires,
          },
          evaluation: {
            startable: evaluation.startable,
            blockedState: evaluation.blockedStates[ticketId],
          },
          relay,
          note,
          ...(relayError === undefined ? {} : { relayError }),
        }
      },
    },

    {
      name: 'middleman_rebind',
      description: '把一张票重新绑定到一个新会话（另开一个会话接管失败票）。写 childSessionId 与审计字段 rebinds: [{at, from, to}]，然后立刻按 core.evaluateBatch 重算整批依赖并触发启动。观察器按 childSessionId 反查票，所以重绑后新会话的 turn/end 会结算到这张票；旧会话上没答完的「请确认」随旧会话作废。已结算的票（done / partial / needs_review / no_receipt / receipt_unverified / cancelled）拒绝改绑；同一个会话不能绑给两张票。不向子会话发任何消息。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          ticketId: str('工单 id，例如 T-2'),
          sessionId: str('要绑上去的新子会话 id'),
        },
        required: ['batchId', 'ticketId', 'sessionId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const ticketId = requiredText(args.ticketId)
        if (ticketId === undefined) return refusal('invalid-request', ['必须带 ticketId'])
        const sessionId = requiredText(args.sessionId)
        if (sessionId === undefined) {
          return refusal('invalid-request', ['必须带 sessionId：要绑到的那个新子会话 id'])
        }

        const outcome = await rewriteWithCas(args.batchId, async (batch) => {
          const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
          const ticket = tickets.find((candidate) => candidate.id === ticketId)
          if (ticket === undefined) {
            return { refuse: refusal('ticket-missing', ['没有这张工单：' + ticketId]) }
          }
          if (REBIND_LOCKED_STATUSES.has(ticket.status)) {
            return {
              refuse: refusal('ticket-not-rebindable', [
                ticketId + ' 已经结算成 ' + ticket.status
                + '：改绑会改写历史。要重做就先重开一张票；让它接着做就用 /feedback。',
              ]),
            }
          }
          // 绑到主会话自己会把回传串成主会话的 turn/end，还会让
          // confirmations.find 把主会话认成子会话，把主会话锁在工具外。
          if (sessionId === batch.parentSessionId) {
            return {
              refuse: refusal('invalid-request', [
                '不能把票改绑到主会话自己：回传会串到主会话的 turn/end 上',
              ]),
            }
          }
          // 一个会话只能对应一张票：观察器按 childSessionId 反查，
          // 重复绑定会让回传串到另一张票上（或者只命中其中一张）。
          for (const row of await list()) {
            for (const other of row.tickets ?? []) {
              if (row.id === batch.id && other.id === ticketId) continue
              if (other.childSessionId !== sessionId) continue
              return {
                refuse: refusal('session-already-bound', [
                  '会话 ' + sessionId + ' 已经绑在 ' + row.id + ' 的 ' + other.id
                  + ' 上：一个会话只能对应一张票，否则回传会串票。',
                ]),
              }
            }
          }
          const from = typeof ticket.childSessionId === 'string' ? ticket.childSessionId : null
          ticket.childSessionId = sessionId
          ticket.rebinds = [
            ...(Array.isArray(ticket.rebinds) ? ticket.rebinds : []),
            { at: Date.now(), from, to: sessionId },
          ]
          // 新会话从自己的 1 号 turn 开始。不清掉旧的 reportedTurn，结算会
          // 以为「这一轮已经报过了」，新会话的回传永远进不了台账。
          delete ticket.reportedTurn
          // 旧会话上没答完的问题随旧会话作废：留着的话 skipReason 会把
          // 新会话的 turn/end 当成「这张票在等用户」直接跳过。
          delete ticket.waiting
          // 票还停在 waiting 的话，新会话的 turn/end 仍会被 skipReason 丢掉。
          // 复位成 suspended：等新会话自己 turn/start 时再转 running。
          if (ticket.status === TICKET_STATUS.waiting) ticket.status = TICKET_STATUS.suspended
          // 传输宽限记的是旧会话的 turn；改绑后它不再作数，否则到期会把
          // 新会话结算成 failed/NETWORK_FAILED，给主会话发一条假失败。
          delete ticket.transportGrace
          return {}
        })
        if (outcome.ok !== true) return outcome

        const batch = outcome.batch
        // 新会话不在观察器的索引里：主动作废一次，保证它的 turn/end 立刻能反查。
        invalidateSessionIndex()
        const { evaluation, relay, canRelay, relayError } = await evaluateAndRelay(batch)
        let current = batch
        try {
          current = await load(batch.id)
        } catch {
          // 读不回来就用内存里这份
        }
        const ticketNow = (current.tickets ?? []).find((candidate) => candidate.id === ticketId)
        const started = relay.started.includes(ticketId)
        return {
          ok: true,
          batchId: batch.id,
          batch: { status: current.status, revision: current.revision },
          ticket: {
            id: ticketId,
            status: ticketNow?.status ?? ticket.status,
            sessionId: ticketNow?.childSessionId ?? sessionId,
            rebinds: ticketNow?.rebinds ?? ticket.rebinds,
          },
          evaluation: {
            startable: evaluation.startable,
            blockedState: evaluation.blockedStates[ticketId],
          },
          relay,
          note: canRelay === false
            ? '已改绑；这个宿主没有可用的派发面，只重算了依赖，没有启动任何票。'
            : started
              ? '已改绑，票已按新会话启动。'
              : '已改绑。票的状态没变，后继按 evaluateBatch 的结果照旧等待；新会话的 turn/end 会结算到这张票。',
          ...(relayError === undefined ? {} : { relayError }),
        }
      },
    },

    {
      name: 'middleman_answer',
      description: '主会话专用：回答一张 waiting 票的「请确认」。只用于技术性确认（路径、命名、命令、环境）——方向、范围、取舍必须交给用户。答复作为新消息送进子会话，票回到 running。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          ticketId: str('工单 id，例如 T-2'),
          answer: str('给子会话的答复；写具体，别写「你看着办」'),
        },
        required: ['batchId', 'ticketId', 'answer'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId === 'string' && sessionId !== ''
          && faces.confirmations !== undefined && typeof faces.confirmations.find === 'function') {
          const located = await faces.confirmations.find(sessionId)
          if (located !== undefined) {
            return refusal('not-a-lead', [
              'middleman_answer 是主会话的工具：你是子会话，遇到拿不准的请用 request_confirmation 等答复',
            ])
          }
        }
        const batch = await need(args.batchId)
        const ticketId = requiredText(args.ticketId)
        if (ticketId === undefined) return refusal('invalid-request', ['必须带 ticketId'])
        const answer = requiredText(args.answer)
        if (answer === undefined) return refusal('invalid-request', ['必须带 answer：给子会话的答复不能为空'])
        const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === ticketId)
        if (ticket === undefined) return refusal('ticket-missing', ['没有这张工单：' + ticketId])
        if (ticket.status !== TICKET_STATUS.waiting) {
          return refusal('ticket-not-waiting', [
            ticketId + ' 当前不是 waiting（' + String(ticket.status) + '）：只有子会话停下来问时才需要答复',
          ])
        }
        if (typeof ticket.childSessionId !== 'string' || ticket.childSessionId === '') {
          return refusal('no-session', [ticketId + ' 没有子会话可送答复'])
        }
        const question = typeof ticket.waiting?.question === 'string' ? ticket.waiting.question : ''
        try {
          await faces.dispatcher.run(
            ticket.childSessionId,
            '[主会话的答复] ' + question + '\n\n' + answer,
          )
        } catch (error) {
          return refusal('answer-failed', [
            '答复没送进子会话：' + (error instanceof Error ? error.message : String(error)),
          ])
        }
        const outcome = await patchTicket(batch.id, ticket.id, (target) => {
          target.status = TICKET_STATUS.running
          delete target.waiting
          target.answers = [
            ...(Array.isArray(target.answers) ? target.answers : []),
            { question, answer, at: Date.now(), by: 'lead' },
          ]
        })
        if (outcome.ok !== true) return outcome
        return {
          ok: true,
          ticketId: ticket.id,
          status: TICKET_STATUS.running,
          note: '答复已送到子会话，它接着跑。',
        }
      },
    },

    {
      name: 'middleman_cancel',
      description: '主会话专用：取消一张票（running / waiting / queued / suspended），记 lead_interrupted 并停掉它的子会话。用户按停止/取消的票不能由模型再拉起来。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          ticketId: str('工单 id，例如 T-2'),
          reason: str('可选：为什么取消，写进票的中断来源说明'),
        },
        required: ['batchId', 'ticketId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId === 'string' && sessionId !== ''
          && faces.confirmations !== undefined && typeof faces.confirmations.find === 'function') {
          const located = await faces.confirmations.find(sessionId)
          if (located !== undefined) {
            return refusal('not-a-lead', [
              'middleman_cancel 是主会话的工具：你是子会话，停下来用 request_confirmation，别自己取消',
            ])
          }
        }
        const batch = await need(args.batchId)
        const ticketId = requiredText(args.ticketId)
        if (ticketId === undefined) return refusal('invalid-request', ['必须带 ticketId'])
        const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === ticketId)
        if (ticket === undefined) return refusal('ticket-missing', ['没有这张工单：' + ticketId])
        const cancellable = new Set([
          TICKET_STATUS.running,
          TICKET_STATUS.waiting,
          TICKET_STATUS.queued,
          TICKET_STATUS.suspended,
        ])
        if (!cancellable.has(ticket.status)) {
          return refusal('ticket-not-cancellable', [
            ticketId + ' 当前是 ' + String(ticket.status) + '：已经停了或已经结束，不用再取消',
          ])
        }
        // 先记「谁取消的」，再停会话：宿主在 cancel 期间派发的 aborted
        // turn/end 会读到 interruptedBy，按主会话取消结算；反过来则会被
        // 当成用户按的停止（I-03 的审计混淆）。
        const outcome = await patchTicket(batch.id, ticket.id, (target) => {
          target.status = TICKET_STATUS.lead_interrupted
          target.interruptedBy = 'lead'
          target.finishedAt = Date.now()
          delete target.waiting
          delete target.transportGrace
          delete target.blockedState
          if (typeof args.reason === 'string' && args.reason.trim() !== '') {
            target.interruptReason = args.reason.trim()
          }
        })
        if (outcome.ok !== true) return outcome
        if (typeof ticket.childSessionId === 'string' && ticket.childSessionId !== '') {
          try {
            await faces.dispatcher.cancel(ticket.childSessionId)
          } catch (error) {
            // 取消失败不改变台账：子会话可能已经结束，但票仍要记成主会话取消。
            faces.warn?.('[dsh-whale-middleman] 取消失败：' + String(error))
          }
        }
        return {
          ok: true,
          ticketId: ticket.id,
          status: TICKET_STATUS.lead_interrupted,
          note: '已按主会话取消记账；后继不会自动开跑。',
        }
      },
    },

    {
      name: 'middleman_retry',
      description: '重试一张没跑成的票（主会话用）：queued 且启动失败的票会清掉 launchError 标记、按最新台账重新求值启动；failed / partial / needs_review / no_receipt / receipt_unverified / lead_interrupted 的票会把任务书重发进它已有的子会话。复核族（NEEDS_REVIEW / RECEIPT_UNVERIFIED / NO_RECEIPT）不设上限；报错族（网络中断、启动失败、其它 error）同一错误码最多 5 次，只算主会话主动调的那几次——DSH 自己的重连、60 秒宽限都不消耗额度。额度用完就把情况报告给用户，别硬撑。用户按停止或取消的票不能由模型重试。传 brief 可以换一份任务书重发，等于重设计这张票（批准后 design_split 已锁定，这是主会话改方案的入口）。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          ticketId: str('工单 id，例如 T-2'),
          brief: str('可选：新的任务书。理由是「任务书写歪了」时只重跑同一份 brief 只会再错一次；换掉会写进 retries 审计'),
          reason: str('可选：为什么重试，写进票的 retries 审计'),
        },
        required: ['batchId', 'ticketId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        // 只给主会话：子会话「重跑自己」会绕过批次的启动/结算路径，
        // 它的失败应该写成回执里的 needs_review，由主会话决定怎么办。
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId === 'string' && sessionId !== ''
          && faces.confirmations !== undefined && typeof faces.confirmations.find === 'function') {
          const located = await faces.confirmations.find(sessionId)
          if (located !== undefined) {
            return refusal('not-a-lead', [
              'middleman_retry 是主会话的工具：你是子会话，把失败写进回执'
              + '（outcome: "needs_review"）并说明卡在哪，让主会话决定重跑还是换方案',
            ])
          }
        }
        const result = await retryTicket(faces, {
          batchId: args.batchId,
          ticketId: args.ticketId,
          by: 'lead',
          reason: args.reason,
          brief: args.brief,
        })
        if (result.ok !== true) {
          return refusal(result.code, result.problems ?? [result.message])
        }
        return result
      },
    },

    {
      name: 'middleman_reparent',
      description: '把一个批次的回传改绑到当前会话（换了主会话时用）：不传 sessionId 就绑到自己。写审计字段 reparents: [{at, from, to, reason}]，不向任何子会话发消息。子会话不能认领批次——回传必须发给一个真正能读它的主会话。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          sessionId: str('可选：要绑上去的主会话 id；省略就是当前会话'),
          reason: str('可选：为什么换主会话，写进审计'),
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId === '') {
          return refusal('invalid-request', ['拿不到当前会话 id：没法确定回传该发给谁'])
        }
        const findChild = faces.confirmations !== undefined
          && typeof faces.confirmations.find === 'function'
          ? (id) => faces.confirmations.find(id)
          : async () => undefined
        // 子会话不能给自己改收件人：它是执行一张票的会话，不是读批次的人。
        const self = await findChild(sessionId)
        if (self !== undefined) {
          return refusal('not-a-lead', [
            '当前会话是中台派出的子会话（' + self.batch.id + ' 的 ' + self.ticket.id
            + '）：回传不能改绑给执行者自己，改由主会话认领',
          ])
        }
        const target = typeof args.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : sessionId
        if (target !== sessionId) {
          const other = await findChild(target)
          if (other !== undefined) {
            return refusal('not-a-lead', [
              '目标会话 ' + target + ' 是 ' + other.batch.id + ' 的 ' + other.ticket.id
              + '（子会话）：回传只能发给主会话',
            ])
          }
        }
        const outcome = await patchBatch(args.batchId, (batch) => {
          const from = typeof batch.parentSessionId === 'string' ? batch.parentSessionId : null
          if (from === target) return { result: { changed: false, from } }
          batch.parentSessionId = target
          batch.reparents = [
            ...(Array.isArray(batch.reparents) ? batch.reparents : []),
            {
              at: Date.now(),
              from,
              to: target,
              ...(typeof args.reason === 'string' && args.reason.trim() !== ''
                ? { reason: args.reason.trim() }
                : {}),
            },
          ]
          return { result: { changed: true, from } }
        })
        if (outcome.ok !== true) return outcome
        return {
          ok: true,
          batchId: outcome.batch.id,
          parentSessionId: target,
          changed: outcome.result.changed,
          previousSessionId: outcome.result.from,
          note: outcome.result.changed
            ? '回传现在发给 ' + target + '：之后的结算信封都推到那里。'
            : '本来就是这个会话在收，没改动。',
        }
      },
    },

    {
      name: 'request_confirmation',
      description: '子会话专用：遇到真的走不下去的地方才叫这个工具，停下来等用户。能自己查、能自己判断的就别停——按最合理方案继续，把假设写进最终汇报。调用之后这一轮就该结束，不要继续往下做。提权等待是正常的，不用报错。中文触发词：请确认。',
      parameters: {
        type: 'object',
        properties: {
          question: str('要人定的是什么，一句话。写具体，别写「这样可以吗」'),
          options: {
            type: 'array',
            description: '给用户选的选项，每条一句话；可以不给，那就等用户自由回答',
            items: { type: 'string' },
          },
          recommendation: str('你倾向哪个，以及为什么。人需要这个才能快速拍板'),
          blocking: {
            type: 'boolean',
            description: '是不是真的走不下去了。默认 true；设 false 表示「我先按倾向的做，你有意见再说」',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        // confirmations 是一个对象（带 find 方法），不是一个数组——
        // 别用 Array.isArray 判它。
        if (faces.confirmations === undefined || typeof faces.confirmations.find !== 'function') {
          return refusal('unavailable', ['这个宿主没提供「请确认」通道'])
        }
        const question = requiredText(args.question)
        if (question === undefined) {
          return refusal('invalid-request', ['question 得写清楚要人定什么，别只是「这样可以吗」'])
        }
        const options = Array.isArray(args.options)
          ? args.options.map((item) => text(item)).filter((item) => item !== '')
          : []
        const blocking = args.blocking !== false
        const recommendation = typeof args.recommendation === 'string' ? args.recommendation : undefined

        // 先看这次调用是从哪个子会话来的——靠它反查是哪张票。
        //
        // 为什么不用参数传 ticketId：子会话不知道自己在台账里叫哪张票
        // （它只看得到 brief 里的内容）。让它自己报 id，报错了要么串票、
        // 要么被拒，都是没必要的失败面。用 sessionId 反查是唯一可靠的。
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId === '') {
          return refusal('invalid-request', ['这个工具只能在子会话里调；拿不到当前会话 id'])
        }
        const located = await faces.confirmations.find(sessionId)
        if (located === undefined) {
          return refusal('not-a-dispatched-ticket', [
            '当前会话不是中台派出来的子会话，没有对应的工单可标记',
          ])
        }
        const { batch, ticket } = located
        if (!blocking) {
          // 非阻塞：只留个记录，票继续跑，不打断。
          const advisory = await patchTicket(batch.id, ticket.id, (target) => {
            target.consultations = Array.isArray(target.consultations) ? target.consultations : []
            target.consultations.push({
              question, options, recommendation, blocking: false, at: Date.now(),
            })
          })
          if (advisory.ok !== true) return refusal(advisory.code, [advisory.message])
          return {
            ok: true,
            mode: 'advisory',
            note: '已记下，继续做。用户看到会知道你在等他的意见，但没让他卡住你。',
          }
        }

        // 票变 waiting 是一次状态写入，走 patchTicket：confirmation 渠道给的
        // batch 可能已经是几十毫秒前的快照，期间观察器可能刚写了心跳。
        const marked = await patchTicket(batch.id, ticket.id, (target) => {
          target.status = 'waiting'
          target.waiting = {
            question,
            options,
            recommendation,
            askedAt: Date.now(),
            sessionId,
          }
        })
        if (marked.ok !== true) return refusal(marked.code, [marked.message])

        // 立刻叫醒主会话：**不要等 turn/end**。
        //
        // 为什么：waiting 的票在观察器里是直接 return 的（那是刻意的，免得
        // 「在等你」被结算成「已完成」）。代价是子会话停下来时主会话一个字
        // 都收不到——真机撞到过：子会话 20:26:35 停下等用户，主会话下一轮是
        // 20:57:46；21:32:50 又停，主会话下一轮 23:20:41。两次都靠人自己去
        // 面板上看。这条通知就是补这个洞。
        try {
          const parentId = marked.batch.parentSessionId
          if (typeof parentId === 'string' && parentId !== '') {
            const lines = [
              '[中台] ' + ticket.id + ' 停下等你拍板 · batchId=' + marked.batch.id + ' · ticketId=' + ticket.id,
              '问题：' + question,
            ]
            if (options.length > 0) lines.push('选项：' + options.join(' / '))
            if (recommendation !== undefined && recommendation !== '') lines.push('倾向：' + recommendation)
            lines.push('答复方式：中台面板里答，或直接在这里说「' + ticket.id + '：<你的答复>」。')
            await faces.dispatcher.run(parentId, lines.join('\n'))
          }
        } catch (error) {
          // 通知失败不影响子会话继续等用户：票状态已经写进台账了。
          faces.warn?.('[dsh-whale-middleman] 停下通知没送到主会话：' + String(error))
        }

        return {
          ok: true,
          mode: 'blocking',
          status: 'waiting',
          note: '已停下，等用户确认。这一轮就此结束，不要继续往下做——'
            + '人的答复会作为新消息进来，那时再接着跑。',
        }
      },
    },

    {
      name: 'middleman_report_done',
      description: '子会话专用：交回执 = 自评结果 + 最终汇报。判断主体是子会话：自测通过报 outcome:"done"（主会话收到汇报，后继按依赖自动开跑）；没通过/拿不准报 outcome:"needs_review"（主会话收到汇报，但不会自动开跑）。report 写清做了什么、验证了什么、还剩什么；中台不判断内容，只按自评记账。没有这条回执的一轮按未完成结算（no_receipt）。',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['done', 'needs_review'],
            description: '自评结果：done=自测通过；needs_review=没通过/不完整/拿不准',
          },
          report: str('最终汇报（给主会话看）：做了什么、验证了什么、还剩什么。中台不做语义判断。'),
          note: str('可选：一句话补充，写进回传的「说明」行'),
        },
        required: ['outcome', 'report'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        // 这个工具**不写台账**：回执就是这条 tool/call 的参数，落在子会话历史里，
        // 由 observer.settleTurn 在 turn 结束时按 turn 读取（dispatch.readReceipt）。
        //
        // 为什么不写台账：结算路径本来就要读一遍历史，把回执放进同一次读取就
        // 少一条「工具写台账 → 观察器写台账」的 CAS 竞争路径。多一条写路径，
        // 就多一种「回执写进去了、结算没看见」的失配。
        if (faces.confirmations === undefined || typeof faces.confirmations.find !== 'function') {
          return refusal('unavailable', ['这个宿主没提供回执通道'])
        }
        const outcome = args.outcome
        if (outcome !== 'done' && outcome !== 'needs_review') {
          return refusal('invalid-request', [
            'outcome 只能是 "done"（自测通过）或 "needs_review"（没通过/不完整/拿不准）',
          ])
        }
        const report = typeof args.report === 'string' ? args.report.trim() : ''
        if (report === '') {
          return refusal('invalid-request', [
            'report 不能空：把最终汇报写进去（做了什么、验证了什么、还剩什么），'
            + '主会话要靠它判断下一步',
          ])
        }
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId === '') {
          return refusal('invalid-request', ['这个工具只能在子会话里调；拿不到当前会话 id'])
        }
        const located = await faces.confirmations.find(sessionId)
        if (located === undefined) {
          return refusal('not-a-dispatched-ticket', [
            '当前会话不是中台派出来的子会话，没有对应的工单可交回执',
          ])
        }
        const note = typeof args.note === 'string' ? args.note.trim() : ''
        return {
          ok: true,
          batchId: located.batch.id,
          ticketId: located.ticket.id,
          outcome,
          receipt: 'recorded-in-history',
          ...(report.length > 8000 ? { clipped: true } : {}),
          note: '已记下回执（' + outcome + '）。这一轮结束时中台会核对并回传主会话；'
            + (outcome === 'done'
              ? '依赖满足的后继会自动开跑。'
              : '后继不会自动开跑，等主会话读完汇报再决定。'),
        }
      },
    },

    {
      name: 'middleman_status',
      description: '读一个批次的当前状态：前沿、风险、工单与每张票的子会话。传 ticketId 时连那张票的回传正文一起返回——回传信封让「去台账取正文」，走的就是这里。不传 batchId 时列出全部批次。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id；省略则列出全部'),
          ticketId: str('可选：要取正文的工单 id，例如 T-2；只在给了 batchId 时有意义'),
        },
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        if (typeof args.batchId !== 'string' || args.batchId === '') {
          const rows = await list()
          return {
            ok: true,
            batches: rows.map((row) => ({
              id: row.id, title: row.title, status: row.status,
              open: openCount(row), tickets: (row.tickets ?? []).length,
            })),
          }
        }
        const batch = await need(args.batchId)
        const wanted = typeof args.ticketId === 'string' && args.ticketId !== '' ? args.ticketId : undefined

        /** 单张票的投影：状态 + 回传指针；`withBody` 才带正文（点名时）。 */
        const project = (ticket, withBody = false) => {
          const report = ticket.report
          // 指针 = 「有没有回传」：turn + 状态 + 说明。正文单独放在 reportBody。
          const summary = report === undefined
            ? undefined
            : {
              turn: report.turn,
              status: report.status,
              ...(report.outcome === undefined ? {} : { outcome: report.outcome }),
              ...(report.code === undefined ? {} : { code: report.code }),
              note: report.note,
              settledAt: report.settledAt,
              deliveredAt: report.deliveredAt,
            }
          return {
            id: ticket.id,
            title: ticket.title,
            status: ticket.status,
            sessionId: ticket.childSessionId,
            blockedBy: ticket.blockedBy,
            ...(ticket.lastEventAt === undefined ? {} : { lastEventAt: ticket.lastEventAt }),
            ...(ticket.launchFailureCode === undefined ? {} : { launchFailureCode: ticket.launchFailureCode }),
            ...(ticket.launchError === undefined ? {} : { launchError: ticket.launchError }),
            ...(summary === undefined ? {} : { report: summary }),
            ...(withBody && report !== undefined
              ? { reportBody: { text: report.text, summary: report.summary, tailError: report.tailError } }
              : {}),
          }
        }

        // 点名一张票时只回那一张的投影。
        //
        // 原来是「整批响应里追加 reportBody」：取一次正文返回整份批次——
        // 六张票、全部风险、决策、计划，单次常超过 8k token。信封机制本来
        // 就是为了「正文别进上下文」，取正文时又把全批塞回来，自己打自己。
        if (wanted !== undefined) {
          const target = (batch.tickets ?? []).find((ticket) => (
            ticket !== null && typeof ticket === 'object' && ticket.id === wanted
          ))
          if (target === undefined) {
            return refusal('ticket-missing', [
              '没有这张工单：' + wanted + '。不传 ticketId 可以看整批的票列表',
            ])
          }
          return {
            ok: true,
            scope: 'ticket',
            id: batch.id,
            title: batch.title,
            status: batch.status,
            revision: batch.revision,
            updatedAt: batch.updatedAt,
            closed: isBatchClosed(batch),
            ticket: project(target, true),
          }
        }

        return {
          ok: true,
          scope: 'batch',
          id: batch.id,
          title: batch.title,
          status: batch.status,
          revision: batch.revision,
          updatedAt: batch.updatedAt,
          closed: isBatchClosed(batch),
          open: openCount(batch),
          frontier: frontier(batch).map((d) => ({ id: d.id, title: d.title })),
          risks: (Array.isArray(batch.risks) ? batch.risks : []).map((risk) => ({ id: risk.id, title: risk.title })),
          tickets: (batch.tickets ?? []).map(project),
        }
      },
    },

    {
      name: 'middleman_inbox',
      description: '列出所有停下来等用户的票（waiting）：问题、选项、建议、batchId、ticketId 都在这里。主会话收到「停下等你拍板」的信封后调它取正文；没有票等用户时返回空列表。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('可选：只看这个批次；省略则看全部批次'),
        },
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        // 不传 batchId 就扫全部：人在对话里说「T-1 怎么还没动」时，
        // 主会话未必记得它属于哪个批次，让它去猜只会多一次失败。
        const scope = typeof args.batchId === 'string' && args.batchId !== ''
          ? await need(args.batchId)
          : undefined
        const rows = scope === undefined ? await list() : [scope]
        const waiting = []
        for (const batch of rows) {
          for (const ticket of waitingTickets(batch)) {
            const info = ticket.waiting ?? {}
            waiting.push({
              batchId: batch.id,
              batchTitle: text(batch.title),
              ticketId: ticket.id,
              title: text(ticket.title),
              status: ticket.status,
              question: text(info.question),
              options: Array.isArray(info.options)
                ? info.options.filter((option) => typeof option === 'string')
                : [],
              recommendation: text(info.recommendation),
              ...(typeof info.askedAt === 'number' ? { askedAt: info.askedAt } : {}),
              ...(typeof info.sessionId === 'string'
                ? { sessionId: info.sessionId }
                : (typeof ticket.childSessionId === 'string'
                  ? { sessionId: ticket.childSessionId }
                  : {})),
            })
          }
        }
        return {
          ok: true,
          count: waiting.length,
          waiting,
          ...(waiting.length === 0 ? { note: '现在没有票在等用户拍板' } : {}),
        }
      },
    },
  ])
}

/** 默认设计树：够盘问一轮起步，模型可以按需要增删。 */
export function defaultTree() {
  return [
    { id: 'D1', kind: 'goal', title: '要解决什么问题', body: '一句话说清这次要做什么，以及不做什么。', dependsOn: [] },
    { id: 'D2', kind: 'scope', title: '范围到哪为止', body: '哪些是这次必须做的，哪些明确留给以后。', dependsOn: ['D1'] },
    { id: 'D3', kind: 'design', title: '数据结构长什么样', body: '核心实体与它们的关系；先只写会变的字段。', dependsOn: ['D1'] },
    { id: 'D4', kind: 'design', title: '接口边界放哪里', body: '调用方需要知道什么，实现藏在哪。', dependsOn: ['D3'] },
    { id: 'D5', kind: 'risk', title: '最可能失败的那条路径', body: '给出具体触发条件，不是「可能有风险」。', dependsOn: ['D2'] },
    { id: 'D6', kind: 'verify', title: '怎么算做完了', body: '可执行的验收标准，能跑出红绿的那种。', dependsOn: ['D2', 'D4'] },
  ]
}
