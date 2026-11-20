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
export const TONE = {
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
export function argsRawOf(phase, block) {
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
export function argsOf(phase, block) {
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
export function modelOptions(catalog) {
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
export function modelLabel(ticket) {
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
export function ticketView(ticket) {
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
export function dependencyView(ticket, now = Date.now()) {
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
export function batchView(batch) {
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
export function inboxView(batch) {
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
