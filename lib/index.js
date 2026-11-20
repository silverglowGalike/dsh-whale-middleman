/**
 * dsh-whale-middleman 宿主半区。
 *
 * 把四块接起来：工具面（模型调）、路由（面板调）、回传观察器（子会话结束
 * 时推回主会话）、以及一条系统提示段（告诉模型这个面的存在与硬规则）。
 *
 * 所有宿主能力都是「按需解析」而不是在 apply 时抓一次：官方服务的初始化
 * 是异步的，抓早了会永远 undefined。
 *
 * @module dsh-whale-middleman
 */
import { buildTools } from './tools.js'
import { createDispatcher } from './dispatch.js'
import { makeRoutes } from './routes.js'
import { installObserver } from './observer.js'
import { MiddlemanError } from './refusals.js'
import { list, load } from './ledger.js'
import { listTestFiles } from './verifyscan.js'
import { jsonSafe } from './core.js'

/** 服务名：本行需要宿主先备好这些。 */
export const inject = ['tools', 'typertGateway', 'webServer', 'llm', 'systemPrompt', 'agentDefaultModel']

/** 系统提示段的名字，本包自己的命名空间。 */
export const PROMPT_SECTION = 'plugin:middleman'

/**
 * 系统提示段的正文：告诉模型这个面存在、怎么用、以及那几条硬规则。
 *
 * 这一段是「增强型训练」的地方：把 ask-matt 那套流程的骨架写进去——先盘问
 * 再动手、事实自己查、决定问用户、每轮带风险探测——并且把闸门的存在写明，
 * 让模型知道哪些动作会被拒，而不是撞了墙才学。
 */
