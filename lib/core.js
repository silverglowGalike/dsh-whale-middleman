/**
 * 纯规则层：设计树、前沿、风险、三道闸门。
 *
 * 这一层不碰宿主、不碰文件系统、不碰网络，因此可以单测。所有「不许」
 * 都落在这里，而不是提示词里——提示词会被模型合理化掉。
 *
 * @module dsh-whale-middleman/core
 */

/** 风险四栏：字段名与中文名。 */
export const RISK_FIELDS = [
  ['trigger', '触发条件'],
  ['impact', '影响'],
  ['mitigation', '缓解'],
  ['verification', '怎么验证'],
]

/** 一栏的最短有效长度；低于它的多半是「无」「n/a」这类敷衍。 */
const MIN_FIELD = 4

/**
 * 敷衍语黑名单：长度够了但依然没内容的写法。
 *
 * 为什么长度不够：MIN_FIELD = 4 拦得住「无」「没有」，可英文的
 * none / null / n.a. 正好 4 个字符，从长度上完全合格——但它们跟「无」
 * 是一回事。
 */
const FILLER_WORDS = new Set([
  'none', 'null', 'nil', 'nan', 'n/a', 'n.a', 'na', 'tbd', 'todo',
  'unknown', 'nothing', 'empty', 'xxx', '???', '---', 'xxx.',
])

/** 一栏是不是敷衍语。 */
function isFiller(value) {
  const normalized = value.trim().toLowerCase().replace(/[.\s]+$/, '')
  return FILLER_WORDS.has(normalized)
}

/** 一个决定是否已经闭合。 */
export function isClosed(decision) {
  // 空答案等于没回答。判据跟 designGateProblems 里数答案时一样：
  // 都要 trim 后非空，否则账本里 answer: '' 的决定会被算成已定，
  // 收敛闸门就把没问完的设计放过去了。
  const answered = typeof decision?.answer === 'string' && decision.answer.trim() !== ''
  const deferred = decision?.deferred !== undefined && decision?.deferred !== null
  return answered || deferred
}

/** 依赖是否都满足。 */
function depsSatisfied(batch, decision) {
  return (decision.dependsOn ?? []).every((id) => {
    const parent = (batch.decisions ?? []).find((candidate) => candidate.id === id)
    return parent !== undefined && isClosed(parent)
  })
}

/** 前沿：未闭合且前置条件已满足的决定。 */
export function frontier(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision) && depsSatisfied(batch, decision))
}

/** 被挡住的决定：未闭合，但至少一个前置条件还没定。 */
export function blocked(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision) && !depsSatisfied(batch, decision))
}

/** 还没闭合的决定总数。 */
export function openCount(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision)).length
}

/**
 * 在一组「节点 + 依赖」里找出一条环。
 *
 * 按**下标**建图，不按 id——id 重复时按 id 建图会让后者覆盖前者，
 * 被覆盖那张票的边就此消失，真实成环就检不出来了。
 *
 * @param nodes - 节点数组，每项 {id, deps: string[]}。
 * @returns 环上的 id 序列；没有环返回 undefined。
 */
function findCycleIn(nodes) {
  const state = new Map()
  const stack = []
  const visit = (index) => {
    const mark = state.get(index)
    if (mark === 'done') return undefined
    if (mark === 'open') {
      const at = stack.indexOf(index)
      return [...stack.slice(at), index]
    }
    state.set(index, 'open')
    stack.push(index)
    for (const dep of nodes[index].deps ?? []) {
      const target = nodes.findIndex((node) => node.id === dep)
      if (target < 0) continue
      const found = visit(target)
      if (found !== undefined) return found
    }
    stack.pop()
    state.set(index, 'done')
    return undefined
  }
  for (let index = 0; index < nodes.length; index++) {
    const found = visit(index)
    if (found !== undefined) return found.map((i) => nodes[i].id)
  }
  return undefined
}

/** 依赖边校验：指向不存在的决定、依赖自己、成环。 */
export function dependencyProblems(batch) {
  const decisions = Array.isArray(batch?.decisions) ? batch.decisions : []
  const ids = new Set(decisions.map((decision) => decision.id))
  const problems = []
  for (const decision of decisions) {
    for (const dep of decision.dependsOn ?? []) {
      if (dep === decision.id) problems.push(decision.id + ' 依赖了它自己')
      else if (!ids.has(dep)) problems.push(decision.id + ' 依赖了不存在的 ' + dep)
    }
  }
  // 成环：环里的决定互相阻塞，前沿永远是空的——于是「前沿清空」这个
  // 判据会把一棵永远走不完的树当成走完了。必须单独查环。
  const cycle = findCycleIn(decisions.map((decision) => ({ id: decision.id, deps: decision.dependsOn ?? [] })))
  if (cycle !== undefined) {
    problems.push('决定依赖成环：' + cycle.join(' -> ') + '（环里的决定互相阻塞，永远定不下来）')
  }
  return problems
}

/**
 * 找出工单依赖里的环。
 *
 * 与 `dependencyProblems` 里的决定环检测共用同一个实现。`middleman_rewire`
 * 在批次批准之后也能改依赖表——批准时检过一次环不等于以后没有，一次手滑
 * 就能让两张票互相等：环里的票永远进不了 startable，也不会有任何回传，
 * 用户只会看见「卡住了」。所以改依赖时按**改完的样子**再检一次。
 *
 * @param tickets - 工单数组，每项 {id, blockedBy}。
 * @returns 环上的 id 序列；没有环返回 undefined。
 */
export function ticketCycle(tickets) {
  const list = Array.isArray(tickets)
    ? tickets.filter((ticket) => ticket !== null && typeof ticket === 'object')
    : []
  return findCycleIn(list.map((ticket) => ({ id: ticket.id, deps: ticket.blockedBy ?? [] })))
}

/**
 * 取一轮要问的问题。
 *
 * 一条由代码保证的规则：**只要一条风险都还没登记，就追加一条风险探测问**。
 * 登记过之后不再追问，否则同一句问题会在每一轮重复，把盘问变成噪音。
 */
