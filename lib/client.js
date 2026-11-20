/**
 * dsh-whale-middleman 浏览器半区。
 *
 * 这个文件不是普通 ESM：它必须按 DSH 的客户端模块协议注册自己
 * （window.__ModuleLoader__.load({id, factory})），由 web 应用在启动时加载。
 * 写成 export function apply 的形式宿主会当普通模块，浏览器永远看不到它。
 *
 * 页面用 React.createElement 拼，不用 JSX —— 于是不需要构建步骤，
 * 仓库里就是能直接装的那一份。
 *
 * @module dsh-whale-middleman/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-middleman',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 侧边栏行的 id，与主栏的 key 一致。 */
    const PANEL_ID = 'middleman'

    /** 行序：插件页 0、日程 10、任务板 20，中台放 30。 */
    const PANEL_ORDER = 30

    // 状态 → 颜色：用判断层那份，客户端与测试同源。

    // ── 卡片的判断层 ───────────────────────────────────────────────
    // 由 scripts/inline-card-model.mjs 从 lib/card-model.js 生成，别手改。
    // 两份的逐字一致由 test/client-bundle.test.mjs 守住。
    const cardModel = (() => {
/**
 * 派发卡片的判断层。
 *
 * 这里只放纯计算：给哪个阶段的参数、卡片上摆哪几行、按钮长什么样。
 * 不碰 React，不碰 DOM——所以它能被单测直接盯住。
 *
 * 单独拆出来的原因：这张卡片挂在对话流里，一个阶段写错就是整张卡空白，
 * 而空白在浏览器里很难一眼看出是「没渲染」还是「没数据」。
 *
 * @module dsh-whale-middleman/card-model
 */

/** 状态 → 颜色。 */
const TONE = {
  done: '#16a34a',
  running: '#2563eb',
  partial: '#d97706',
  needs_review: '#d97706',
  no_receipt: '#dc2626',
  receipt_unverified: '#d97706',
  failed: '#dc2626',
  suspended: '#7c3aed',
  pending: '#6b7280',
  cancelled: '#6b7280',
  user_interrupted: '#6b7280',
  lead_interrupted: '#6b7280',
  grilling: '#6b7280',
  converged: '#d97706',
  approved: '#16a34a',
  dispatched: '#2563eb',
  draft: '#6b7280',
  queued: '#6b7280',
  waiting: '#d97706',
}

/**
 * 从一个阶段的 block 里取参数。
 *
 * 三个阶段的形状不一样：
 * - preparing：参数还没到齐，没有 argsRaw
 * - start：block.argsRaw
 * - result：block.call.argsRaw（call 是回填的调用头）
 *
 * 写成 `block.call?.argsRaw ?? block.argsRaw` 在 start 阶段会取到 undefined，
 * 在 result 阶段能取到；反过来写则 start 阶段取不到。所以按阶段分别读。
 *
 * @param phase - 阶段：preparing / start / result。
 * @param block - 该阶段的 block。
 * @returns 参数字符串，取不到时是 undefined。
 */
function argsRawOf(phase, block) {
  if (phase === 'start') return block?.argsRaw
  if (phase === 'result') return block?.call?.argsRaw
  return undefined
}

/**
 * 解析参数。
 * @param phase - 阶段。
 * @param block - 该阶段的 block。
 * @returns { batchId?: string, ticketId?: string }。
 */
function argsOf(phase, block) {
  const raw = argsRawOf(phase, block)
  if (typeof raw !== 'string') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const batchId = typeof parsed.batchId === 'string' ? parsed.batchId : undefined
  const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : undefined
  return { ...(batchId === undefined ? {} : { batchId }), ...(ticketId === undefined ? {} : { ticketId }) }
}

/**
 * 把模型目录摊平成一张可选项的表。
 *
 * 目录的形状是 {groups: [{id, name, models: [{id, name}]}]}。摊平之后
 * 每项记着 provider 与 model——改模型时这两个要一起发回去，只发 model
 * 名字是不够的，不同 provider 下可能有同名模型。
 *
 * @param catalog - 模型目录，拿不到时传 undefined。
 * @returns [{ value: 'provider/model', provider, model, label }]。
 */
function modelOptions(catalog) {
  const groups = catalog?.groups
  if (!Array.isArray(groups)) return []
  const options = []
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const provider = typeof group.id === 'string' ? group.id : undefined
    if (provider === undefined) continue
    const models = Array.isArray(group.models) ? group.models : []
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined) continue
      const name = typeof model.name === 'string' ? model.name : id
      options.push({
        value: provider + '/' + id,
        provider,
        model: id,
        label: provider + ' · ' + name,
      })
    }
  }
  return options
}

/**
 * 一张票上写的模型，人话版。
 *
 * 只读 ticket.model；工单没写模型时给「未定模型」，不编一个默认值——
 * 卡片显示的必须是台账上那份，不是我们猜的。
 *
 * @param ticket - 工单。
 * @returns 形如 `provider/model` 或 `未定模型`。
 */
function modelLabel(ticket) {
  const model = ticket?.model
  if (model === undefined || model === null || typeof model.model !== 'string' || model.model === '') {
    return '未定模型'
  }
  return (typeof model.provider === 'string' && model.provider !== '' ? model.provider + '/' : '') + model.model
}

/**
 * 算出一张票在卡片上怎么显示。
 *
 * @param ticket - 工单，来自 /state。
 * @returns 卡片的行与按钮。
 */