export const PROMPT_TEXT = [
  'dsh-whale-middleman（中台，原型是 whale-tail「鲸鱼尾巴」插件）是本机的中台：主会话在这里盘问、收敛设计，再把设计拆成工单派给独立的子会话。子会话遇到需要用户拍板的地方会主动停下来问你——它管的是方向，不是让 AI 游得更快。',
  '',
  '## 什么时候该用它',
  '',
  '用户说出下面这些话时，就走这套流程，不要自己直接动手：',
  '',
  '- 「用中台派个子任务」「开个设计批次」「派发子任务」「盘问」「流程规划」——这些是触发词。',
  '- 用户要一件能拆成几块并行做的事，并且说了「派」「分给子会话」「并行」这类意思。',
  '',
  '反过来：用户只是问问题、要个建议、或者让你改一行代码——不要开批次，直接做。',
  '',  '## 流程',
  '',
  '1. design_open — 开一个设计批次。没有批次就没有拆票。',
  '2. design_round — 取下一轮要问的问题。前沿是「前置条件都已满足、现在就能问」的决定；代码保证只要还没登记风险，这一轮一定带一个风险探测问。',
  '3. design_question — 把问过用户的问题和答案记进账本。至少要记够 3 个。',
  '4. design_answer — 定一个决定，或登记一条风险（risk 四栏：trigger / impact / mitigation / verification，缺一栏拒绝）。',
  '5. design_plan — 写下流程规划：分几步、每步产出什么、什么能并行。',
  '6. design_converge — 收敛成规格（目标 / 不做什么 / 验收标准）。',
  '7. design_split — 收敛后**先拆**草稿票；批准前可以反复改。',
  '8. 等用户批准 — 批准只在面板上，批准即给每张就绪的票建会话并开跑；前置没完成的票排队等前序 done。',
  '9. 前置 `done` 才自动接力；`needs_review` / `no_receipt` / `receipt_unverified` / `partial` / `failed` 一律停住，由主会话决定放行、重跑还是问用户。',
  '10. 子会话结束前交回执（middleman_report_done：自评 + 最终汇报）→ 中台把汇报回传主会话。',
  '11. 子会话跑到一半需要你拍板时，会调 request_confirmation **主动停下来**：票变 waiting，并**立刻**推一条消息到本会话。这是「等你」不是「失败」——别把两者混起来。技术性确认（路径、命名、命令、环境）可以用 middleman_answer 直接答；方向、范围、取舍必须交给用户。跑歪了用 middleman_cancel 停掉，记 lead_interrupted。',
  '12. 某张票的前序失败了、不想再等它：middleman_rewire 改它的依赖表（只允许改未结束的票），改完立刻重算依赖，满足就启动。另开了一个会话要接管一张失败票：middleman_rebind 把票重绑到新会话，之后新会话的 turn/end 会结算到这张票。',
  '13. 票没跑成：middleman_retry 重试（复核族不限、报错族 5 次，见下）；换了主会话：middleman_reparent 把回传改绑到当前会话。',
  '',
  '## 硬规则（写在代码里，撞了会被拒）',
  '',
  '- 回传是**信封**：带 batchId / ticketId / turn / 状态，外加子会话交的 ≤2000 字汇报。汇报被截断时才用 middleman_status 取全文，不要自己去读 ~/.dsh/middleman/designs/*.json。点名 ticketId 取正文时只回那一张票的投影。',
  '- **只有 `done` 会自动解锁后继**。`needs_review` / `no_receipt` / `receipt_unverified` / `partial` / `failed` / `user_interrupted` / `lead_interrupted` 一律停住：要放行用 middleman_rewire 摘掉阻塞边，要重做用面板「重跑」，拿不准就交给用户——别假设「它差不多做完了」。',
  '- 子会话的 `completed` 不算完成：它必须在那一轮交回执 `middleman_report_done({ outcome, report })`——`outcome: "done"`（自测通过）才会自动开跑，`needs_review`（没通过/拿不准）只回传汇报、不自动开跑。没有回执按 `no_receipt` 结算，读不到历史按 `receipt_unverified` 结算。',
  '- **通过与否由子会话自测**，中台不判断报告内容。复杂任务建议在设计时额外拆一张独立验证票（依赖实现票）；简单任务可以信任自测。',
  '- 中断来源要分清：用户按停止 → `user_interrupted`；主会话调 `/cancel`（`by: "lead"`）→ `lead_interrupted`。网络中断（`error.code === "TRANSPORT"`）先挂 60 秒宽限，期间有活动就撤销；到点仍无活动才按 `failed` + `code: "NETWORK_FAILED"` 报一次。DSH 重启/崩溃的补结算静默进行，不推给主会话。',
  '- 终态不等于锁死：中断/失败之后，在子会话里手动继续或面板「重跑」，后续回合照常结算，交回执 `done` 就能回到 `done`。',
  '- rewire / rebind 只改台账，不向任何子会话发消息；改完要不要启动，仍然只由 evaluateBatch 决定。',
  '- 启动失败不会自动重试：失败的票停在 queued 并带 launchError，中台会立刻推一条「启动失败」信封给你。用 middleman_retry 重试（按 LAUNCH_FAILED 记在报错族，同一 code 5 次），或让用户点面板「重试启动」。',
  '- 拆票前必须有：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险。',
  '- 风险四栏缺一栏就拒绝。「无」「n/a」不算，因为不写「怎么验证」的风险只是担心，不是风险。',
  '- 验证方式里写了「单测」，就得指出是哪个测试文件（如 risk-r1.test.mjs），而且那条测试得真的存在——登记时查一次，拆票时再查一次。写不出文件名就写「人工核对：…」，那是允许的。',
  '- 批准不由模型做，只能由人在中台面板上点。批准前必须至少拆出一张票：空批次批准会被拒（批准会锁死拆票入口）。',
  '- 每张工单必须挂风险（或写 riskFree 加理由）、必须定模型。阻塞边不能成环。',
  '- 重试分两族：子会话自评 `needs_review`、没交回执、报告读不到——产出不对，`middleman_retry` 不设上限；网络中断、启动失败、其它 error——同一错误码最多 5 次，**只有你主动调才计数**，DSH 自己的重连与 60 秒宽限不消耗。额度用完就把情况报告给用户，别硬撑。',
  '- 用户批准方案就等于授权了必要的 debug 重跑，但「替用户按下开始」仍然不行：`suspended` 的票由用户点「执行」，`done` 的票由用户点「重跑」。用户按停止/取消的票，模型不能重试。',
  '- 用户动手（执行 / 重跑 / 重试启动）之后，你的重试额度重新计起。',
  '- middleman_answer 只答技术性确认；方向、范围、取舍必须交给用户。middleman_cancel 记 lead_interrupted，用户叫停的票不能由模型再拉起来。',
  '',
  '## 怎么盘问',
  '',
  '- 事实是你的活，不是用户的活。能自己查的（读代码、跑命令、看文档）就去查，别拿去问用户。',
  '- 决定是用户的活。选 A 还是 B、要不要做、范围到哪，这些要问，而且要给推荐答案和理由。',
  '- 每轮问 2 到 4 个，一轮只推进一层。问完等用户回答，再问下一层。',
  '- 每轮至少带一个风险探测：「什么情况下这个方案会失败」。',
  '- 用户的答案原话记进 design_question，不要替他润色成结论。',
  '',
  '中文触发词（中台 / 设计批次 / 派发子任务 / 盘问 / 流程规划 / 请确认，以及各工具描述里那一份）：',
  '开个设计 —— 开批次。',
  '提问 / 盘问 —— 记一条问答。',
  '怎么分工 / 流程规划 —— 写流程规划。',
].join('\n')