export function nextRound(batch, size = 4) {
  const open = frontier(batch)
  const limit = Number.isInteger(size) && size > 0 ? size : 0
  const picked = open.slice(0, limit)
  const hasRiskProbe = picked.some((decision) => decision.kind === 'risk')
  const needsProbe = !hasRiskProbe && (Array.isArray(batch.risks) ? batch.risks : []).length === 0
  let probe
  if (needsProbe && limit > 0) {
    const fromFrontier = open.find((decision) => decision.kind === 'risk')
    if (fromFrontier !== undefined && !picked.includes(fromFrontier)) {
      // 探测问也受 size 约束——「一轮最多几问」是写进提示段的规矩，
      // 这里不加约束的话 size=2 会问出 3 个。
      if (picked.length < limit) picked.push(fromFrontier)
    } else if (fromFrontier === undefined) {
      probe = {
        id: 'PROBE',
        title: '风险探测',
        body: '这个方案在什么情况下会失败？给一个具体的触发条件，不要只说「可能有风险」。',
        recommended: '先写下最可能失败的那条路径，再决定要不要为它加一道检查。',
        synthetic: true,
      }
    }
  }
  const asked = picked.filter((decision) => decision.synthetic !== true).length
  return {
    questions: probe === undefined ? picked : [...picked, probe],
    asked,
    // remaining 是**整棵树**还剩多少，不是前沿上剩多少。
    //
    // 原来按前沿算，于是被挡住的那几个不计入——界面上一路显示「还剩 0 个」，
    // 可实际上还有好几个没定。两个数互相打架（这里与 openCount）。
    remaining: Math.max(0, openCount(batch) - asked),
    blockedCount: blocked(batch).length,
  }
}

/** 找出一条风险缺了哪几栏。 */
export function riskGaps(risk) {
  const gaps = []
  for (const [field, label] of RISK_FIELDS) {
    const value = risk?.[field]
    if (typeof value !== 'string') { gaps.push(label); continue }
    const trimmed = value.trim()
    if (trimmed.length < MIN_FIELD || isFiller(trimmed)) gaps.push(label)
  }
  return gaps
}

/**
 * 验证方式里承诺的单测，是不是真的存在。
 *
 * 为什么要查：验证方式这一栏是模型自己写的，写「单测：…」很容易——写了不等于
 * 有。真出过：一条风险的验证方式写着「单测：不传 batchId 断言抛错且不建会话」，
 * 仓库里根本没有这条测试，缓解措施只是写着，没被任何东西盯住。
 *
 * 判据分两种写法：
 * - 写了完整文件名（如 test/never-written.test.mjs）：那个文件必须存在，
 *   少一个都不行——承诺了不存在的文件，就是假承诺。
 * - 只写主干名（如 risk-r1 里断言…）：那个主干得对得上某个测试文件。
 * - 什么都没写：拒绝，并让模型改写成「人工核对：…」。
 *
 * 不含「单测」二字的不管——那可能是「这次跑一遍看看」这种一次性人工验证，
 * 本来就没法自动核。
 *
 * @param risk - 一条风险。
 * @param testFiles - 仓库里现有的测试文件名集合。
 * @returns {string} 问题描述；没问题时是空串。
 */
export function verificationTestGap(risk, testFiles) {
  const verification = typeof risk?.verification === 'string' ? risk.verification : ''
  const files = testFiles instanceof Set ? testFiles : new Set(testFiles ?? [])

  /** 测试文件去掉 .test.mjs 之类的后缀后剩下的主干。 */
  const stems = new Set([...files].map((file) => file.replace(/\.(?:test|spec)\.(?:mjs|js|ts)$/, '')))

  // 措辞里提到「单测」这一类的，才可能是自动验证。纯人工核对不查。
  //
  // 为什么认这么多同义词：只看「单测」二字时，「单元测试」「自动化测试」
  // 「unit test」全都绕过去了——而它们跟「单测」是一回事。
  const claimsUnitTest = /单测|单元测试|自动化测试|unit\s*test|unittest/i.test(verification)
  if (!claimsUnitTest) return ''

  // 写法一：写了完整文件名——逐个查，少一个都不行。
  //
  // 后缀跟 lib/verifyscan.js 的口径对齐（mjs / js / ts）：只认 mjs 的话，
  // 写 test/core.test.ts 会整个漏过严格检查。
  //
  // 匹配按**文件名**比，不按前缀：core.mjs 的主干是 core，而仓库里
  // core.test.mjs 的主干也是 core——用 startsWith 前缀匹配会把前者
  // 放行，可 core.mjs 根本不存在。
  const named = verification.match(/[\w./-]+\.(?:test\.|spec\.)?(?:mjs|js|ts)\b/g) ?? []
  if (named.length > 0) {
    // 一个测试文件都没扫到：这不是「这个文件不存在」，而是「这个目录根本
    // 没有测试」。两种情况要分开说——不然用户会去翻仓库找那个文件，
    // 找不到还以为写错了名字。
    if (files.size === 0) {
      return (risk?.id ?? '这条风险') + ' 的验证方式写的是单测，但批次所在目录一个测试文件都没扫到'
        + '（扫的是批次记下的 cwd）；要么把批次开在有 test 目录的项目里，'
        + '要么把验证方式改成「人工核对：…」'
    }
    const missing = named.filter((name) => {
      const tail = name.split('/').pop()
      return ![...files].some((file) => file === name || file.split('/').pop() === tail)
    })
    if (missing.length === 0) return ''
    return (risk?.id ?? '这条风险') + ' 的验证方式说要有 ' + missing.join('、')
      + '，但批次所在目录里没有这条测试（现有：' + [...files].slice(0, 5).join('、')
      + (files.size > 5 ? ' 等 ' + files.size + ' 个' : '') + '）；写完测试再来登记，'
      + '或把验证方式改成「人工核对：…」'
  }

  // 写法二：只写主干名——那个主干得对得上某个测试文件。
  const rest = verification.replace(/[\w./-]+\.(?:test\.|spec\.)?(?:mjs|js|ts)\b/g, ' ')
  const candidates = rest.match(/[\w][\w-]{2,}/g) ?? []
  if (candidates.some((token) => stems.has(token))) return ''

  return (risk?.id ?? '这条风险') + ' 的验证方式承诺了单测，却没说是哪条测试；'
    + '要么写清文件名（如 risk-r1.test.mjs），要么改成「人工核对：…」'
}

/**
 * 校验整本风险台账。
 *
 * @param risks - 风险列表。
 * @param testFiles - 仓库里现有的测试文件名集合（可选，缺省不查单测承诺）。
 * @returns {string[]} 问题列表。
 */
export function riskProblems(risks, testFiles) {
  const problems = []
  const list = Array.isArray(risks) ? risks : []
  if (list.length === 0) {
    problems.push('一条风险都没登记；确实没有风险的话，在批次上写 riskFree 并说明理由')
  }
  for (const risk of list) {
    const gaps = riskGaps(risk)
    const id = risk?.id ?? '这条风险'
    if (gaps.length > 0) problems.push(id + ' 缺：' + gaps.join('、'))
    if (testFiles !== undefined) {
      const gap = verificationTestGap(risk, testFiles)
      if (gap !== '') problems.push(gap)
    }
  }
  return problems
}