function ticketView(ticket) {
  if (ticket === undefined || ticket === null) {
    return { kind: 'missing', fields: [], hints: [], buttons: [] }
  }

  const model = modelLabel(ticket)
  // 推理强度要显示**子会话真正会用的那个值**，不是另一个近似字段。
  //
  // 派发时钉模型走的是 ticket.model.reasoningEffort（lib/dispatch.js 里
  // session.selectModel 传的就是它），所以卡片必须先读它。
  // ticket.effort 只是兜底——工单没写 model.reasoningEffort 时才用。
  //
  // 反过来写（先读 ticket.effort）会骗人：实测出现过卡片写 low、
  // 子会话其实跑 high 的情况，因为两者是各自独立写进去的。
  const effort = ticket.model?.reasoningEffort ?? ticket.effort
  const notes = ticket.notes ?? {}

  const fields = [
    ['工单文件', ticket.source],
    ['要发送的内容', ticket.payload ?? ticket.brief],
    ['模型', model],
    ['推理强度', effort],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')

  const hints = []
  if (notes.before !== undefined) hints.push(['开始前', notes.before])
  if (notes.order !== undefined) hints.push(['顺序', notes.order])
  if (notes.parallel !== undefined) hints.push(['可以同时做的', notes.parallel])

  const running = ticket.status === 'running'

  // 批准即开跑（P1）：卡片上不再摆「执行」按钮。
  //
  // 票在批准那一刻就由 /approve 建会话并开跑了，再留一个「执行」会让用户以为
  // 还得点两下；点一次还可能给已经在跑的票再发一条任务书。执行按钮只留在
  // 中台面板里当兜底。
  const buttons = [{
    kind: 'feedback',
    label: running ? '追加指令' : '有修改意见',
  }]

  return {
    kind: 'ready',
    title: ticket.id + ' ' + ticket.title,
    status: ticket.status,
    fields,
    hints,
    buttons,
  }
}

/**
 * 依赖视图：queued 票卡在谁身上、这份求值是什么时候算的。
 *
 * 面板兼作下级子页面的 debug 视图，所以这里同时回答两个问题：
 * 1. 前序满足到哪一步了——满足的给 ✓，没满足的给 ✗ 并带上状态，
 *    台账里找不到的前序单独标出来（它和「失败」不是一回事）；
 * 2. 这份 `blockedState` 是什么时候求的——「没更新」和「真没动」必须
 *    能区分开，所以把 `evaluatedAt` 换算成相对年龄。
 *
 * 老台账没有 `blockedState`（宿主还没写这个字段）时不报错，给一句
 * 「无依赖数据」；`launchError` 与原始 blockedState 属于 debug 信息，
 * 由调用方折叠展示，这里只给数据和一句摘要。
 *
 * @param ticket - 工单，来自 /state。
 * @param now - 当前时间，缺省 Date.now()；给测试一个确定值。
 * @returns 面板依赖摘要与 debug 数据。
 */
function dependencyView(ticket, now = Date.now()) {
  if (ticket === undefined || ticket === null || typeof ticket !== 'object') {
    return {
      kind: 'missing',
      queued: false,
      hasBlockedState: false,
      evaluatedAt: undefined,
      ageLabel: undefined,
      allSatisfied: undefined,
      blockers: [],
      missing: [],
      summary: undefined,
      missingNote: undefined,
      launchError: undefined,
      hasDebug: false,
      debugSummary: undefined,
      blockedState: undefined,
    }
  }

  const queued = ticket.status === 'queued'
  const blockedState = ticket.blockedState !== null && typeof ticket.blockedState === 'object'
    ? ticket.blockedState
    : undefined
  // 老台账可能压根没有这个字段，也可能被写坏；两种都当「没有数据」，
  // 不让一张坏票把整行依赖摘要弄崩。
  const validBlockedState = blockedState !== undefined && Array.isArray(blockedState.blockers)
  const launchError = typeof ticket.launchError === 'string' && ticket.launchError !== ''
    ? ticket.launchError
    : undefined

  const blockers = (validBlockedState ? blockedState.blockers : [])
    .filter((blocker) => blocker !== null && typeof blocker === 'object')
    .map((blocker) => {
      const id = typeof blocker.id === 'string' ? blocker.id : '?'
      const status = typeof blocker.status === 'string' ? blocker.status : 'unknown'
      const missing = blocker.missing === true || status === 'missing'
      const satisfied = missing ? false : blocker.satisfied === true
      return {
        id,
        title: typeof blocker.title === 'string' ? blocker.title : '',
        status,
        satisfied,
        missing,
        // 面板直接显示这行字：勾 / 叉 / 「不在台账」三种含义不能混。
        label: missing
          ? '⚠ ' + id + ' 不在台账'
          : (satisfied ? '✓ ' : '✗ ') + id + ' ' + status,
        color: satisfied ? '#16a34a' : '#dc2626',
      }
    })
  const missing = blockers.filter((blocker) => blocker.missing)

  const evaluatedAt = validBlockedState
    && typeof blockedState.evaluatedAt === 'number'
    && Number.isFinite(blockedState.evaluatedAt)
    ? blockedState.evaluatedAt
    : undefined
  const ageLabel = evaluatedAt === undefined ? undefined : evaluatedAgeLabel(evaluatedAt, now)

  const allSatisfied = validBlockedState
    ? (typeof blockedState.allSatisfied === 'boolean'
      ? blockedState.allSatisfied
      : blockers.every((blocker) => blocker.satisfied))
    : undefined

  // 依赖摘要只写「前序」这件事；启动失败原因留给折叠区，不抢主信息。
  let summary
  if (!queued) {
    summary = undefined
  } else if (!validBlockedState) {
    summary = '无依赖数据'
  } else if (blockers.length === 0) {
    summary = '没有前序'
  } else {
    summary = blockers
      .filter((blocker) => !blocker.missing)
      .map((blocker) => blocker.label)
      .join(' · ')
    if (summary === '') summary = '前序都不在台账'
  }

  const missingNote = missing.length === 0
    ? undefined
    : '前序不在台账：' + missing.map((blocker) => blocker.id).join('、')

  const debugParts = []
  if (launchError !== undefined) debugParts.push('启动失败')
  if (validBlockedState) debugParts.push('依赖状态')

  return {
    kind: 'ready',
    queued,
    hasBlockedState: validBlockedState,
    evaluatedAt,
    ageLabel,
    allSatisfied,
    blockers,
    missing,
    summary,
    missingNote,
    launchError,
    hasDebug: debugParts.length > 0,
    debugSummary: debugParts.length === 0 ? undefined : '调试信息：' + debugParts.join(' · '),
    blockedState: validBlockedState ? blockedState : undefined,
  }
}

/**
 * 求值时间的相对年龄。
 *
 * 显示的是「这份依赖求值有多旧」，而不是台账文件的修改时间——前者才是
 * 「自动接力到底有没有在判」的证据。
 *
 * @param evaluatedAt - 评估时间（毫秒）。
 * @param now - 当前时间（毫秒）。
 * @returns 形如 `3 分钟前评估` 的人话。
 */
function evaluatedAgeLabel(evaluatedAt, now) {
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const elapsed = Math.max(0, current - evaluatedAt)
  if (elapsed < 60000) return '刚刚评估'
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 60) return minutes + ' 分钟前评估'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前评估'
  return Math.floor(hours / 24) + ' 天前评估'
}

/** 批次状态是不是「已经批过了」。批准之后卡片上不再有动作按钮。 */
function approvedLike(status) {
  return status === 'approved' || status === 'done' || status === 'cancelled'
}

/**
 * 算出一个批次在「批准卡」上怎么显示。
 *
 * 批准卡挂在 `design_converge` 的调用行下面：标题、四行摘要（目标 /
 * 验收条数 / 风险条数 / 票与模型）、票的状态、启动失败原因，以及唯一的
 * 动作按钮「批准并开跑」。
 *
 * 为什么「批准」要等票到位：批准会把整批锁死（之后 design_split 报
 * ticket-locked），而 design_converge 刚返回的那几秒里票还没拆出来。
 * 空批次被批准就再也拆不了票了，所以票数为 0 时不出按钮，只显示
 * 「收敛完成，拆票中…」——票一到位，轮询到的下一次渲染就出现按钮。
 *
 * @param batch - 批次，来自 /state?batchId。
 * @returns 卡片要摆的标题、四行、票、失败与按钮。
 */
