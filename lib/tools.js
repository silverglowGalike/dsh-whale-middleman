/**
 * 模型可调用的工具面。
 *
 * 十三个工具：盘问（design_open / design_round / design_question /
 * design_answer / design_plan）、收敛与闸门（design_converge / design_split）、
 * 派发与回传（dispatch_task / request_confirmation / middleman_status /
 * middleman_inbox）、恢复（middleman_rewire / middleman_rebind，让「失败」
 * 变成可恢复的中间态）。
 *
 * 一条硬规则：**approve 不在这个面上**。批准只能由人在面板上点，模型
 * 没有对应的工具可调。这就是「模型不能批准自己的设计」这句话的实现。
 *
 * @module dsh-whale-middleman/tools
 */
import {
  frontier, blocked, openCount, nextRound, riskGaps,
  convergeProblems, dispatchProblems, splitProblems, ticketsLocked,
  readyTickets, launchableTickets, waitingTickets, RISK_FIELDS,
  designGateProblems, MIN_ANSWERED_QUESTIONS, verificationTestGap, answeredQuestionCount,
  evaluateBatch, ticketCycle, TICKET_STATUS,
} from './core.js'
import { blankBatch, load, save, list } from './ledger.js'
import { MiddlemanError, isMiddlemanError } from './refusals.js'
import { relayBatch, invalidateSessionIndex } from './observer.js'

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
  TICKET_STATUS.cancelled,
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
  const guarded = (definitions) => definitions.map((definition) => ({
    ...definition,
    async execute(args, exec) {
      const safe = args === null || typeof args !== 'object' || Array.isArray(args) ? {} : args
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const batch = await need(batchId)
      const outcome = await mutate(batch)
      if (outcome !== undefined && outcome.refuse !== undefined) return outcome.refuse
      try {
        await save(batch, { expectedRevision: batch.revision })
        return { ok: true, batch }
      } catch (error) {
        if (isMiddlemanError(error) && error.code === 'revision-conflict' && attempt < 2) continue
        throw error
      }
    }
    throw new MiddlemanError('revision-conflict', '台账一直在被别人改：重读一次再试')
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
      description: '开一个设计批次：盘问阶段的容器。派发任何子任务之前必须先有批次，dispatch_task 会拒绝没有 batchId 的调用。中文触发词：设计批次 / 开个设计。',
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
        await save(batch)
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
      description: '把一个决定定下来，或登记一条风险。定决定用 decisionId + answer；登记风险必须四栏齐全（trigger/impact/mitigation/verification），缺一栏就拒绝——风险不是聊完就忘的段落。验证方式里如果写了「单测」，必须指出是哪个测试文件（如 risk-r1.test.mjs）且那条测试真的存在，否则登记与派发都会被拒；做不了自动化验证就写「人工核对：…」。',
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
        const batch = await need(args.batchId)

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
          const risk = {
            id: 'R-' + (batch.risks.length + 1),
            title: text(draft.title, '未命名风险'),
            trigger: text(draft.trigger),
            impact: text(draft.impact),
            mitigation: text(draft.mitigation),
            verification: text(draft.verification),
            createdAt: Date.now(),
          }
          // 验证方式承诺了单测，就得真有那条测试：写了不等于有。
          const gap = verificationTestGap(risk, await faces.testFiles?.(batch) ?? [])
          if (gap !== '') return refusal('verification-unbacked', [gap])
          batch.risks.push(risk)
          await save(batch)
          return { ok: true, risk, risks: batch.risks.length }
        }

        if (typeof args.decisionId !== 'string' || args.decisionId === '') {
          return refusal('invalid-request', ['要么带 decisionId 定一个决定，要么带 risk 登记一条风险'])
        }
        const decision = batch.decisions.find((candidate) => candidate.id === args.decisionId)
        if (decision === undefined) {
          return refusal('invalid-request', ['没有这个决定：' + args.decisionId])
        }
        if (args.deferred === true) {
          decision.deferred = args.answer ?? '(推迟)'
        } else {
          if (typeof args.answer !== 'string' || args.answer.trim() === '') {
            return refusal('invalid-request', ['answer 不能为空；要推迟就传 deferred: true'])
          }
          decision.answer = args.answer.trim()
        }
        decision.decidedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          decided: decision.id,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => d.id),
        }
      },
    },

    {
      name: 'design_question',
      description: '记一个问过用户的问题和他的答案。这条是盘问的账本：派发之前至少要有 3 个已回答的问题，否则 dispatch_task 会拒绝。问的时候把「你为什么这么选」「什么情况下这个会失败」这类问题问出来，别自己替用户回答。中文触发词：盘问 / 提问。',
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
        const batch = await need(args.batchId)
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
        const entry = {
          id: 'Q' + (batch.questions.length + 1),
          question,
          answer,
          kind: typeof args.kind === 'string' ? args.kind : 'design',
          ...(args.recommendation === undefined ? {} : { recommendation: text(args.recommendation) }),
          at: Date.now(),
        }
        batch.questions.push(entry)
        await save(batch)
        // 口径跟闸门共用同一个函数——两处各数一遍必然漂。
        const answered = answeredQuestionCount(batch.questions)
        return {
          ok: true,
          question: entry.id,
          answered,
          needed: MIN_ANSWERED_QUESTIONS,
          note: answered < MIN_ANSWERED_QUESTIONS
            ? '还要再问 ' + (MIN_ANSWERED_QUESTIONS - answered) + ' 个问题才能派发'
            + (entry.kind === 'fact' ? '（事实型的问题不算盘问——事实是你自己的活）' : '')
            : '盘问够了，接下来写流程规划',
        }
      },
    },

    {
      name: 'design_plan',
      description: '写下这次要做的事的流程规划：分几步、每步产出什么、什么能并行、卡点在哪。派发之前必须写——没规划就派发，等于把「怎么做」丢给了子会话自己猜。中文触发词：流程规划 / 怎么分工。',
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
        const batch = await need(args.batchId)
        // steps 与 output 都得真的给了——String(undefined) 是 "undefined"，
        // 非空，能骗过「流程规划缺 steps」这道检查。
        const steps = requiredText(args.steps)
        const output = requiredText(args.output)
        if (steps === undefined || output === undefined) {
          return refusal('invalid-request', [
            'steps 与 output 都得给：没写的规划等于没规划——派发时子会话会自己猜「怎么做」',
          ])
        }
        batch.plan = {
          steps,
          output,
          ...(args.parallel === undefined ? {} : { parallel: text(args.parallel) }),
          ...(Array.isArray(args.blockers) ? { blockers: args.blockers.map((b) => text(b)) } : {}),
          at: Date.now(),
        }
        await save(batch)
        return { ok: true, plan: batch.plan, gate: designGateProblems(batch) }
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
        const batch = await need(args.batchId)
        const goal = requiredText(args.goal)
        if (goal === undefined) {
          return refusal('invalid-request', ['goal 得给一句话目标'])
        }
        batch.spec = {
          goal,
          nonGoals: Array.isArray(args.nonGoals) ? args.nonGoals.map((v) => text(v)) : [],
          acceptance: Array.isArray(args.acceptance) ? args.acceptance.map((v) => text(v)) : [],
        }
        const problems = convergeProblems(batch)
        if (problems.length > 0) {
          await save(batch)
          return refusal('converge-blocked', problems)
        }
        batch.status = 'converged'
        batch.convergedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          status: batch.status,
          note: '已收敛。批准只能由人在中台面板上点，模型没有对应的工具。',
        }
      },
    },

    {
      name: 'design_split',
      description: '把收敛后的设计拆成工单。批次 converged 时产出 status=draft 的草稿票，批准前可以反复改；批准后票锁定、调它会被拒。每张票必须挂至少一条风险（或写 riskFree 加理由）、必须写 modelReason（为什么选这个模型）、必须写 model。阻塞边不能成环。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          tickets: {
            type: 'array',
            description: '工单数组，每项 {id, title, brief, blockedBy, riskIds, riskFree, riskFreeReason, model:{provider,model,reasoningEffort}, modelReason, source, payload, effort, notes:{before,order,parallel}}。**合并语义**：同 id 的票就地更新，没传进来的票原样保留；已派发的票拒绝修改。推理强度只认 model.reasoningEffort——派发时钉模型传的就是它；effort 只是冗余，只在 model 里没写时才用。notes 是给人看的执行提示：before=开始前要做什么，order=顺序，parallel=可以和谁同时做。',
            items: { type: 'object' },
          },
          remove: {
            type: 'array',
            description: '要删掉的票 id 列表。只允许删还没派发的票。',
            items: { type: 'string' },
          },
        },
        required: ['batchId', 'tickets'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        // 批准之后票就锁死了（F3）：不再改设计、不再新增票。
        //
        // 这条按**批次状态**判，不只看 childSessionId。只看会话 id 的话，
        // 批准后传一张全新的票就能绕过锁定——账本上会多出一张永远没人
        // 开跑的草稿票，「已批准」的批次里又冒出可改的票。
        if (ticketsLocked(batch)) {
          return refusal('ticket-locked', [
            '批次已' + batch.status + '，票已锁定：要改就用 /feedback 追加指令，要停就 /cancel',
          ])
        }
        if (!Array.isArray(args.tickets)) {
          return refusal('invalid-request', ['tickets 必须是数组'])
        }
        // 收敛后、批准前：产出的票是草稿态，人批准时才开跑。
        // 其余状态照旧走 dispatchProblems（会明确拒绝「还没批准」）。
        const draftMode = batch.status === 'converged'
        if (args.tickets.some((ticket) => ticket === null || typeof ticket !== 'object')) {
          return refusal('invalid-request', ['每张票都得是一个对象，不能有 null'])
        }
        // 已经派出去的票要保住。
        //
        // 为什么：原来的写法整份替换 tickets——于是 childSessionId、
        // dispatchedAt、reportedTurn、result、feedback 全被抹掉。那张票的
        // 子会话还在跑，却从账本上消失了：再派一次就是第二个子会话，
        // 第一个成了孤儿，还在计费。**真机撞到过**：第二次 design_split
        // 只传 T-2，T-1 被抹掉，校验于是报「T-2 被不存在的工单阻塞：T-1」
        // 并拒绝——拒绝的理由，正是它自己刚写坏的状态。
        //
        // 现在改两件事：
        // 1. 合并而不是替换：没传进来的票原样保留。
        // 2. 先在副本上校验，通过了才写盘——拒绝时不落盘。
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
          return refusal('ticket-locked', [
            '这些票已经派出去了，不能就地改：' + touchingDispatched.join('、')
            + '（它们的子会话还在跑。要改就用 /feedback 追加指令，要停就 /cancel）',
          ])
        }

        const removals = new Set(Array.isArray(args.remove) ? args.remove.filter((id) => typeof id === 'string') : [])
        const lockedRemoval = [...removals].filter((id) => dispatchedIds.has(id))
        if (lockedRemoval.length > 0) {
          return refusal('ticket-locked', ['已派发的票不能删：' + lockedRemoval.join('、')])
        }

        const merged = []
        for (const [id, old] of previous) {
          if (removals.has(id)) continue
          merged.push(old)
        }
        args.tickets.forEach((ticket, index) => {
          // 推理强度只有一个真相来源：model.reasoningEffort。
          // 派发时钉模型传的就是它（lib/dispatch.js 的 session.selectModel）。
          // 工单里另一个同名字段 effort 只是给人看的冗余，写进来就以
          // model.reasoningEffort 为准——否则两者会各写各的，卡片显示的
          // 强度和子会话真正跑的不是一回事。
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
          const next = {
            ...(old ?? {}),
            id,
            title: text(ticket.title, old?.title ?? '未命名工单'),
            brief: text(ticket.brief, old?.brief ?? ''),
            blockedBy: Array.isArray(ticket.blockedBy) ? ticket.blockedBy : (old?.blockedBy ?? []),
            riskIds: Array.isArray(ticket.riskIds) ? ticket.riskIds : (old?.riskIds ?? []),
            riskFree: ticket.riskFree === true,
            riskFreeReason: typeof ticket.riskFreeReason === 'string' ? ticket.riskFreeReason : undefined,
            model,
            modelReason: typeof ticket.modelReason === 'string' ? ticket.modelReason : '',
            // 卡片要给人看的东西：工单文件、要发送的内容、推理强度、执行提示。
            source: typeof ticket.source === 'string' ? ticket.source : undefined,
            payload: typeof ticket.payload === 'string' ? ticket.payload : undefined,
            effort,
            notes: ticket.notes !== undefined && typeof ticket.notes === 'object' && ticket.notes !== null ? {
              before: typeof ticket.notes.before === 'string' ? ticket.notes.before : undefined,
              order: typeof ticket.notes.order === 'string' ? ticket.notes.order : undefined,
              parallel: typeof ticket.notes.parallel === 'string' ? ticket.notes.parallel : undefined,
            } : undefined,
            // 草稿态只在「未批准」时存在：批准前可以反复改，批准后整批锁定。
            status: draftMode ? 'draft' : (old?.status ?? 'pending'),
          }
          if (slot >= 0) merged[slot] = next
          else merged.push(next)
        })

        // 先在副本上校验：不合格就**不写盘**。
        //
        // 草稿态用的是 splitProblems（跳过「已批准」这一条，其余照旧）；
        // 其它状态沿用 dispatchProblems，行为不变。
        const candidate = { ...batch, tickets: merged }
        const problems = draftMode ? splitProblems(candidate) : dispatchProblems(candidate)
        if (problems.length > 0) return refusal('split-blocked', problems)

        batch.tickets = merged
        await save(batch, { expectedRevision: batch.revision })
        return {
          ok: true,
          status: batch.status,
          revision: batch.revision,
          ...(draftMode
            ? { draft: true, note: '票是草稿态：人批准后自动开跑；批准前可以反复改。' }
            : {}),
          tickets: batch.tickets.map((t) => ({ id: t.id, title: t.title, blockedBy: t.blockedBy, status: t.status })),
          ready: launchableTickets(batch).map((t) => t.id),
        }
      },
    },

    {
      name: 'dispatch_task',
      description: '把一张已批准、已就绪的工单派成一个独立子会话并挂起。必须带 batchId：没有批次的派发一律拒绝，这条规则就是为了防止主会话把本工具当成普通 subagent 用。派发前还必须走完盘问与规划：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险，否则同样拒绝。子会话建好、模型定好，但不发第一条消息——要等人点执行。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id。必填，没有它一律拒绝'),
          ticketId: str('工单 id，例如 T-1'),
          workspaceId: str('可选的 workspace id'),
          agentPreset: str('可选的 agent preset id'),
        },
        required: ['batchId', 'ticketId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        // R-1：这一条就是那条风险的缓解措施，写在代码里。
        if (typeof args.batchId !== 'string' || args.batchId.trim() === '') {
          throw new MiddlemanError('batch-required', 'dispatch_task 必须带 batchId：没有设计批次的派发一律拒绝')
        }
        const batch = await need(args.batchId)
        // 派发是最后一道关口：这里再查一遍「承诺的单测在不在」——
        // 登记风险时放过、后来一直没写的那条，在这里拦住。
        const problems = dispatchProblems(batch, await faces.testFiles?.(batch) ?? [])
        if (problems.length > 0) return refusal('dispatch-blocked', problems)

        const ticket = batch.tickets.find((candidate) => candidate.id === args.ticketId)
        if (ticket === undefined) return refusal('ticket-missing', ['没有这张工单：' + args.ticketId])
        if (!readyTickets(batch).includes(ticket)) {
          return refusal('ticket-not-ready', [ticket.id + ' 还没就绪：前置工单未完成，或它已经在跑'])
        }

        // 位置：显式参数 > 批次记下的工作区 > 批次记下的 cwd。
        // session.create 接受 workspaceId 或 cwd，不能两个都给。
        const workspaceId = args.workspaceId ?? batch.workspaceId
        const cwd = workspaceId === undefined ? batch.cwd : undefined
        const spawned = await faces.dispatcher.spawn(ticket, {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        })
        ticket.childSessionId = spawned.sessionId
        ticket.model = spawned.model
        ticket.status = 'suspended'
        ticket.dispatchedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          ticketId: ticket.id,
          sessionId: spawned.sessionId,
          status: 'suspended',
          note: '子会话已建好并挂起。在中台面板上点「执行」才真正开始；点之前它不会花任何额度。',
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
      description: '把一张票重新绑定到一个新会话（另开一个会话接管失败票）。写 childSessionId 与审计字段 rebinds: [{at, from, to}]，然后立刻按 core.evaluateBatch 重算整批依赖并触发启动。观察器按 childSessionId 反查票，所以重绑后新会话的 turn/end 会结算到这张票；旧会话上没答完的「请确认」随旧会话作废。已结算的票（done / partial / cancelled）拒绝改绑；同一个会话不能绑给两张票。不向子会话发任何消息。',
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
          // 新会话的 turn/end 当成「这张票在等人」直接跳过。
          delete ticket.waiting
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
      name: 'request_confirmation',
      description: '子会话专用：遇到需要人拍板的地方就叫这个工具，停下来等人。别自己替人做决定——把「要定什么」「有哪几个选项」「你倾向哪个」写清楚，人答完你接着跑。调用之后这一轮就该结束，不要继续往下做。中文触发词：请确认。',
      parameters: {
        type: 'object',
        properties: {
          question: str('要人定的是什么，一句话。写具体，别写「这样可以吗」'),
          options: {
            type: 'array',
            description: '给人选的选项，每条一句话；可以不给，那就等人自由回答',
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
          ticket.consultations = Array.isArray(ticket.consultations) ? ticket.consultations : []
          ticket.consultations.push({
            question, options, recommendation, blocking: false, at: Date.now(),
          })
          await save(batch)
          return {
            ok: true,
            mode: 'advisory',
            note: '已记下，继续做。人看到会知道你在等他的意见，但没让他卡住你。',
          }
        }

        ticket.status = 'waiting'
        ticket.waiting = {
          question,
          options,
          recommendation,
          askedAt: Date.now(),
          sessionId,
        }
        await save(batch, { expectedRevision: batch.revision })

        // 立刻叫醒主会话：**不要等 turn/end**。
        //
        // 为什么：waiting 的票在观察器里是直接 return 的（那是刻意的，免得
        // 「在等你」被结算成「已完成」）。代价是子会话停下来时主会话一个字
        // 都收不到——真机撞到过：子会话 20:26:35 停下等人，主会话下一轮是
        // 20:57:46；21:32:50 又停，主会话下一轮 23:20:41。两次都靠人自己去
        // 面板上看。这条通知就是补这个洞。
        try {
          const parentId = batch.parentSessionId
          if (typeof parentId === 'string' && parentId !== '') {
            const lines = [
              '[中台] ' + ticket.id + ' 停下等你拍板 · batchId=' + batch.id + ' · ticketId=' + ticket.id,
              '问题：' + question,
            ]
            if (options.length > 0) lines.push('选项：' + options.join(' / '))
            if (recommendation !== undefined && recommendation !== '') lines.push('倾向：' + recommendation)
            lines.push('答复方式：中台面板里答，或直接在这里说「' + ticket.id + '：<你的答复>」。')
            await faces.dispatcher.run(parentId, lines.join('\n'))
          }
        } catch (error) {
          // 通知失败不影响子会话继续等人：票状态已经写进台账了。
          faces.warn?.('[dsh-whale-middleman] 停下通知没送到主会话：' + String(error))
        }

        return {
          ok: true,
          mode: 'blocking',
          status: 'waiting',
          note: '已停下，等人确认。这一轮就此结束，不要继续往下做——'
            + '人的答复会作为新消息进来，那时再接着跑。',
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
        return {
          ok: true,
          id: batch.id,
          title: batch.title,
          status: batch.status,
          revision: batch.revision,
          updatedAt: batch.updatedAt,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => ({ id: d.id, title: d.title })),
          risks: (Array.isArray(batch.risks) ? batch.risks : []).map((risk) => ({ id: risk.id, title: risk.title })),
          tickets: (batch.tickets ?? []).map((ticket) => {
            const report = ticket.report
            // 每张票都给一个「有没有回传」的指针：turn + 状态 + 说明。
            // 正文只在点名要它的时候给——不然一次状态查询就把几个 8KB 的
            // 正文全塞进上下文，正是信封机制想避免的事。
            const summary = report === undefined
              ? undefined
              : {
                turn: report.turn,
                status: report.status,
                note: report.note,
                settledAt: report.settledAt,
                deliveredAt: report.deliveredAt,
              }
            const wantedHere = wanted !== undefined && wanted === ticket.id
            return {
              id: ticket.id,
              title: ticket.title,
              status: ticket.status,
              sessionId: ticket.childSessionId,
              blockedBy: ticket.blockedBy,
              ...(ticket.lastEventAt === undefined ? {} : { lastEventAt: ticket.lastEventAt }),
              ...(ticket.launchError === undefined ? {} : { launchError: ticket.launchError }),
              ...(summary === undefined ? {} : { report: summary }),
              ...(wantedHere && report !== undefined
                ? {
                  reportBody: {
                    text: report.text,
                    summary: report.summary,
                    tailError: report.tailError,
                  },
                }
                : {}),
            }
          }),
        }
      },
    },

    {
      name: 'middleman_inbox',
      description: '列出所有停下来等人的票（waiting）：问题、选项、建议、batchId、ticketId 都在这里。主会话收到「停下等你拍板」的信封后调它取正文；没有票等人时返回空列表。',
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
          ...(waiting.length === 0 ? { note: '现在没有票在等人拍板' } : {}),
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