/** 收敛：设计树走完、规格有验收标准、风险四栏齐全。 */
export function convergeProblems(batch) {
  const problems = []
  const open = openCount(batch)
  if (open > 0) {
    // 看**整棵树**还剩多少，不是看前沿。
    //
    // 为什么：前沿是「现在就能问的」。决定依赖成环时前沿永远是空的——
    // 环里的决定互相阻塞——于是「前沿清空」把一棵永远走不完的树当成走完了。
    // 所以这里数的是整棵树上还没闭合的决定。
    const ids = (batch.decisions ?? [])
      .filter((decision) => !isClosed(decision))
      .map((decision) => decision.id)
    problems.push('还有 ' + open + ' 个决定没定：' + ids.join('、'))
  }
  const spec = batch.spec
  if (spec === undefined || spec === null) {
    problems.push('还没有规格（goal / nonGoals / acceptance）')
  } else {
    if (typeof spec.goal !== 'string' || spec.goal.trim() === '') problems.push('规格缺目标')
    if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
      problems.push('规格至少要有一条验收标准')
    } else {
      // 每条验收标准也得有料——空的照样算「有验收标准」。
      const blank = spec.acceptance.filter((item) => typeof item !== 'string' || item.trim() === '')
      if (blank.length > 0) {
        problems.push('有 ' + blank.length + ' 条验收标准是空的：每条都要能跑出红绿')
      }
    }
  }
  problems.push(...riskProblems(batch.risks))
  problems.push(...dependencyProblems(batch))
  return problems
}

/**
 * 设计阶段的准入条件。
 *
 * 这一段是插件跟 ask-matt 技能组合的接口：主会话在拆票之前，必须先走完
 * 「盘问 → 收敛」这条路，并且留下三样可查的东西：
 *
 * 1. **问过的问题**（questions）：问了几轮、每轮问了什么。只写代码不提问，
 *    那是绕过盘问，不是完成盘问。
 * 2. **流程规划**（plan）：这件事分几步、每步的产出是什么、什么能并行。
 * 3. **风险清单**（risks）：四栏齐全的风险，以及每条风险的验证方式。
 *
 * 少一样就拆不了票。这条检查写在代码里，不写在提示词里——提示词会被模型
 * 合理化掉，代码不会。
 *
 * @param batch - 设计批次。
 * @returns 问题描述数组，空数组表示设计阶段已达标。
 */
export function designGateProblems(batch) {
  const problems = []
  const answered = answeredQuestionCount(batch.questions)
  if (answered < MIN_ANSWERED_QUESTIONS) {
    problems.push(
      '盘问没做够：至少要有 ' + MIN_ANSWERED_QUESTIONS + ' 个已回答的问题，现在只有 ' + answered
      + ' 个。先问清楚，别急着拆票',
    )
  }
  const plan = batch.plan
  if (plan === undefined || plan === null) {
    problems.push('还没有流程规划（plan）：这次分几步、每步产出什么、什么能并行')
  } else {
    if (typeof plan.steps !== 'string' || plan.steps.trim() === '') {
      problems.push('流程规划缺 steps：这件事分几步')
    }
    if (typeof plan.output !== 'string' || plan.output.trim() === '') {
      problems.push('流程规划缺 output：做完之后留下什么')
    }
  }
  // 风险要**四栏齐全**——不只是「有一条」。文档与提示段都这么写。
  //
  // 原来只查 risks.length === 0，于是四条全是「无」「n/a」的风险也算合规，
  // 而 riskProblems 这个真正的检查就在同一个文件里，只是没接上。
  const risks = Array.isArray(batch.risks) ? batch.risks : []
  if (risks.length === 0) {
    problems.push('风险清单是空的：至少登记一条风险，四栏齐全')
  } else {
    for (const risk of risks) {
      const gaps = riskGaps(risk)
      if (gaps.length > 0) {
        problems.push((risk?.id ?? '一条风险') + ' 缺：' + gaps.join('、') + '（四栏缺一栏就不算风险）')
      }
    }
  }
  return problems
}

/**
 * 盘问至少要问够几个问题才算走过一遍。
 *
 * 三个是下限：一个问目标，一个问范围，一个问失败的样子。低于这个数，
 * 说明设计阶段是走个形式。
 */
export const MIN_ANSWERED_QUESTIONS = 3

/**
 * 数「问过用户、并且答了」的问题有几个。
 *
 * 这是**唯一**的口径：`design_question` 回报进度用它，`designGateProblems`
 * 判断能不能派发也用它。两处各写一遍必然漂——真机上撞到过：工具回报
 * 「answered: 3，够了」，闸门却说「只有 2 个」，用户以为闸门坏了。
 *
 * 三条规矩：
 * 1. 答案 trim 后非空才算答了（空字符串等于没答）。
 * 2. `kind === 'fact'` 不算——事实是模型自己的活，不该拿去问用户。
 * 3. 按问题去重——同一条问三遍不算三个。
 *
 * @param questions - 批次上的 questions 数组。
 * @returns 真正算数的问题个数。
 */
export function answeredQuestionCount(questions) {
  const list = Array.isArray(questions) ? questions : []
  const distinct = new Set()
  for (const entry of list) {
    if (entry?.kind === 'fact') continue
    if (typeof entry?.answer !== 'string' || entry.answer.trim() === '') continue
    if (typeof entry?.question !== 'string') continue
    distinct.add(entry.question)
  }
  return distinct.size
}

/**
 * 票面校验：跟批次批准状态无关的那一部分。
 *
 * 拆出来的原因：`design_split` 在 `converged` 下就要产出草稿票——那时批次
 * 还没批准，但风险引用、id 唯一、model、阻塞边这些照样得查。
 * 复制一份必然漂，所以两处共用这一个函数，差别只在「要不要先看批准状态」。
 *
 * @param batch - 批次。
 * @param testFiles - 仓库里现有的测试文件名集合（可选）。给了才查「承诺的单测在不在」。
 * @returns {string[]} 问题列表。
 */