function batchView(batch) {
  if (batch === undefined || batch === null || typeof batch !== 'object') {
    return {
      kind: 'missing',
      id: undefined,
      title: '设计批次：缺少批次信息',
      status: undefined,
      fields: [],
      tickets: [],
      failures: [],
      buttons: [],
      note: undefined,
    }
  }

  const status = typeof batch.status === 'string' ? batch.status : 'unknown'
  const title = typeof batch.title === 'string' && batch.title !== ''
    ? batch.title
    : String(batch.id ?? '')
  const spec = batch.spec !== null && typeof batch.spec === 'object' ? batch.spec : {}
  const acceptance = Array.isArray(spec.acceptance) ? spec.acceptance : []
  const risks = Array.isArray(batch.risks) ? batch.risks : []
  // 台账坏了也可能混进非对象：过滤掉，别让一张坏票把整张卡打白。
  const tickets = (Array.isArray(batch.tickets) ? batch.tickets : [])
    .filter((ticket) => ticket !== null && typeof ticket === 'object')

  // 四行摘要。模型去重：三张票都钉同一个模型时，只写一次。
  const models = []
  for (const ticket of tickets) {
    const label = modelLabel(ticket)
    if (!models.includes(label)) models.push(label)
  }

  const fields = [
    ['目标', typeof spec.goal === 'string' && spec.goal.trim() !== '' ? spec.goal : '还没写目标'],
    ['验收', acceptance.length + ' 条'],
    ['风险', risks.length + ' 条'],
    ['票与模型', tickets.length === 0 ? '还没有票' : tickets.length + ' 张 · ' + models.join('、')],
  ]

  const rows = tickets.map((ticket) => {
    const launchError = typeof ticket.launchError === 'string' && ticket.launchError !== ''
      ? ticket.launchError
      : undefined
    return {
      ticketId: ticket.id,
      title: String(ticket.id) + ' ' + String(ticket.title ?? ''),
      status: ticket.status,
      model: modelLabel(ticket),
      ...(launchError === undefined ? {} : { launchError }),
      // 票启动失败标红：批准了但没跑起来，卡片上必须看得出来，否则用户以为
      // 一切正常，直到发现子会话根本不存在。
      color: launchError === undefined ? (TONE[ticket.status] ?? TONE.pending) : TONE.failed,
    }
  })
  const failures = rows.filter((row) => row.launchError !== undefined)

  const buttons = status === 'converged' && tickets.length > 0
    ? [{ kind: 'approve', label: '批准并开跑' }]
    : []

  let note
  if (status === 'converged') {
    note = tickets.length === 0
      ? '收敛完成，拆票中…（票到位后再批准）'
      : '批准会立刻给每张就绪的票建子会话并开跑；不叫醒主会话。'
  } else if (approvedLike(status)) {
    note = '已批准 · 已开跑'
  } else if (status === 'grilling') {
    note = '还在盘问：收敛之后才能批准'
  } else {
    note = '当前状态：' + status
  }

  return {
    kind: 'ready',
    id: batch.id,
    title,
    status,
    fields,
    tickets: rows,
    failures,
    buttons,
    note,
  }
}

/**
 * 算出一个批次在「收件箱卡」上怎么显示。
 *
 * 只收 waiting 的票：子会话自己停下来问的那几张。每张票给出问题、选项
 *（每个选项就是一个按钮）、子会话的建议。自由回答的输入框由卡片自己画，
 * 这里只给纯数据。
 *
 * @param batch - 批次，来自 /state?batchId。
 * @returns 等用户拍板的票与其选项。
 */