/** 读一个可选服务。 */
function readService(ctx, name, required = false) {
  const holder = ctx
  const direct = holder?.[name]
  if (direct !== undefined) return direct
  if (typeof holder?.get === 'function') {
    try {
      const viaGet = holder.get(name)
      if (viaGet !== undefined) return viaGet
    } catch {
      // 服务没备好
    }
  }
  if (required) throw new MiddlemanError('service-missing', '缺少宿主服务：' + name)
  return undefined
}

/** 读配置字段。 */
function readField(value, fallback) {
  return value === undefined || value === null ? fallback : value
}

/**
 * 激活宿主半区。
 * @param ctx - 插件上下文。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
  const enabled = readField(config?.enabled, true) !== false
  if (!enabled) return

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 没有 logger 就算了
    }
  }

  /**
   * 装一个副作用，并把它挂到插件的 fiber 上。
   *
   * cordis 的 ctx.effect 会立即执行回调并登记卸载；一个精简的部署可能没有
   * 这个能力，那就直接执行一次——宁可少一次自动卸载，也不要静默不注册。
   */
  const effect = (fn, label) => {
    if (typeof ctx.effect === 'function') {
      try {
        return ctx.effect(fn, label)
      } catch (error) {
        warn('[dsh-whale-middleman] effect 挂载失败，改为直接执行：' + String(error))
      }
    }
    try {
      return fn()
    } catch (error) {
      warn('[dsh-whale-middleman] 直接执行也失败：' + String(error))
      return undefined
    }
  }

  /** 网关按需解析：它可能在本行 apply 之后才就绪。 */
  const gateway = () => {
    const face = readService(ctx, 'typertGateway')
    return face !== undefined && typeof face.invoke === 'function' ? face : undefined
  }

  /** 全局默认模型：读它，是为了 selectModel 之后恢复。 */
  const defaultModelFace = () => readService(ctx, 'agentDefaultModel')

  /**
   * 直接读 LLM 服务造模型目录。
   *
   * 不走网关的 session/modelCatalog：那条路径在这个 DSH 版本上会抛
   * "Cannot read properties of undefined (reading 'aborted')"，而面板要的
   * 数据就在 ctx.llm 里，多绕一层只会多一个失败点。
   * @returns 与网关同形的目录；没有 llm 服务时 undefined。
   */
  const catalog = async () => {
    const llm = readService(ctx, 'llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return undefined
    const groups = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        groups.push({
          id: provider.id,
          name: provider.name,
          models: models.map((model) => ({ id: model.id, name: model.name })),
        })
      } catch (error) {
        warn('[dsh-whale-middleman] 读 ' + provider.id + ' 的模型失败：' + String(error))
      }
    }
    const current = defaultModelFace()?.currentSelection?.()
    return {
      groups,
      ...(current === undefined ? {} : { default: { provider: current.provider, model: current.model } }),
    }
  }

  /** 面板排障用：说清楚这个部署里有哪些面是可用的。 */
  const diagnostic = () => ({
    llm: typeof readService(ctx, 'llm')?.listProviders,
    tools: typeof readService(ctx, 'tools')?.register,
    webServer: typeof readService(ctx, 'webServer')?.register,
    systemPrompt: typeof readService(ctx, 'systemPrompt')?.section,
    gateway: typeof gateway()?.invoke,
    defaultModel: typeof defaultModelFace()?.currentSelection,
  })

  /**
   * session/follow 是流式端点，走 gateway.stream 而不是 invoke。
   *
   * 它必须在 createDispatcher 之前定义：dispatcher 的 tail 要用它读子会话
   * 历史，缺了它就退回到 page，而 page 的游标猜错会直接抛
   * "session page through seq ... is past cursor"。
   */
  const stream = async (namespace, method, request) => {
    const face = readService(ctx, 'typertGateway')
    if (face === undefined || typeof face.stream !== 'function') return undefined
    return await face.stream({
      namespace,
      method,
      args: { request },
      peer: {
        id: 'dsh-whale-middleman-owner:' + Math.random().toString(36).slice(2),
        principal: { kind: 'owner' },
        signal: new AbortController().signal,
        interactions: 'none',
        dispose: () => Promise.resolve(),
      },
    })
  }

  const dispatcher = createDispatcher({
    gateway,
    // peer.signal 是必需的：网关每次调用都先读 peer.signal.aborted 判断
    // 调用方是否已释放，缺了它会在 session.create 上抛
    // "Cannot read properties of undefined (reading 'aborted')"。
    peer: () => ({
      id: 'dsh-whale-middleman-owner:' + Math.random().toString(36).slice(2),
      principal: { kind: 'owner' },
      signal: new AbortController().signal,
      interactions: 'none',
      dispose: () => Promise.resolve(),
    }),
    defaultModel: () => defaultModelFace()?.currentSelection?.(),
    defaultModelSave: async (selection) => { await defaultModelFace()?.saveSelection?.(selection) },
    warn,
    catalog: (...args) => catalog(...args),
    stream: (...args) => stream(...args),
  })

  // 「请确认」通道：子会话调 request_confirmation 时，靠 sessionId
  // 反查是哪张票。
  //
  // 为什么用 sessionId 反查而不是让子会话报 ticketId：子会话只看得到
  // brief 里的内容，它不知道自己在台账里叫哪张票。让它猜 id，猜错了
  // 要么串票、要么被拒，都是没必要的失败面。
  const confirmations = {
    /**
     * 按 sessionId 找到它属于哪个批次的哪张票。
     * @param sessionId - 子会话 id。
     * @returns {batch, ticket} 或 undefined。
     */
    async find(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      // 逐行 try/catch：一个坏文件（手动放进去的 JSON、点号旧文件名）只能
      // 让它自己读不出来，不能让所有回执/确认通道一起失效。
      for (const row of await list()) {
        let batch
        try {
          batch = await load(row.id)
        } catch (error) {
          warn?.('[dsh-whale-middleman] 跳过读不出来的批次 ' + String(row.id) + '：' + String(error))
          continue
        }
        const ticket = (batch.tickets ?? []).find((t) => t.childSessionId === sessionId)
        if (ticket !== undefined) return { batch, ticket }
      }
      return undefined
    },
  }

  const faces = {
    dispatcher,
    // 批次所在项目里有哪些测试文件：风险的「怎么验证」承诺了单测，
    // 就得真有那条测试。批次记着自己的 cwd，所以按批次扫。
    testFiles: async (batch) => await listTestFiles(batch?.cwd ?? ''),
    gatewayFace: gateway,
    warn,
    catalog,
    diagnostic,
    // session/follow 是流式端点，走 gateway.stream 而不是 invoke。
    stream,
    confirmations,
  }

  // 工具面。
  const tools = readService(ctx, 'tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    for (const definition of buildTools(faces)) {
      // 和路由一样挂到 effect 上：宿主热卸载/重载插件时，旧工具定义必须
      // 一起注销，否则再次 apply 会撞「已注册」，模型还会用到旧闭包。
      effect(() => {
        try {
          return tools.register({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            output: definition.output,
            timeoutMs: 120_000,
            // 统一把返回值折成「无损 JSON」再交给宿主。
            //
            // 为什么：宿主的输出快照器碰到任何 undefined 就把整份结果判非法
            //（`value is not lossless JSON`）。真机撞到过：middleman_status 在
            // 「有票但还没派发」时 100% 报这个错，因为 sessionId 是 undefined。
            // 在这里收一次口，比每个工具各自记得过滤更靠谱。
            execute: async (...args) => {
              const value = await definition.execute(...args)
              const safe = jsonSafe(value)
              return safe === undefined ? null : safe
            },
          })
        } catch (error) {
          warn('[dsh-whale-middleman] 工具没注册上：' + definition.name + ' — ' + String(error))
          return undefined
        }
      }, 'dsh-whale-middleman: tool ' + definition.name)
    }
  } else {
    warn('[dsh-whale-middleman] 这个部署没有工具注册表，工具面缺席')
  }

  // HTTP 面。
  const web = readService(ctx, 'webServer')
  if (web !== undefined && typeof web.register === 'function') {
    for (const route of makeRoutes(faces)) {
      effect(() => web.register(route), 'dsh-whale-middleman: ' + route.path)
    }
  } else {
    warn('[dsh-whale-middleman] 这个部署没有 webServer，面板端点缺席')
  }

  // 回传观察器。
  effect(() => installObserver(ctx, faces), 'dsh-whale-middleman: 回传观察器')

  // 系统提示段：只在开启时注入。
  if (readField(config?.announceToAgent, true) !== false) {
    try {
      const systemPrompt = readService(ctx, 'systemPrompt')
      if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
        effect(() => systemPrompt.section({ name: PROMPT_SECTION, order: 40, text: () => PROMPT_TEXT }), 'dsh-whale-middleman: 提示段')
      }
    } catch (error) {
      warn('[dsh-whale-middleman] 提示段没注册上：' + String(error))
    }
  }
}

export { buildTools } from './tools.js'
export { createDispatcher } from './dispatch.js'
export { makeRoutes } from './routes.js'
export { installObserver, relayBatch } from './observer.js'
export * from './core.js'
export { load, save, list, blankBatch, newBatchId } from './ledger.js'
export { MiddlemanError, isMiddlemanError } from './refusals.js'