function ticketProblems(batch, testFiles) {
  const problems = []
  problems.push(...designGateProblems(batch))
  const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
  if (tickets.length === 0) {
    problems.push('还没有工单')
  }
  const ids = new Set(tickets.map((ticket) => ticket.id))
  // 工单 id 必须唯一。
  //
  // 为什么：重复 id 时 find 取的是**第一张**，于是两张都叫 T-1 的票
  // 只会派发第一张，第二张永远拿不到自己的子会话——面板上点哪张都跑
  // 第一张的活。
  if (ids.size !== tickets.length) {
    const seen = new Set()
    const duplicated = [...new Set(tickets.map((t) => t.id).filter((id) => {
      if (seen.has(id)) return true
      seen.add(id)
      return false
    }))]
    problems.push('工单 id 重复：' + duplicated.join('、') + '（每张票的 id 必须唯一）')
  }
  const risks = Array.isArray(batch.risks) ? batch.risks : []
  const riskIds = new Set(risks.map((risk) => risk.id))
  for (const ticket of tickets) {
    if (!ticket.riskFree) {
      if (!Array.isArray(ticket.riskIds) || ticket.riskIds.length === 0) {
        problems.push(ticket.id + ' 没挂风险；确实无关就写 riskFree 并说明理由')
      } else {
        for (const id of ticket.riskIds) {
          if (!riskIds.has(id)) problems.push(ticket.id + ' 引用了不存在的风险 ' + id)
        }
      }
    } else if (typeof ticket.riskFreeReason !== 'string' || ticket.riskFreeReason.trim() === '') {
      problems.push(ticket.id + ' 标了 riskFree 但没写理由')
    }
    for (const dep of ticket.blockedBy ?? []) {
      if (!ids.has(dep)) problems.push(ticket.id + ' 被不存在的工单阻塞：' + dep)
    }
    // 模型要真的指定了是哪个模型。model: {} 看着像「定了」，其实没有——
    // 派发时会拿 undefined 去调 session.selectModel。
    if (typeof ticket.model?.model !== 'string' || ticket.model.model.trim() === '') {
      problems.push(ticket.id + ' 没定模型：得写清 model: {provider, model}')
    }
  }
  // 登记时放过、后来没写的那条单测，在这里再拦一次：
  // 风险的验证方式承诺了单测，就得真的有那条测试，派发前是最后的关口。
  if (testFiles !== undefined) {
    for (const risk of risks) {
      const gap = verificationTestGap(risk, testFiles)
      if (gap !== '') problems.push(gap)
    }
  }
  const cycle = findCycleIn(tickets.map((ticket) => ({ id: ticket.id, deps: ticket.blockedBy ?? [] })))
  if (cycle !== undefined) problems.push('工单阻塞边成环：' + cycle.join(' -> '))
  return problems
}

/**
 * 拆票闸门：`design_split` 在 `converged` 下用的那一套。
 *
 * 草稿票是给用户在批准前改的，所以这里不要求批次已批准；但风险、模型、
 * 依赖边这些校验一字不差，免得草稿态成了绕过检查的后门。
 *
 * @param batch - 批次。
 * @param testFiles - 仓库里现有的测试文件名集合（可选）。
 * @returns {string[]} 问题列表。
 */
export function splitProblems(batch, testFiles) {
  return ticketProblems(batch, testFiles)
}

/**
 * 票是不是已经锁死。
 *
 * 批准之后不再改设计、不再新增票（F3）：要改只能 `/feedback` 追加指令，
 * 要停只能 `/cancel`。这条必须按**批次状态**判，不能只看 `childSessionId`——
 * 否则批准后传一张全新的票，账本上就会多出一张永远没人开跑的草稿票。
 *
 * @param batch - 批次。
 * @returns 是否已锁定。
 */
export function ticketsLocked(batch) {
  const status = batch?.status
  return status === 'approved' || status === 'done' || status === 'cancelled'
}

/**
 * 工单状态的分类。
 *
 * `waiting` 是这轮新加的状态：子会话**主动停下来等用户**。
 *
 * 它跟 `suspended` 不一样，区别很重要：
 * - `suspended`：用户还没点「执行」，子会话建好了但一步没跑。
 * - `waiting`：子会话跑到一半，遇到需要用户拍板的地方，**自己停下来了**。
 *
 * 它也不该被当成 `failed`。把「等你」记成「失败」，后继票会被误挡，
 * 用户也会开始忽略失败通知。
 */
export const TICKET_STATUS = {
  /** 已拆未批，可以自由改。只存在于批次批准之前。 */
  draft: 'draft',
  /** 已批准、等前序工单完成，还没启动。 */
  queued: 'queued',
  /** 用户还没点执行。 */
  suspended: 'suspended',
  /** 子会话正在跑。 */
  running: 'running',
  /** 子会话停下来等用户确认——**这不是失败**。 */
  waiting: 'waiting',
  /** 还没派发。 */
  pending: 'pending',
  /** 正常结束。 */
  done: 'done',
  /** 跑完了但产出不完整（截断、宿主级中断）。 */
  partial: 'partial',
  /**
   * 子会话自评没过/拿不准（回执 `outcome: "needs_review"`）。
   *
   * 状态名与回执口径一致：面板上看到的就是子会话报上来的那个词。
   */
  needs_review: 'needs_review',
  /**
   * 子会话结束了这一轮，但没有交回执。
   *
   * 不是模型报错，也不是用户打断；是「这一轮到底干完没有」无从核实。
   */
  no_receipt: 'no_receipt',
  /** 读不到子会话历史，回执无法核实（宿主没有流式端点/会话读不到）。 */
  receipt_unverified: 'receipt_unverified',
  /**
   * 旧的「传输中断」状态，**只读不再写**。
   *
   * 2026-11-19 起统一按 `failed` + `code: 'NETWORK_FAILED'` 结算（和其他错误
   * 同一族，用 code 前缀区分）。保留它只为读旧台账。
   */
  interrupted: 'interrupted',
  /** 出错了。 */
  failed: 'failed',
  /** **用户**在界面上按了停止（或面板「取消」）。 */
  user_interrupted: 'user_interrupted',
  /** **主会话**取消了这张票（`/cancel` 带 `by: 'lead'`）。 */
  lead_interrupted: 'lead_interrupted',
  /**
   * 旧的「取消」状态，**只读不再写**。
   *
   * 2026-11-19 起拆成 user_interrupted / lead_interrupted：一个词同时表示
   * 「用户按了停止」和「主会话取消了它」，审计时分不清谁做的决定（I-03）。
   * 保留它只为读旧台账。
   */
  cancelled: 'cancelled',
}

/**
 * 一张票是不是停在「等用户」上。
 * @param ticket - 工单。
 * @returns 是否在等用户确认。
 */
export function isWaitingForHuman(ticket) {
  return ticket?.status === TICKET_STATUS.waiting
}