function inboxView(batch) {
  if (batch === undefined || batch === null || typeof batch !== 'object') {
    return {
      kind: 'missing',
      id: undefined,
      title: '收件箱：缺少批次信息',
      status: undefined,
      count: 0,
      items: [],
      buttons: [],
      note: '没有可显示的批次',
    }
  }

  const status = typeof batch.status === 'string' ? batch.status : 'unknown'
  const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
  const items = []
  for (const ticket of tickets) {
    if (ticket?.status !== 'waiting') continue
    const info = ticket.waiting !== null && typeof ticket.waiting === 'object' ? ticket.waiting : {}
    const options = Array.isArray(info.options)
      ? info.options.filter((option) => typeof option === 'string' && option.trim() !== '')
      : []
    items.push({
      batchId: batch.id,
      ticketId: ticket.id,
      title: String(ticket.id) + ' ' + String(ticket.title ?? ''),
      question: typeof info.question === 'string' ? info.question : '',
      options,
      recommendation: typeof info.recommendation === 'string' && info.recommendation !== ''
        ? info.recommendation
        : undefined,
      buttons: options.map((option) => ({ kind: 'answer', label: option, answer: option })),
    })
  }

  return {
    kind: 'ready',
    id: batch.id,
    title: typeof batch.title === 'string' && batch.title !== '' ? batch.title : String(batch.id ?? ''),
    status,
    count: items.length,
    items,
    buttons: [],
    ...(items.length === 0 ? { note: '现在没有票在等用户拍板' } : {}),
  }
}
      return { TONE, argsRawOf, argsOf, modelOptions, modelLabel, ticketView, dependencyView, batchView, inboxView }
    })()

    // ── 面板的状态口径 ──────────────────────────────────────────────
    // 与 lib/routes.js 的 /run 守卫同源，别各写各的：
    // - 只有挂起 / 排队的票能点「执行」；
    // - 终态票只给「重跑」（走 force），并且要用户确认会重新计费；
    // - 已结束 / 已取消的批次默认折叠置灰——它们是最容易被误点的那一排。
    const RUNNABLE_STATUSES = new Set(['suspended', 'queued', 'draft'])
    const TERMINAL_STATUSES = new Set([
  'cancelled', 'user_interrupted', 'lead_interrupted',
  'done', 'failed', 'partial', 'interrupted',
  'needs_review', 'no_receipt', 'receipt_unverified',
])
    const CLOSED_BATCH_STATUSES = new Set(['done', 'cancelled'])

    /**
     * 创建时间的人话版。老批次可能没有 createdAt（那时候还没这个字段），
     * 写「未知」而不是编一个现在的时间。
     * @param value - createdAt。
     * @returns 形如 `2026-11-17 20:08`。
     */
    function createdAtLabel(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '未知'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '未知'
      const pad = (part) => String(part).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** 面板请求的超时：宿主卡住时按钮不能永远停在「提交中…」。 */
    const API_TIMEOUT_MS = 10_000

    /** 打一次本插件 API。 */
    async function api(path, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), API_TIMEOUT_MS)
      try {
        const response = await fetch('/middleman/api' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        })
        // 先看状态与类型：宿主对未知路径会回 HTML/空响应，直接 .json() 会把
        // 「接口不存在」包装成一句 SyntaxError 给用户看。
        const type = typeof response.headers?.get === 'function'
          ? (response.headers.get('content-type') ?? '')
          : ''
        if (response.ok !== true || !type.includes('application/json')) {
          return { ok: false, error: '接口返回异常（HTTP ' + response.status + '）：刷新页面后重试' }
        }
        return await response.json()
      } catch (error) {
        const timedOut = error?.name === 'AbortError'
        return {
          ok: false,
          error: timedOut
            ? '请求超时（' + Math.round(API_TIMEOUT_MS / 1000) + ' 秒）：刷新页面后重试'
            : String(error),
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    /** 一枚状态徽标。 */
    function badge(status) {
      // TONE 住在 cardModel 的闭包里，出了闭包就是 ReferenceError。
      const color = cardModel.TONE[status] ?? '#6b7280'
      return h('span', {
        style: {
          padding: '1px 8px',
          borderRadius: 999,
          fontSize: 12,
          color,
          border: '1px solid ' + color,
          whiteSpace: 'nowrap',
        },
      }, status ?? 'pending')
    }

    /** 一张工单的行。 */
    function TicketRow(props) {
      const { batch, ticket, onChanged, ctx } = props
      const [busy, setBusy] = React.useState(false)
      // 模型显示统一走 card-model 的 modelLabel：它已经把 undefined / null /
      // 缺字段都收成「未定模型」。这里自己拼会让 model: null 的旧台账直接抛
      // TypeError，把整个面板子树卸载成白屏。
      const model = cardModel.modelLabel(ticket)
      // 依赖摘要与 debug 数据都从纯函数来，单测盯得住；面板只负责摆出来。
      const dep = cardModel.dependencyView(ticket)

      const act = async (path, body) => {
        setBusy(true)
        const result = await api(path, body)
        setBusy(false)
        if (result.ok !== true) alert(result.error ?? '操作失败')
        await onChanged()
      }

      const actions = []
      if (ticket.childSessionId !== undefined) {
        // 「执行」只给挂起 / 排队。旧条件「有会话 && 不在跑」会把
        // done / cancelled 的票也画上「执行」——2026-11-17 的误点事故就是
        // 这么来的：一张取消了一个多小时的票被重新拉起，白跑了一整轮。
        if (RUNNABLE_STATUSES.has(ticket.status)) {
          actions.push(h('button', {
            key: 'run',
            disabled: busy,
            title: '把挂起的子会话跑起来；开始后会计费',
            onClick: () => act('/run', { batchId: batch.id, ticketId: ticket.id }),
            style: {
              padding: '6px 14px', borderRadius: 8, border: '1px solid transparent',
              background: busy ? '#9ca3af' : '#3b82f6',
              color: '#fff', cursor: busy ? 'default' : 'pointer', fontSize: 13,
            },
          }, busy ? '提交中…' : '执行'))
          // 执行按钮是人工兜底：批准那一下已经 spawn+run 了，这里只在
          // 自动启动失败、票挂在队列里没人拉的时候用。
          actions.push(h('span', {
            key: 'run-hint',
            style: { fontSize: 11, opacity: 0.6, maxWidth: 220, lineHeight: 1.35 },
          }, '批准即开跑；此按钮只在自动启动失败时用'))
        } else if (TERMINAL_STATUSES.has(ticket.status)) {
          // 终态票给「重跑」，不给「执行」。走 force: true，并且先把
          // 「会重新计费」说在前面——这是用户主动做的决定，不是兜底按钮。
          actions.push(h('button', {
            key: 'rerun',
            disabled: busy,
            title: '重新给这张票发一轮任务书，会再次计费',
            onClick: () => {
              const message = '重跑 ' + ticket.id + '（' + (ticket.title ?? '') + '）'
                + '会重新发一轮任务书，并可能再次计费。确定继续？'
              const agreed = typeof window !== 'undefined' && typeof window.confirm === 'function'
                ? window.confirm(message)
                : false
              if (agreed) void act('/run', { batchId: batch.id, ticketId: ticket.id, force: true })
            },
            style: {
              padding: '6px 14px', borderRadius: 8, border: '1px solid #d97706',
              background: 'transparent', color: '#d97706',
              cursor: busy ? 'default' : 'pointer', fontSize: 13,
            },
          }, busy ? '提交中…' : '重跑'))
        }

        // 启动失败的票没有子会话，上面那一段画不出任何按钮——
        // 正是 I-04 的死局：模型与面板都没有恢复入口。这里给用户一个出口。
        if (ticket.status === 'queued' && ticket.launchError !== undefined) {
          actions.push(h('button', {
            key: 'retry',
            disabled: busy,
            title: '清掉启动失败标记，按最新台账再启动一次（开始后会计费）',
            onClick: () => act('/retry', { batchId: batch.id, ticketId: ticket.id }),
            style: {
              padding: '6px 14px', borderRadius: 8, border: '1px solid #3b82f6',
              background: 'transparent', color: '#3b82f6',
              cursor: busy ? 'default' : 'pointer', fontSize: 13,
            },
          }, busy ? '提交中…' : '重试启动'))
          actions.push(h('span', {
            key: 'retry-hint',
            style: { fontSize: 11, opacity: 0.6, maxWidth: 220, lineHeight: 1.35 },
          }, '上次启动失败：' + String(ticket.launchError)
            + '；这里会清掉标记再试，同时把主会话的重试额度还回去'))
        }

        // 「在对话中查看」：跳回派发这张票的那个会话，并把对话流滚到批准卡那里。
        //
        // 为什么要有它：对话流是虚拟滚动——今天翻了几百条消息后，卡片早被滚上去，
        // 面板反而成了唯一顺手的入口。按钮不搬卡片（它已经在正确的位置），
        // 只负责把用户带回卡片跟前。
        //
        // 跳转分两步：先 uiWorkspace.openSession 回到那个会话，等 React 把
        // 对话流异步挂载出来，再找到 design_converge 的工具行，滚到它跟前。
        actions.push(h('button', {
          key: 'reveal',
          title: '跳到主对话里的派发卡片',
          onClick: () => {
            const nav = ctx?.get?.('uiWorkspace')
            if (nav === undefined || typeof nav.openSession !== 'function') {
              alert('这个宿主版本不支持跳转，请在会话列表里手动打开「' + (batch.title ?? batch.id) + '」')
              return
            }
            // 没有 parentSessionId 的旧台账不能拿批次 id 当会话 id 跳：
            // 那会跳到一个不存在的会话，用户还以为「跳转坏了」。
            if (typeof batch.parentSessionId !== 'string' || batch.parentSessionId === '') {
              alert('这个批次没有记着主会话（旧台账），请在会话列表里手动打开「'
                + (batch.title ?? batch.id) + '」')
              return
            }
            nav.openSession(batch.parentSessionId)
            // 对话流异步挂载；每 250ms 找一次，最多 5 秒。
            let tries = 0
            const timer = setInterval(() => {
              tries++
              const target = [...document.querySelectorAll('[data-chat-anchor-key^="call:"]')]
                .find((row) => {
                  const code = row.querySelector('code')
                  return code !== null && code.textContent.includes('design_converge')
                })
              if (target !== undefined) {
                clearInterval(timer)
                target.scrollIntoView({ block: 'center' })
              } else if (tries > 20) {
                clearInterval(timer)
              }
            }, 250)
          },
          style: {
            padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,.3)',
            background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12,
          },
        }, '在对话中查看'))
      }

      // 依赖摘要：只给 queued 的票看。老台账没有 blockedState 时明确写
      // 「无依赖数据」——空白会让用户以为「没有前序」，这两件事不一样。
      const dependencyParts = []
      if (dep.queued) {
        if (!dep.hasBlockedState) {
          dependencyParts.push(h('span', { key: 'none', style: { opacity: 0.7 } }, dep.summary))
        } else if (dep.blockers.length === 0) {
          dependencyParts.push(h('span', { key: 'none', style: { opacity: 0.7 } }, '没有前序'))
        } else {
          const visible = dep.blockers.filter((blocker) => !blocker.missing)
          if (visible.length === 0) {
            dependencyParts.push(h('span', { key: 'all-missing', style: { opacity: 0.7 } }, '前序都不在台账'))
          } else {
            visible.forEach((blocker, index) => {
              if (index > 0) {
                dependencyParts.push(h('span', { key: 'sep-' + blocker.id, style: { opacity: 0.35 } }, '·'))
              }
              dependencyParts.push(h('span', { key: 'b-' + blocker.id, style: { color: blocker.color } }, blocker.label))
            })
          }
        }
        if (dep.ageLabel !== undefined) {
          // 「3 分钟前评估」：求值没更新 vs 依赖真没动，靠这行区分。
          dependencyParts.push(h('span', { key: 'age', style: { opacity: 0.55 } }, '· ' + dep.ageLabel))
        }
      }

      const dependencyLine = dep.queued
        ? h('div', {
          key: 'deps',
          style: { fontSize: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 4 },
        }, [h('span', { key: 'label', style: { opacity: 0.62 } }, '依赖：'), ...dependencyParts])
        : null
      const missingLine = dep.missingNote === undefined
        ? null
        : h('div', { key: 'missing', style: { fontSize: 11.5, color: '#dc2626', opacity: 0.85 } }, dep.missingNote)

      // launchError 与原始 blockedState 是 debug 信息：默认收起，
      // 不抢「这张票在等什么」的主信息。摘要是红的，说明里面有启动失败。
      const debug = dep.hasDebug
        ? h('details', { key: 'debug', style: { fontSize: 11.5, opacity: 0.8 } }, [
          h('summary', {
            key: 'summary',
            style: {
              cursor: 'pointer', width: 'fit-content',
              color: dep.launchError === undefined ? undefined : '#dc2626',
            },
          }, dep.debugSummary),
          dep.launchError === undefined
            ? null
            : h('div', { key: 'error', style: { marginTop: 4, color: '#dc2626', wordBreak: 'break-word' } },
              '启动失败：' + dep.launchError),
          dep.blockedState === undefined
            ? null
            : h('pre', {
              key: 'raw',
              style: {
                margin: '4px 0 0', padding: '6px 8px', borderRadius: 6,
                background: 'rgba(127,127,127,.1)', whiteSpace: 'pre-wrap',
                wordBreak: 'break-word', fontSize: 11, maxHeight: 180, overflow: 'auto',
              },
            }, JSON.stringify(dep.blockedState, null, 2)),
        ])
        : null

      return h('div', {
        style: {
          padding: '8px 0', borderTop: '1px solid rgba(127,127,127,.16)',
          display: 'flex', flexDirection: 'column', gap: 4,
        },
      }, [
        h('div', {
          key: 'main',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
        }, [
          h('div', { key: 'left', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
            h('span', { key: 'name', style: { fontSize: 14 } }, ticket.id + ' ' + ticket.title),
            h('span', {
              key: 'meta',
              style: { fontSize: 12, opacity: 0.62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, model + (ticket.modelReason ? ' · ' + ticket.modelReason : '')),
            dependencyLine,
            missingLine,
          ].filter((node) => node !== null)),
          h('div', { key: 'right', style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } }, [
            badge(ticket.status),
            ...actions,
          ]),
        ]),
        debug,
      ].filter((node) => node !== null && node !== undefined))
    }

    /**
     * 一个批次的卡片。
     *
     * 排序由宿主决定：`/state` 返回的列表已经是 createdAt 降序
     * （lib/ledger.js 的 list() 就是那么排的），这里**不再排一次**。
     * 两处都排，口径一旦分叉（一边按 createdAt、一边按 updatedAt），
     * 就没人查得清「为什么最新那个不在最上面」。
     *
     * 已结束 / 已取消的批次默认折叠置灰：那几张卡上全是终态票，
     * 摊在最新批次下面只会招误点（2026-11-17 误点事故的诱因之一）。
     * 「已结束」是宿主在 /state 里算的 closed 标记——批次自身没有结束
     * 状态，批准之后一直是 approved，所以得看票是不是全走完了。
     */
    function BatchCard(props) {
      const { row, onChanged, ctx } = props
      // 「已结束」由宿主在 /state 里算（批准过 + 每张票都是终态）：批次自己
      // 没有结束状态，面板这边拿不到票的状态，别自己猜。CLOSED_BATCH_STATUSES
      // 只是兼容旧宿主：万一 /state 没带 closed，还能认 done/cancelled。
      const closed = row.closed === true || CLOSED_BATCH_STATUSES.has(row.status)
      // 默认状态只在首次挂载时决定；批次跑完之后不替用户自动收起——
      // 正在看的那张卡突然折叠，比多看一眼更烦。
      const [expanded, setExpanded] = React.useState(!closed)
      const [detail, setDetail] = React.useState(null)
      const [detailError, setDetailError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        const result = await api('/state?batchId=' + encodeURIComponent(row.id))
        if (result.ok === true) {
          setDetail(result.batch)
          setDetailError(undefined)
        } else {
          // 读不到 ≠ 没拆票：保留旧详情（如果有），并把错误单独记下来，
          // 否则用户会把一次网络失败当成「设计还没拆成工单」。
          setDetailError(result.error ?? '读不到批次详情')
        }
      }, [row.id])

      // 折叠时不读详情：旧批次不该在每次打开面板时都发一轮请求。
      React.useEffect(() => { if (expanded) void load() }, [expanded, load])

      const approve = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await api('/approve', {
            batchId: row.id,
            // 带上展开时看到的 revision：面板与卡片同一套 CAS 口径，
            // 避免把用户没看到的新内容批下去。
            ...(typeof detail?.revision === 'number' ? { expectedRevision: detail.revision } : {}),
          })
          if (result.ok !== true) alert(result.error ?? '批准失败')
          else if (Array.isArray(result.failed) && result.failed.length > 0) alert(result.note ?? '有票没起来')
        } finally {
          setBusy(false)
        }
        await load()
        await onChanged()
      }

      const status = detail?.status ?? row.status
      const children = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h('strong', { key: 'name', style: { fontSize: 14 } }, row.title),
          badge(status),
          h('span', { key: 'id', style: { fontSize: 12, opacity: 0.55 } }, row.id),
          // 创建时间标在卡片上：批次一多，「哪个是最新的」不能靠猜。
          h('span', { key: 'created', style: { fontSize: 12, opacity: 0.55 } },
            '创建于 ' + createdAtLabel(row.createdAt)),
          h('button', {
            key: 'toggle',
            onClick: () => setExpanded((value) => !value),
            style: {
              marginLeft: 'auto', padding: '3px 10px', borderRadius: 8,
              border: '1px solid rgba(127,127,127,.3)', background: 'transparent',
              color: 'inherit', cursor: 'pointer', fontSize: 12,
            },
          }, expanded ? '收起' : '展开'),
        ]),
      ]

      if (!expanded) {
        if (closed) {
          children.push(h('div', { key: 'collapsed', style: { fontSize: 13, opacity: 0.62 } },
            '已结束的批次默认收起，展开才能看到工单。'))
        }
      } else {
        for (const ticket of detail?.tickets ?? []) {
          children.push(h(TicketRow, { key: ticket.id, batch: detail, ticket, onChanged: load, ctx }))
        }

        if (detailError !== undefined && detail === null) {
          children.push(h('div', { key: 'detail-error', style: { color: '#dc2626', fontSize: 13 } },
            '读不到批次详情：' + detailError + '（收起再展开可重试）'))
        } else if (detail !== null && (detail.tickets ?? []).length === 0) {
          children.push(h('div', { key: 'empty', style: { fontSize: 13, opacity: 0.62 } },
            '设计还没拆成工单。在对话里继续盘问，收敛后再 design_split。'))
        }

        if (status === 'converged' && (detail?.tickets ?? []).length > 0) {
          children.push(h('button', {
            key: 'approve',
            disabled: busy,
            onClick: approve,
            style: {
              alignSelf: 'flex-start', marginTop: 6, padding: '6px 14px', borderRadius: 8,
              border: '1px solid transparent', background: '#16a34a', color: '#fff',
              cursor: busy ? 'default' : 'pointer', fontSize: 13, opacity: busy ? 0.7 : 1,
            },
          }, busy ? '批准中…' : '批准这份设计'))
        }
      }

      return h('div', {
        style: {
          border: '1px solid rgba(127,127,127,' + (closed && !expanded ? '.18' : '.28') + ')',
          borderRadius: 10,
          padding: 14,
          display: 'flex', flexDirection: 'column', gap: 6,
          // 终态批次置灰：视觉上就告诉用户「这张不该再点了」。
          ...(closed ? { opacity: expanded ? 0.85 : 0.62, background: 'rgba(127,127,127,.05)' } : {}),
        },
      }, children)
    }

    /** 中台页。 */
    function MiddlemanPage(props) {
      const { ctx } = props
      const [state, setState] = React.useState({ loading: true, batches: [] })

      const refresh = React.useCallback(async () => {
        const result = await api('/state')
        setState({ loading: false, batches: result.ok === true ? (result.batches ?? []) : [], error: result.error })
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const body = []
      if (state.loading) {
        body.push(h('div', { key: 'loading', style: { opacity: 0.62 } }, '读取中…'))
      } else if (state.error !== undefined) {
        body.push(h('div', { key: 'err', style: { color: '#dc2626' } }, state.error))
      } else if (state.batches.length === 0) {
        body.push(h('div', { key: 'empty', style: { opacity: 0.62 } },
          '还没有设计批次。在对话里说「开个设计批次」，模型会调 design_open。'))
      } else {
        // 顺序完全按 /state 给的来（ledger.list 已按 createdAt 降序）。
        // 这里再排一次就是双重排序——两处口径一旦分叉，「最新那个为什么
        // 不在最上面」就没人查得清了。顺序由 test/p1-run-guard.test.mjs
        // 盯住宿主那一侧。
        for (const row of state.batches) {
          body.push(h(BatchCard, { key: row.id, row, onChanged: refresh, ctx }))
        }
      }

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 16, padding: 20,
          fontSize: 14, lineHeight: 1.6, height: '100%', overflowY: 'auto',
        },
      }, [
        h('h1', { key: 'title', style: { fontSize: 20, fontWeight: 600, margin: 0 } }, '中台'),
        h('div', { key: 'hint', style: { opacity: 0.62 } },
          '批次按创建时间倒序，最新的在最上面；已结束 / 已取消的默认折叠。'
          + '批准即开跑；「执行」只给挂起 / 排队的票，「重跑」会重新计费。'),
        ...body,
      ])
    }

    /** 侧边栏图标。 */
    function MiddlemanIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', 'data-dsh-panel-entry': PANEL_ID,
      }, [
        h('rect', { key: 'a', x: 1.6, y: 2.2, width: 5, height: 3.4, rx: 0.9 }),
        h('rect', { key: 'b', x: 1.6, y: 10.4, width: 5, height: 3.4, rx: 0.9 }),
        h('rect', { key: 'c', x: 9.4, y: 6.3, width: 5, height: 3.4, rx: 0.9 }),
        h('path', { key: 'd', d: 'M6.6 3.9h1.3v4.1h1.5' }),
        h('path', { key: 'e', d: 'M6.6 12.1h1.3V8h1.5' }),
      ])
    }

    /**
     * 一行「项目 / 内容」。
     *
     * 内容里可能有 `code` 片段（工单路径、命令），用等宽字体单独渲染，
     * 免得和正文混在一起看不出边界。
     */
    function FieldRow(props) {
      const { label, value } = props
      if (value === undefined || value === null || value === '') return null
      return h('tr', null, [
        h('td', {
          key: 'k',
          style: { verticalAlign: 'top', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', opacity: 0.7, width: 120 },
        }, label),
        h('td', { key: 'v', style: { verticalAlign: 'top', padding: '6px 0', wordBreak: 'break-word' } },
          String(value).split('\n').map((line, index) => h('div', {
            key: 'i' + index,
            style: /[/\\]|\s--|\s[a-z-]+ \S/.test(line) && line.trim() !== ''
              ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: 'rgba(127,127,127,.12)', borderRadius: 4, padding: '1px 5px', display: 'inline-block', margin: '1px 0' }
              : undefined,
          }, line))),
      ])
    }

    // ── 批准卡与收件箱卡（P1） ─────────────────────────────────────

    /** 新卡片共用的壳子。 */
    function cardShell(children) {
      return h('div', {
        style: {
          border: '1px solid rgba(127,127,127,.3)', borderRadius: 12,
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
          fontSize: 14, lineHeight: 1.6, background: 'rgba(127,127,127,.04)',
        },
      }, children)
    }

    /** 一行红字：失败原因要看得见。 */
    function failureLine(key, text) {
      return h('div', {
        key,
        style: { color: '#dc2626', fontSize: 13, wordBreak: 'break-word' },
      }, '⚠ ' + text)
    }

    /**
     * 从 block 里取参数；取不到也不让整张卡白。
     *
     * 宿主升级后 tool.call.toolview 的 block 形状可能变（历史上 argsRaw 与
     * call.argsRaw 就不一样）。argsOf 本身对形状很宽容，这里再包一层是防
     * 它自己哪天抛错——卡片整块空白比一行占位难查得多。
     */
    function safeArgs(phase, block) {
      try {
        return cardModel.argsOf(phase, block)
      } catch {
        return {}
      }
    }

    /**
     * 对话流里的「批准卡」。
     *
     * 挂在 design_converge 的调用行：标题、四行摘要（目标 / 验收条数 /
     * 风险条数 / 票与模型）、票的状态，以及唯一的「批准并开跑」。
     * 点完自己重新 load；批准后变成「已批准 · 已开跑」，票起不来时标红
     * 给原因。卡不接管输入框、不做模态。
     *
     * 判断层在 card-model.batchView，有单测。整个渲染包在 try/catch 里：
     * 宿主升级导致形状变化时，用户看到的是一行占位，而不是一块白。
     */
    function ApprovalCard(props) {
      const [state, setState] = React.useState({ loading: true })
      // 批准会真的建会话并计费：连点两下不能打出两个并发 /approve。
      const [busy, setBusy] = React.useState(false)
      const { batchId } = safeArgs(props?.phase, props?.block)

      const load = React.useCallback(async () => {
        if (batchId === undefined) {
          setState({ loading: false, missing: true })
          return
        }
        const result = await api('/state?batchId=' + encodeURIComponent(batchId))
        if (result.ok !== true) {
          setState({ loading: false, error: result.error ?? '读不到批次' })
          return
        }
        setState({ loading: false, batch: result.batch })
      }, [batchId])

      React.useEffect(() => { void load() }, [load])

      // 只在这张卡还可能有动作时轮询：票是 design_split 随后才写进台账的，
      // 不轮询的话 converge 那一刻的卡片会永远停在「拆票中」。批准之后再
      // 轮询也没意义——卡片只剩「已批准 · 已开跑」一行字。
      const settled = state.batch !== undefined
        && state.batch.status !== 'converged'
        && state.batch.status !== 'grilling'
      React.useEffect(() => {
        if (settled) return undefined
        const timer = setInterval(() => { void load() }, 2500)
        return () => clearInterval(timer)
      }, [settled, load])

      const approve = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await api('/approve', {
            batchId,
            // 带上卡片看到的 revision：台账在这期间被改过时路由回 409，
            // 而不是拿旧视图批准新内容。
            ...(typeof state.batch?.revision === 'number' ? { expectedRevision: state.batch.revision } : {}),
          })
          if (result.ok !== true) alert(result.error ?? '批准失败')
          else if (Array.isArray(result.failed) && result.failed.length > 0) alert(result.note ?? '有票没起来')
        } finally {
          setBusy(false)
        }
        await load()
      }

      const render = () => {
        // 参数还没到：先给占位，别闪一下「缺少批次信息」。
        if (props?.phase === 'preparing') {
          return cardShell([h('span', { key: 'p', style: { opacity: 0.7 } }, '准备批准卡…')])
        }
        if (batchId === undefined) {
          return cardShell([h('span', { key: 'm', style: { opacity: 0.7 } }, '批准卡：缺少批次信息')])
        }
        if (state.loading) return cardShell([h('span', { key: 'l', style: { opacity: 0.7 } }, '读取批次…')])
        if (state.error !== undefined) return cardShell([failureLine('e', state.error)])
        if (state.batch === undefined) {
          return cardShell([h('span', { key: 'l2', style: { opacity: 0.7 } }, '读取批次…')])
        }

        const view = cardModel.batchView(state.batch)
        if (view.kind === 'missing') {
          return cardShell([h('span', { key: 'n', style: { opacity: 0.7 } }, '批准卡：批次读不出来')])
        }

        const children = [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('strong', { key: 't' }, view.title),
            badge(view.status),
          ]),
          h('table', {
            key: 'fields',
            style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
          }, view.fields.map(([label, value]) => h(FieldRow, { key: label, label, value }))),
        ]

        // 启动失败的票单独一行红字，写清楚是哪张、为什么。
        for (const failure of view.failures) {
          children.push(failureLine(
            'f-' + failure.ticketId,
            failure.title + ' 启动失败：' + failure.launchError,
          ))
        }

        if (view.tickets.length > 0) {
          children.push(h('div', {
            key: 'tickets',
            style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12.5 },
          }, view.tickets.map((ticket) => h('div', {
            key: ticket.ticketId,
            style: {
              display: 'flex', gap: 8, alignItems: 'baseline',
              color: ticket.launchError === undefined ? 'inherit' : '#dc2626',
            },
          }, [
            h('span', { key: 'id', style: { opacity: 0.65 } }, String(ticket.ticketId)),
            h('span', { key: 'st', style: { color: ticket.color } }, String(ticket.status ?? 'draft')),
            h('span', {
              key: 'm',
              style: { opacity: 0.62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, ticket.model),
          ]))))
        }

        if (view.note !== undefined) {
          children.push(h('div', { key: 'note', style: { fontSize: 12.5, opacity: 0.7 } }, view.note))
        }

        if (view.buttons.length > 0) {
          children.push(h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            view.buttons.map((button) => h('button', {
              key: button.kind,
              disabled: busy,
              onClick: () => { void approve() },
              style: {
                padding: '7px 16px', borderRadius: 8, border: '1px solid transparent',
                background: '#16a34a', color: '#fff',
                cursor: busy ? 'default' : 'pointer', fontSize: 13, opacity: busy ? 0.7 : 1,
              },
            }, busy ? '批准中…' : button.label))))
        }

        return cardShell(children)
      }

      try {
        return render()
      } catch (error) {
        return cardShell([failureLine('x', '批准卡渲染失败：'
          + (error instanceof Error ? error.message : String(error)))])
      }
    }

    /**
     * 收件箱里的一张 waiting 票：问题、建议、选项按钮、自由回答。
     *
     * 输入框只在这张卡里，不接管页面 composer；用户在这里打字不会影响
     * 主会话的对话输入。
     */
    function WaitingTicketCard(props) {
      const { batchId, item, onAnswer } = props
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const send = async (answerText) => {
        const trimmed = typeof answerText === 'string' ? answerText.trim() : ''
        if (trimmed === '') return
        setBusy(true)
        await onAnswer(batchId, item.ticketId, trimmed)
        setBusy(false)
        setText('')
      }

      const optionButtons = item.buttons.map((button, index) => h('button', {
        // 选项文本可能重复（模型经常给两个很像的选项）；用下标当 key，
        // 否则 React 会警告并可能让两个按钮在重渲染时错位。
        key: 'opt-' + index,
        disabled: busy,
        onClick: () => { void send(button.answer) },
        style: {
          padding: '6px 14px', borderRadius: 8,
          border: '1px solid rgba(127,127,127,.4)', background: 'transparent',
          color: 'inherit', cursor: busy ? 'default' : 'pointer', fontSize: 13,
        },
      }, button.label))

      return h('div', {
        style: {
          border: '1px solid rgba(127,127,127,.22)', borderRadius: 10,
          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
          h('strong', { key: 't', style: { fontSize: 13 } }, item.title),
          h('span', { key: 's', style: { fontSize: 12, color: '#d97706' } }, 'waiting'),
        ]),
        h('div', { key: 'q', style: { fontSize: 13.5 } },
          item.question === '' ? '（子会话没写问题）' : item.question),
        item.recommendation === undefined
          ? null
          : h('div', { key: 'r', style: { fontSize: 12.5, opacity: 0.75 } }, '建议：' + item.recommendation),
        optionButtons.length === 0
          ? null
          : h('div', { key: 'opts', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, optionButtons),
        h('div', { key: 'free', style: { display: 'flex', gap: 8 } }, [
          h('input', {
            key: 'i',
            value: text,
            placeholder: '或者自己写一句…',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void send(text)
              }
            },
            style: {
              flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8,
              border: '1px solid rgba(127,127,127,.4)', background: 'transparent',
              color: 'inherit', fontSize: 13,
            },
          }),
          h('button', {
            key: 's',
            disabled: busy || text.trim() === '',
            onClick: () => { void send(text) },
            style: {
              padding: '6px 14px', borderRadius: 8, border: '1px solid transparent',
              background: busy || text.trim() === '' ? '#9ca3af' : '#2563eb',
              color: '#fff', cursor: busy ? 'default' : 'pointer', fontSize: 13,
            },
          }, '发送答复'),
        ]),
      ])
    }

    /**
     * 对话流里的「收件箱卡」。
     *
     * 挂在 middleman_inbox 的调用行：列出所有 waiting 的票，选项各是一个
     * 按钮，也可以自己写一句。提交走 /answer，票回到 running，卡自己
     * 重新 load。不传 batchId 时按工具语义扫最近 20 个批次。
     *
     * 判断层在 card-model.inboxView；整个渲染包在 try/catch 里，异常时给
     * 占位而不是白屏。
     */
    function InboxCard(props) {
      const [state, setState] = React.useState({ loading: true })
      const { batchId } = safeArgs(props?.phase, props?.block)

      const load = React.useCallback(async () => {
        if (batchId !== undefined) {
          const result = await api('/state?batchId=' + encodeURIComponent(batchId))
          if (result.ok !== true) {
            setState({ loading: false, error: result.error ?? '读不到批次' })
            return
          }
          setState({ loading: false, batches: [result.batch] })
          return
        }
        // middleman_inbox 不传 batchId 时的语义是「全部批次」：先取列表，
        // 再逐个取详情。只取最近 20 个——历史批次多起来之后，一张卡不该
        // 每 3 秒把几十份台账全拉一遍。
        const listed = await api('/state')
        if (listed.ok !== true) {
          setState({ loading: false, error: listed.error ?? '读不到批次列表' })
          return
        }
        const ids = (listed.batches ?? []).slice(0, 20).map((row) => row.id)
        const details = await Promise.all(ids.map((id) => api('/state?batchId=' + encodeURIComponent(id))))
        setState({
          loading: false,
          batches: details.filter((row) => row.ok === true).map((row) => row.batch),
        })
      }, [batchId])

      React.useEffect(() => { void load() }, [load])

      // 收件箱要活着：子会话随时可能停下来问，卡不能只在打开那一刻读一次。
      React.useEffect(() => {
        const timer = setInterval(() => { void load() }, 3000)
        return () => clearInterval(timer)
      }, [load])

      const answer = async (targetBatchId, ticketId, text) => {
        const trimmed = typeof text === 'string' ? text.trim() : ''
        if (trimmed === '') return
        const result = await api('/answer', { batchId: targetBatchId, ticketId, answer: trimmed })
        if (result.ok !== true) alert(result.error ?? '答复没送到')
        await load()
      }

      const render = () => {
        // 参数还没到：别闪一下「缺少批次信息」——middleman_inbox 本来就
        // 允许不带 batchId。
        if (props?.phase === 'preparing') {
          return cardShell([h('span', { key: 'p', style: { opacity: 0.7 } }, '准备收件箱卡…')])
        }
        if (state.loading) return cardShell([h('span', { key: 'l', style: { opacity: 0.7 } }, '读取收件箱…')])
        if (state.error !== undefined) return cardShell([failureLine('e', state.error)])

        const views = []
        for (const batch of state.batches ?? []) {
          const view = cardModel.inboxView(batch)
          if (view.kind === 'missing') continue
          views.push(view)
        }
        const count = views.reduce((sum, view) => sum + view.count, 0)

        const children = [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, [
            h('strong', { key: 't' }, '等用户拍板'),
            h('span', { key: 'c', style: { fontSize: 12, opacity: 0.65 } }, count + ' 张票'),
          ]),
        ]

        if (count === 0) {
          children.push(h('div', { key: 'empty', style: { fontSize: 13, opacity: 0.65 } },
            '现在没有票在等用户拍板。'))
        }

        for (const view of views) {
          if (view.count === 0) continue
          children.push(h('div', {
            key: 'b-' + String(view.id),
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          }, [
            h('div', { key: 'bt', style: { fontSize: 12.5, opacity: 0.65 } },
              view.title + ' · ' + String(view.id)),
            ...view.items.map((item) => h(WaitingTicketCard, {
              key: item.ticketId,
              batchId: view.id,
              item,
              onAnswer: answer,
            })),
          ]))
        }

        return cardShell(children)
      }

      try {
        return render()
      } catch (error) {
        return cardShell([failureLine('x', '收件箱渲染失败：'
          + (error instanceof Error ? error.message : String(error)))])
      }
    }

    /** 装侧边栏行与主栏页面。 */
    function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined) return

      // 直接调用 slots.inject，不包 ctx.effect：inject 本身返回 disposer，
      // 而它注册的是浏览器侧的占位，与宿主 fiber 无关。包一层会让主栏那个
      // key 注册不上，点开是空面板。
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => '中台',
      }, MiddlemanIcon))

      // 批准卡：挂在 design_converge 那行。批准按钮只做 POST，不经过模型。
      slots.inject('tool.call.toolview', () => slots.register({
        name: 'tool.call.toolview',
        key: 'design_converge',
      }, ApprovalCard))

      // 收件箱卡：挂在 middleman_inbox 那行，列出 waiting 的票与选项。
      slots.inject('tool.call.toolview', () => slots.register({
        name: 'tool.call.toolview',
        key: 'middleman_inbox',
      }, InboxCard))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        // 主栏每个占位都要声明 inject：壳把它的返回值当 props 交给组件。
        // ctx 也从这里进去——TicketRow 的「在对话中查看」要拿 uiWorkspace。
        inject: () => ({ ctx }),
      }, MiddlemanPage))
    }

    // uiWorkspace：跳回主会话用（面板上的「在对话中查看」按钮）。
    // 宿主没给这个服务时按钮降级为提示，不挡别的功能。
    return { name: 'dsh-whale-middleman', inject: ['slots', 'uiWorkspace'], apply }
  },
})