/**
 * 前序票的状态是否**满足**了依赖，可以解锁后继。
 *
 * **只认 `done`。** 这条口径在 2026-11-18 收紧过一次，原因是一起真事故：
 * 一张票的模型只读了两个文件就说「完成了」，宿主把它结算成 `done`，整条
 * 依赖链基于不存在的产出继续跑。修这件事时发现，「部分完成」的一律
 * 自动放行本身也是同一个病：`partial` 表示产出可能不完整/被截断，凭什么
 * 代表「后继可以开工」？该由主会话看了正文再决定。
 *
 * 所以现在的分工是：
 * - `done`：子会话交了回执（自评 done）、中台也认了这一轮 → 自动解锁后继；
 * - `partial` / `needs_review` / `no_receipt` / `receipt_unverified` / `failed` /
 *   `user_interrupted` / `lead_interrupted`：一律**停住**，由主会话
 *   决定放行（`middleman_rewire` 摘掉这条阻塞边）、重跑（面板/`/run` force）
 *   或交给用户判断。
 *
 * 代价是吞吐变慢：被截断的票不再自动接力。这是有意的——放行一个没有产出
 * 的票，代价是整条链白跑；放慢一次，主会话读一眼正文就能补回来。
 *
 * 这跟 `isTerminalStatus` 是两件事：
 * - `isTerminalStatus`：这张票不会再自己动了（含失败/取消），用于「还会不会变」；
 * - `isSatisfiedStatus`：这张票的产出够不够让后继开工，用于依赖求值。
 *
 * 两者混用真出过问题：原来 `readyTickets` 用终态判断依赖，于是一张
 * `failed` 的票也算「前序完成」，后继被放行——可它什么也没做出来。
 *
 * @param status - 工单状态。
 * @returns 是否满足依赖。
 */
export function isSatisfiedStatus(status) {
  return status === TICKET_STATUS.done
}

/**
 * 一个状态是不是终态（不会再变）。
 *
 * 注意：终态不等于「满足」。`failed` / `cancelled` 也是终态，但它们
 * **不解锁**后继——见 `isSatisfiedStatus`。判断「还要不要等它」用这个；
 * 判断「后继能不能开工」用那个。
 *
 * `waiting` **不是**终态——用户一回答，它就接着跑。
 * `suspended` 也不是——用户一点执行，它就开跑。
 *
 * @param status - 工单状态。
 * @returns 是否终态。
 */
export function isTerminalStatus(status) {
  return status === TICKET_STATUS.done
    || status === TICKET_STATUS.partial
    || status === TICKET_STATUS.needs_review
    || status === TICKET_STATUS.no_receipt
    || status === TICKET_STATUS.receipt_unverified
    || status === TICKET_STATUS.failed
    || status === TICKET_STATUS.interrupted
    || status === TICKET_STATUS.user_interrupted
    || status === TICKET_STATUS.lead_interrupted
    || status === TICKET_STATUS.cancelled
}

/**
 * 把任意值折成「无损 JSON」。
 *
 * 为什么需要：宿主的工具输出快照器（walkJsonValue）碰到**任何** undefined
 * 就把整份结果判为非法，报 `value is not lossless JSON`。真实撞过：
 * middleman_status 在「有票但还没派发」时 100% 报这个错，因为
 * `sessionId: ticket.childSessionId` 是 undefined。整整三小时里，状态工具
 * 在最需要它的时候是坏的。
 *
 * 规则：对象里值为 undefined 的键整个丢掉；数组里的 undefined 变 null；
 * 非有限数（NaN/Infinity）变 null；函数/符号丢掉。
 *
 * @param value - 任意值。
 * @param depth - 递归深度（防御自引用，超过 20 层折成 null）。
 * @returns 可无损往返 JSON 的值；顶层是 undefined 时返回 undefined。
 */
export function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'bigint') return value.toString()
  if (kind === 'function' || kind === 'symbol') return undefined
  if (depth > 20) return null
  if (Array.isArray(value)) {
    return value.map((item) => {
      const safe = jsonSafe(item, depth + 1)
      return safe === undefined ? null : safe
    })
  }
  const out = {}
  for (const key of Object.keys(value)) {
    const safe = jsonSafe(value[key], depth + 1)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

/**
 * 就绪的工单：前置都已**满足**，且自己还没开始。
 *
 * 「满足」只认 `done`，见 `isSatisfiedStatus`。`partial` / `needs_review` /
 * `no_receipt` / `receipt_unverified` / `failed` / `cancelled` 都是终态，
 * 但没有「确实干完了」的保证，**不满足**依赖：一张被截断、或者没交回执的票，
 * 不该让后继假装前序已经完成。
 *
 * 注意：这条口径是 `/state.ready` 的展示口径。改了它，面板上「哪些票
 * 还能派」也跟着变。要放行一张没交回执的票，仍然得显式 `middleman_rewire`
 * 摘掉阻塞边，让「绕过去」成为一条留痕的动作，而不是一次静默的自动接力。
 *
 * @param batch - 设计批次。
 * @returns 现在可以派发的工单。
 */
export function readyTickets(batch) {
  const tickets = Array.isArray(batch?.tickets) ? batch.tickets : []
  const satisfied = new Set(tickets.filter((t) => isSatisfiedStatus(t.status)).map((t) => t.id))
  return tickets.filter((ticket) =>
    (ticket.status === undefined || ticket.status === TICKET_STATUS.pending)
    && (ticket.blockedBy ?? []).every((dep) => satisfied.has(dep)))
}

/**
 * 现在就能启动的票：草稿（或旧版 pending）且前置都已满足。
 *
 * 「满足」沿用 `readyTickets` 的口径（只认 done）。跟 `readyTickets` 分开
 * 的原因：那张表是给面板 `/state.ready` 看的，只认 pending；这张是给
 * 「批准即开跑」用的，草稿票也算。混在一起的话，批准后草稿票会被当成
 * 「已派发」之外的另一类，两边都读不懂。
 *
 * @param batch - 设计批次。
 * @returns 现在可以启动的工单。
 */
export function launchableTickets(batch) {
  const tickets = Array.isArray(batch?.tickets) ? batch.tickets : []
  const satisfied = new Set(tickets.filter((t) => isSatisfiedStatus(t.status)).map((t) => t.id))
  return tickets.filter((ticket) =>
    (ticket.status === undefined
      || ticket.status === TICKET_STATUS.draft
      || ticket.status === TICKET_STATUS.pending)
    && (ticket.blockedBy ?? []).every((dep) => satisfied.has(dep)))
}

/** 一张票停在 queued 上、启动失败时用的稳定错误码（报错族，主会话可重试）。 */
export const LAUNCH_FAILED_CODE = 'LAUNCH_FAILED'

/**
 * 依赖表求值：把整批的「现在该启动谁」重新算一遍。
 *
 * 这是**纯函数**：不读写文件、不发消息、不建会话。结算路径只负责把台账
 * 写下来，然后调它一次；启动决策全从这里出来。DSH 重启后重放同一个函数
 * 就能恢复，不需要任何内存状态。
 *
 * 规则：
 * - 只考虑 `status === 'queued'` 的票；
 * - 多前序 = AND：`blockedBy` 里每一张都满足才启动；
 * - 多后继 = fan-out：满足条件的票**全部**出现在 `startable` 里；
 * - 菱形依赖不顺着后继走，靠每次结算重算整批——B、C 都满足时 D 才会出现；
 * - 已经启动失败过（带 `launchError`）的票**不再自动重试**：由主会话
 *   `middleman_retry` 或面板「重试启动」显式清掉标记后再试。这样启动失败
 *   和普通报错走同一套报错族额度，不需要单独的启动计数。
 *
 * 同时给每张 queued 票算一份 `blockedState`（面板的 debug 数据）：
 * 哪些前序满足了、哪些没满足、卡在谁身上。前序在台账里找不到时，那条
 * blocker 带 `missing: true`、`status: 'missing'`，单独标出来。
 *
 * @param batch - 设计批次。
 * @param now - 评估时间，缺省 Date.now()；给测试一个确定值。
 * @returns {{
 *   evaluatedAt: number,
 *   startable: string[],
 *   blockedStates: Record<string, {
 *     evaluatedAt: number,
 *     blockers: Array<{id: string, title: string, status: string, satisfied: boolean, missing?: true}>,
 *     allSatisfied: boolean,
 *   }>,
 * }}
 */
export function evaluateBatch(batch, now = Date.now()) {
  const evaluatedAt = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const tickets = (Array.isArray(batch?.tickets) ? batch.tickets : [])
    .filter((ticket) => ticket !== null && typeof ticket === 'object')
  const byId = new Map()
  for (const ticket of tickets) {
    if (typeof ticket.id === 'string' && ticket.id !== '') byId.set(ticket.id, ticket)
  }

  const blockedStates = {}
  const startable = []
  for (const ticket of tickets) {
    if (ticket.status !== TICKET_STATUS.queued) continue
    if (typeof ticket.id !== 'string' || ticket.id === '') continue
    const deps = Array.isArray(ticket.blockedBy) ? ticket.blockedBy : []
    const blockers = deps.map((id) => {
      const dep = byId.get(id)
      if (dep === undefined) {
        return {
          id,
          // 给面板一句能直接显示的话；`missing` 才是机器判据。
          title: '(不存在的工单)',
          status: 'missing',
          satisfied: false,
          missing: true,
        }
      }
      return {
        id,
        title: typeof dep.title === 'string' ? dep.title : '',
        status: typeof dep.status === 'string' ? dep.status : TICKET_STATUS.pending,
        satisfied: isSatisfiedStatus(dep.status),
      }
    })
    const allSatisfied = blockers.every((blocker) => blocker.satisfied === true)
    blockedStates[ticket.id] = { evaluatedAt, blockers, allSatisfied }
    if (allSatisfied && ticket.launchError === undefined) {
      startable.push(ticket.id)
    }
  }

  return { evaluatedAt, startable, blockedStates }
}

/**
 * 在等用户确认的票。
 *
 * 面板与主会话都靠这个判断「现在有没有东西在等我」。
 *
 * @param batch - 设计批次。
 * @returns 正在等用户的工单。
 */
export function waitingTickets(batch) {
  const tickets = Array.isArray(batch?.tickets) ? batch.tickets : []
  return tickets.filter((ticket) => isWaitingForHuman(ticket))
}

/**
 * turn/end 的 reason 分类。
 *
 * 只有 completed 算成功。max-tokens 与 interrupted 记 partial 而不是 failed：
 * 长任务被截断很常见，一律标失败会让用户开始忽略失败通知。
 *
 * `partial` 只表示「产出被截断/被宿主中断」；回执层的三种结果各有独立状态，
 * 由 `applyReportedOutcome` 叠加：`needs_review` / `no_receipt` /
 * `receipt_unverified`。
 *
 * `aborted` 必须区分是谁按的停止：用户按的 → `user_interrupted`；主会话调
 * `/cancel` 的 → `lead_interrupted`。旧版把两者都记成 `cancelled`，审计时
 * 分不清「AI 的决定」和「用户的决定」（I-03）。
 *
 * @param reason - turn/end 的 reason 对象。
 * @param options - `{ interruptedBy?: 'user' | 'lead' }`，来源由调用方（票上）传。
 * @returns 结算结果。
 */
export function classifyTurnEnd(reason, options = {}) {
  const kind = typeof reason === 'object' && reason !== null ? reason.kind : reason
  if (kind === 'completed') return { status: 'done', note: '', resumable: false }
  if (kind === 'max-tokens') {
    return { status: 'partial', note: '输出撞到 max-tokens，产出被截断', resumable: false }
  }
  if (kind === 'interrupted') {
    // 宿主级中断（重启、进程被收走）：产出不完整，但不是「任务失败」。
    // 不自动续跑——这时候续跑往往是重复劳动，交给用户和面板决定。
    return { status: 'partial', note: '被中断，产出可能不完整', resumable: false }
  }
  if (kind === 'blocked') return { status: 'failed', note: 'turn 被阻塞', resumable: false }
  if (kind === 'aborted') {
    // 中断 ≠ 失败，也 ≠ 同一种中断：用户按的停止与主会话的取消分开记。
    // 两者都**不续跑**——续跑等于「用户按了取消它却接着干」。
    const byLead = options?.interruptedBy === 'lead'
    return {
      status: byLead ? TICKET_STATUS.lead_interrupted : TICKET_STATUS.user_interrupted,
      note: byLead ? '主会话取消了这一轮' : '用户中止了这一轮',
      resumable: false,
    }
  }
  if (kind === 'forked') {
    // 会话被分叉，这一轮没有结算意义。
    return { status: 'running', note: '会话被分叉，不结算', resumable: false, ignore: true }
  }
  if (kind === 'error') {
    // 把适配器给的错误码带出来：欠费（ACCOUNT_QUOTA）、限流、真 bug
    // 在台账里必须能区分，否则「失败」这个词什么都说明不了。
    const failure = reason?.error
    const code = typeof failure?.code === 'string' ? failure.code : undefined
    const message = typeof failure?.message === 'string' ? failure.message : undefined
    const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
    // 传输层断掉 = 这一轮被掐断。DSH 自己会重连/续跑；中台不抢先续跑，
    // 只挂一个宽限期（见 transportGraceAction）。宽限到点也救不回来时，
    // 统一按 failed + code NETWORK_FAILED 结算——不单列 interrupted 状态，
    // 审计时用 code 前缀区分「网络断了」和别的错误。
    if (code === 'TRANSPORT') {
      return {
        status: 'failed',
        note: '网络中断（DSH 重试耗尽）— ' + (detail === '' ? 'TRANSPORT' : detail),
        resumable: false,
        code: 'NETWORK_FAILED',
        network: true,
      }
    }
    return {
      status: 'failed',
      note: detail === '' ? 'turn 以错误结束' : 'turn 以错误结束 — ' + detail,
      resumable: false,
      ...(code === undefined ? {} : { code }),
    }
  }
  return { status: 'failed', note: 'turn 未完成：' + String(kind), resumable: false }
}

/**
 * 传输中断的宽限期。
 *
 * DSH 自己的请求重试是 0.5s 起步、每轮翻倍、5 轮（约 15.5s），发生在
 * turn/end **之前**；中台看到 TRANSPORT 时重试已经结束。所以中台**不再自己
 * 续跑**——先挂 60 秒宽限，等后续活动（手动继续 / 新一轮）来撤销报错；
 * 到点仍无活动才结算成 failed + NETWORK_FAILED，避免「会话又动起来了、
 * 主会话却收到一条报错」。
 */
export const TRANSPORT_GRACE_MS = 60_000

/**
 * 宽限期到点时的动作。
 *
 * @param grace - `{at, turn}`；没有宽限标记时传 undefined。
 * @param facts - `{now, lastEventTime, lastTurnEndTurn}`。
 * @returns `'none' | 'wait' | 'activity' | 'expired'`。
 *
 * - `activity`：历史里有比挂宽限时更晚的活动，或出现了更新的 turn/end
 *   → DSH 的续跑生效了，撤销宽限、按新的 turn/end 正常结算；
 * - `expired`：到点仍无活动 → DSH 也救不回来，结算成 `failed`（`NETWORK_FAILED`）并报一次；
 * - `wait`：还没到点。
 */
export function transportGraceAction(grace, facts = {}) {
  if (grace === undefined || grace === null) return 'none'
  const { now, lastEventTime, lastTurnEndTurn } = facts
  if (Number.isFinite(lastTurnEndTurn) && Number.isFinite(grace.turn) && lastTurnEndTurn > grace.turn) {
    return 'activity'
  }
  if (Number.isFinite(lastEventTime) && Number.isFinite(grace.at) && lastEventTime > grace.at) {
    return 'activity'
  }
  if (Number.isFinite(now) && Number.isFinite(grace.at) && now - grace.at >= TRANSPORT_GRACE_MS) {
    return 'expired'
  }
  return 'wait'
}

/**
 * 主会话自己发起重试的额度。
 *
 * 定位（用户 2026-11-19）：插件要支持高度自动化——子会话的活是主会话拆的，
 * 用户不一定懂它用的技术，简单报错让主会话自己修，比让用户去 debug 快得多。
 * 而且用户批准方案时就已经授权了「必要的 debug 重跑」，所以重试不该按花钱
 * 一刀切禁掉。
 *
 * 分两族：
 * - **复核族**（`NEEDS_REVIEW` / `RECEIPT_UNVERIFIED` / `NO_RECEIPT`）：
 *   产出不完整或没交自评。这不是钱的问题，是活没干对，重跑不设上限；
 * - **报错族**（网络中断、启动失败、其它 error）：可能是外网/VPN 抖动，
 *   给 5 次。只有主会话**主动**调重试才计数——DSH 自己的请求重试、60 秒宽限
 *   里的自动恢复都不消耗它。
 *
 * 用户动手（面板执行/重跑/重试）会把额度还回去：人是最终决策者。
 *
 * @type {number}
 */
export const LEAD_ERROR_RETRY_LIMIT = 5

/** 重试的两族。 */
export const RETRY_FAMILY = {
  /** 复核族：产出不对/没交自评，重跑不设上限。 */
  review: 'review',
  /** 报错族：有次数上限，防 VPN 抖动把额度刷光。 */
  error: 'error',
}

/**
 * 这张票当前「上一次失败」的机器码。
 *
 * 预算按 code 记账：换了错误码就是换了一个问题，从新额度开始算。
 *
 * @param ticket - 工单。
 * @returns 稳定机器码；没有时是 `UNKNOWN`。
 */
export function retryCode(ticket) {
  // 启动失败是报错族：code 要跨多次重试保持不变，否则每次清掉 launchError
  // 后再失败会被算成「换了一个错误」，5 次额度就永远用不完。
  if (typeof ticket?.launchFailureCode === 'string' && ticket.launchFailureCode !== '') {
    return ticket.launchFailureCode
  }
  const code = ticket?.report?.code
  if (typeof code === 'string' && code !== '') return code
  if (typeof ticket?.launchError === 'string' && ticket.launchError !== '') return LAUNCH_FAILED_CODE
  return 'UNKNOWN'
}

/**
 * 这张票的重试属于哪一族。
 *
 * @param ticket - 工单。
 * @returns `'review'` 或 `'error'`。
 */
export function retryFamily(ticket) {
  const code = retryCode(ticket)
  if (code === 'NEEDS_REVIEW' || code === 'RECEIPT_UNVERIFIED' || code === 'NO_RECEIPT') {
    return RETRY_FAMILY.review
  }
  return RETRY_FAMILY.error
}

/**
 * 主会话能不能重试这张票。
 *
 * 不能由模型重试的状态，各自有更合适的入口：
 * - `running`：已经在跑；
 * - `waiting`：在等用户确认，走 `/answer`；
 * - `suspended`：还没执行，由用户点「执行」——模型不该替用户按下开始；
 * - `done`：已完成，要重做由用户点「重跑」（会重新计费）；
 * - `user_interrupted` / `cancelled`：**用户**叫停的，模型不能擅自拉起来。
 *
 * @param ticket - 工单。
 * @returns `{ allowed, family, code, used, limit, problems }`。
 */
export function planLeadRetry(ticket) {
  const status = ticket?.status
  const refuse = (message, refusalCode = 'retry-not-allowed') => ({ allowed: false, family: retryFamily(ticket), code: retryCode(ticket), used: 0, limit: LEAD_ERROR_RETRY_LIMIT, refusalCode, problems: [message] })
  if (status === TICKET_STATUS.running) return refuse('这张票正在跑：等它这一轮结束再说')
  if (status === TICKET_STATUS.waiting) return refuse('这张票在等用户确认：走 /answer 回答，别重跑')
  if (status === TICKET_STATUS.suspended) return refuse('这张票还没执行：由用户在中台面板点「执行」，模型不替用户按下开始')
  if (status === TICKET_STATUS.done) return refuse('这张票已经完成：要重做请让用户点「重跑」（会重新计费）')
  if (status === TICKET_STATUS.user_interrupted) return refuse('这张票是用户按停止停下的：要接着做请让用户点「执行」/「重跑」')
  if (status === TICKET_STATUS.cancelled) return refuse('这张票已被取消：要重做请让用户点「重跑」')

  const family = retryFamily(ticket)
  const code = retryCode(ticket)
  if (family === RETRY_FAMILY.review) {
    return { allowed: true, family, code, used: 0, limit: null, problems: [] }
  }
  const stored = ticket?.leadRetries
  const used = stored !== undefined && stored !== null && stored.code === code
    && Number.isFinite(stored.used) ? stored.used : 0
  if (used >= LEAD_ERROR_RETRY_LIMIT) {
    return {
      allowed: false,
      family,
      code,
      used,
      limit: LEAD_ERROR_RETRY_LIMIT,
      refusalCode: 'retry-exhausted',
      problems: [
        '这张票已经由主会话重试过 ' + used + ' 次（上限 ' + LEAD_ERROR_RETRY_LIMIT
        + ' 次，code=' + code + '）：别再自己重试了，把情况告诉用户，让用户决定怎么处理',
      ],
    }
  }
  return { allowed: true, family, code, used, limit: LEAD_ERROR_RETRY_LIMIT, problems: [] }
}

/**
 * 用户能不能重试这张票。
 *
 * 用户是最终决策者：除了「正在跑」和「正在等自己回答」这两张，其余都可以
 * 重试/重跑。`done` 仍然要求走「重跑」的确认语义，避免手滑重复计费。
 *
 * @param ticket - 工单。
 * @returns 与 `planLeadRetry` 同形。
 */
export function planUserRetry(ticket) {
  const status = ticket?.status
  const refuse = (message, refusalCode = 'retry-not-allowed') => ({ allowed: false, family: retryFamily(ticket), code: retryCode(ticket), used: 0, limit: null, refusalCode, problems: [message] })
  if (status === TICKET_STATUS.running) return refuse('这张票正在跑，不用重试')
  if (status === TICKET_STATUS.waiting) return refuse('这张票在等你确认：先在面板上答复')
  if (status === TICKET_STATUS.done) return refuse('这张票已经完成：要重做请点「重跑」（会重新计费）')
  return { allowed: true, family: retryFamily(ticket), code: retryCode(ticket), used: 0, limit: null, problems: [] }
}

/**
 * 批次是不是已经结束（派生量，不是存储字段）。
 *
 * 批次自己没有终态：批准之后 `status` 一直停在 approved。所以「结束」只能
 * 从票上算：批准过、有票、且每张票都是终态。面板靠它把旧批次折叠置灰。
 *
 * 只留这一份实现：`/state`、`middleman_status` 与面板都调它。之前 `/state`
 * 列表里手写了一版，口径和 `openCount` 不一样（空字符串答案算「没定」），
 * 同一个批次在列表与详情里显示两个数。
 *
 * @param batch - 批次。
 * @returns 是否已结束。
 */
export function isBatchClosed(batch) {
  const tickets = Array.isArray(batch?.tickets) ? batch.tickets : []
  if (batch?.status !== 'approved') return false
  if (tickets.length === 0) return false
  return tickets.every((ticket) => ticket !== null && typeof ticket === 'object'
    && isTerminalStatus(ticket.status))
}

/**
 * 子会话自评的结果（回执里的 `outcome`）。
 *
 * 判断主体是**子会话**：它自己跑测试/自检，通过就报 `done`，没通过或
 * 拿不准就报 `needs_review`。中台是程序，不读报告判断内容，只核对
 * 「这一轮有没有回执、回执说的是什么」——这是插件能做的全部。
 */
export const OUTCOME = {
  done: 'done',
  needs_review: 'needs_review',
}

/** 读不到历史、回执无从核实时用的哨兵（区别于「没有回执」）。 */
export const RECEIPT_UNVERIFIABLE = 'unverifiable'

/**
 * 把「子会话自评」叠到 turn/end 的分类结果上。
 *
 * 背景（I-01）：`turn/end` 的 `completed` 只说明模型这一轮正常结束，不说明
 * 它把 brief 里的活干了。真事故里模型只读了两个文件、说了一句「让我先看
 * 一眼」，宿主就把它记成 `done`，后继票基于不存在的产出继续跑。
 *
 * 修法（2026-11-18 晚，按用户方案）：子会话在结束前把**最终汇报**作为参数
 * 调 `middleman_report_done`，同时给出自评 `outcome`。中台只按自评记账：
 *
 * - `completed` + `done`          → `done`，后继自动开跑；
 * - `completed` + `needs_review`  → `needs_review`（`NEEDS_REVIEW`），只发汇报，
 *   后继停住，等主会话看完报告决定；
 * - `completed` + 没有回执       → `no_receipt`（`NO_RECEIPT`）——没交自评，
 *   无法判断，宁可停住；
 * - `completed` + 历史读不到     → `receipt_unverified`（`RECEIPT_UNVERIFIED`）；
 * - 其它 reason 不受回执影响（max-tokens / aborted / error…）。
 *
 * @param verdict - `classifyTurnEnd` 的结果。
 * @param receipt - 回执 `{outcome, report, note}`，或 `RECEIPT_UNVERIFIABLE`，或 undefined。
 * @returns 叠加后的结算结果（新对象，不改入参）。
 */
export function applyReportedOutcome(verdict, receipt) {
  if (verdict === undefined || verdict === null) return verdict
  if (verdict.status !== TICKET_STATUS.done) return verdict
  if (receipt === RECEIPT_UNVERIFIABLE) {
    return {
      status: TICKET_STATUS.receipt_unverified,
      note: '读不到子会话历史，无法核实回执：按未完成处理，后继不会自动开跑。',
      resumable: false,
      code: 'RECEIPT_UNVERIFIED',
    }
  }
  if (receipt === undefined) {
    return {
      status: TICKET_STATUS.no_receipt,
      note: '这一轮没有回执（middleman_report_done）：子会话结束了 turn，但没有交自评。'
        + '按未完成处理——不是模型报错，也不是用户打断；后继不会自动开跑。'
        + '先读报告，再决定重跑、改依赖还是交给用户。',
      resumable: false,
      code: 'NO_RECEIPT',
    }
  }
  if (receipt.outcome === OUTCOME.needs_review) {
    const detail = typeof receipt.note === 'string' && receipt.note.trim() !== ''
      ? '：' + receipt.note.trim()
      : ''
    return {
      status: TICKET_STATUS.needs_review,
      note: '子会话自评：需要复核' + detail + '。后继不会自动开跑，等主会话读完报告后决定。',
      resumable: false,
      code: 'NEEDS_REVIEW',
      outcome: OUTCOME.needs_review,
    }
  }
  return {
    status: TICKET_STATUS.done,
    note: '',
    resumable: false,
    outcome: OUTCOME.done,
  }
}
