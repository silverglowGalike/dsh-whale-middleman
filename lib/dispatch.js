/**
 * 派发：把一张工单变成一个真实的、挂起的子会话。
 *
 * 顺序固定为 create → rename → selectModel → 停手。**不发第一条消息**，
 * 这就是「挂起」的全部含义：会话已经存在、模型已经定好，但要等你点执行
 * 才真正开始干活。
 *
 * selectModel 有个副作用：它内部会顺带把全局默认模型改掉。派五个子任务，
 * 你下次新建会话的默认模型就变成最后一个子任务用的了。所以这里在改之前
 * 记下当前默认，改完立刻恢复。
 *
 * @module dsh-whale-middleman/dispatch
 */
import { randomUUID } from 'node:crypto'
import { MiddlemanError } from './refusals.js'

/**
 * 默认模型的「读 → 改 → 恢复」必须串行。
 *
 * selectModel 会顺带改全局默认模型，调用方读一次、改一次、再恢复。两份
 * 派发并发时（两个批次同时批准、/retarget 撞上 observer 启动后继），
 * 顺序可能变成 A读D → A改M1 → B读M1 → B改M2 → A恢复D → B恢复M1，
 * 用户的全局默认模型就被静默改成了某个子任务的模型。
 */
let modelTail = Promise.resolve()

/**
 * 把一段「读默认 → selectModel → 恢复」串起来执行。
 * @param fn - 要串行执行的回调（自己负责 finally 恢复）。
 * @returns 回调结果。
 */
async function withModelLock(fn) {
  const previous = modelTail
  let release
  modelTail = new Promise((resolve) => { release = resolve })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

/** 这一层需要宿主提供的全部能力，窄到只有本模块会调的那几个。 */
export function createDispatcher(faces) {
  /**
   * 对宿主网关发一次调用。
   * @param namespace - 命名空间，本模块只碰 session。
   * @param method - 方法名。
   * @param request - 载荷；无参数的两个端点直接传 {}。
   */
  const call = async (namespace, method, request) => {
    const gateway = faces.gateway?.()
    if (gateway === undefined) {
      throw new MiddlemanError('gateway-unavailable', '这个部署没有可用的宿主网关，无法建会话')
    }
    return await gateway.invoke({
      namespace,
      method,
      args: namespace === 'session' && method === 'modelCatalog' ? {} : { request },
      peer: faces.peer(),
      // 网关内部会读 signal.aborted；不给它一个，modelCatalog 这类无参数端点
      // 会直接抛 "Cannot read properties of undefined (reading 'aborted')"。
      signal: faces.signal ?? AbortSignal.timeout(60_000),
    })
  }

  /**
   * 读全局默认模型，供 selectModel 之后恢复。
   * @returns 当前默认路由，读不到时 undefined。
   */
  const readDefault = () => {
    try {
      const model = faces.defaultModel?.()
      if (model === undefined || typeof model !== 'object') return undefined
      const provider = typeof model.provider === 'string' ? model.provider : undefined
      const id = typeof model.model === 'string' ? model.model : undefined
      if (provider === undefined || id === undefined) return undefined
      return {
        provider,
        model: id,
        ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * 恢复全局默认模型。恢复失败不算派发失败：子会话已经建好、模型已经定好，
   * 默认模型没恢复只是环境问题，记一行日志比让整次派发回滚更合理。
   * @param previous - 派发前读到的默认路由。
   */
  const restoreDefault = async (previous) => {
    if (previous === undefined) return
    try {
      await faces.defaultModelSave?.(previous)
    } catch (error) {
      faces.warn?.('[dsh-whale-middleman] 默认模型没能恢复：' + String(error))
    }
  }

  return {
    /** 读模型目录，供面板与工具选择。优先用宿主直接给的，退回网关。 */
    async modelCatalog() {
      const direct = await faces.catalog?.()
      if (direct !== undefined) return direct
      return await call('session', 'modelCatalog', {})
    },

    /**
     * 建一个挂起的子会话。
     * @param ticket - 工单，需要 title / brief / model。
     * @param options - workspaceId、preset 等可选项。
     * @returns 新会话 id 与本次实际使用的模型。
     */
    async spawn(ticket, options = {}) {
      let created
      try {
        // session.create 接受 workspaceId 或 cwd（二选一，两个都给会被拒）。
        // 不给位置的话，会话会落在 profile 目录里，跟用户的项目无关。
        created = await call('session', 'create', {
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
        })
      } catch (error) {
        throw new MiddlemanError(
          'session-create-failed',
          '宿主拒绝了建会话：' + (error instanceof Error ? error.message : String(error)),
        )
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new MiddlemanError('session-create-failed', '宿主没有返回会话 id')
      }

      try {
        await call('session', 'rename', { sessionId, title: ticket.title })
      } catch (error) {
        faces.warn?.('[dsh-whale-middleman] 会话重命名失败，继续派发：' + String(error))
      }

      let applied
      try {
        applied = await withModelLock(async () => {
          const previous = readDefault()
          try {
            if (ticket.model === undefined) return undefined
            const selected = await call('session', 'selectModel', {
              sessionId,
              ...(ticket.model.provider === undefined ? {} : { provider: ticket.model.provider }),
              model: ticket.model.model,
              ...(ticket.model.reasoningEffort === undefined ? {} : { reasoningEffort: ticket.model.reasoningEffort }),
            })
            return selected?.selected ?? ticket.model
          } finally {
            // 无论选没选成功都要让全局默认回到原样。
            await restoreDefault(previous)
          }
        })
      } catch (error) {
        // 钉不上模型时，刚建好的会话不能就这么扔掉。
        //
        // 为什么：会话已经建出来了，宿主已经在计费。原来的写法把 id 丢掉
        // ——账本上没有它，它也不会被取消，于是成了一个没人管、还在计费的
        // 孤儿。而且票的状态还是 pending，再派一次就是**又一个**会话。
        //
        // 所以：先试着取消掉它，再报错。
        try {
          await call('session', 'cancel', { sessionId })
        } catch (cancelError) {
          faces.warn?.('[dsh-whale-middleman] 钉模型失败后会话取消不掉，可能留下一个孤儿会话 ' + sessionId
            + '：' + String(cancelError))
        }
        throw new MiddlemanError(
          'model-pin-failed',
          '会话建好了但模型钉不上：' + (error instanceof Error ? error.message : String(error))
            + '（会话 ' + sessionId + ' 已尝试取消）',
        )
      }

      // 宿主回包里的 selected 只带它认得的字段——实测它不带 reasoningEffort。
      // 直接拿它覆盖 ticket.model 的话，用户设的强度就没了，卡片上「推理
      // 强度」那一行跟着空掉——显示的与实际跑的不是一回事。
      //
      // 所以以**我们钉进去的那个**为准：宿主回包只用来确认它认了哪个
      // provider/model，强度等字段仍取自 ticket.model。
      const appliedModel = applied === undefined || applied === null
        ? ticket.model
        : {
          provider: applied.provider ?? ticket.model?.provider,
          model: applied.model ?? ticket.model?.model,
          ...(typeof ticket.model?.reasoningEffort === 'string'
            ? { reasoningEffort: ticket.model.reasoningEffort }
            : (typeof applied.reasoningEffort === 'string'
              ? { reasoningEffort: applied.reasoningEffort }
              : {})),
        }

      return { sessionId, model: appliedModel }
    },

    /** 给一个挂起的会话发第一条消息，也就是「执行」。 */
    async run(sessionId, text) {
      await call('session', 'prompt', {
        sessionId,
        requestId: 'dsh-whale-middleman-' + randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    },

    /**
     * 给一个已经建好的子会话换模型。
     *
     * 这是「调整模型」那条需求的落点：票派出去之后，用户在面板上改了主意，
     * 子会话的模型得跟着换。这里只换模型，不改别的——
     * 已经发出去的消息、已经跑了一半的活，都不碰。
     *
     * selectModel 有个副作用：它内部会顺带把全局默认模型改掉（跟 spawn
     * 里一样）。所以这里也要读一次默认、换完恢复——不然用户改一张票的
     * 模型，主会话自己的默认模型就被带偏了。
     *
     * @param sessionId - 子会话 id。
     * @param model - {provider?, model, reasoningEffort?}。
     * @returns 宿主实际选中的模型。
     */
    async selectModel(sessionId, model) {
      if (model === undefined || model === null || typeof model.model !== 'string') {
        throw new MiddlemanError('invalid-model', '必须带 model: {provider, model}')
      }
      let selected
      try {
        selected = await withModelLock(async () => {
          const previous = readDefault()
          try {
            return await call('session', 'selectModel', {
              sessionId,
              ...(model.provider === undefined ? {} : { provider: model.provider }),
              model: model.model,
              ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
            })
          } finally {
            await restoreDefault(previous)
          }
        })
      } catch (error) {
        throw new MiddlemanError(
          'model-pin-failed',
          '模型钉不上：' + (error instanceof Error ? error.message : String(error)),
        )
      }
      return selected?.selected ?? model
    },

    /** 给运行中的子会话追加一条指令。 */
    async steer(sessionId, text) {
      await call('session', 'prompt', {
        sessionId,
        requestId: 'dsh-whale-middleman-steer-' + randomUUID(),
        mode: 'steer',
        content: [{ type: 'text', text }],
      })
    },

    /** 取消一个会话。 */
    async cancel(sessionId) {
      await call('session', 'cancel', { sessionId })
    },

    /**
     * 读一个会话尾部的历史，用来取最后一轮答复。
     * @param sessionId - 会话 id。
     * @returns 事件数组。
     */
    /**
     * 读一个会话尾部的历史。
     *
     * 为什么不能直接 page({ throughSeq: -1 })：throughSeq 是「读到第几号事件」，
     * -1 读作「截止到 -1」，于是 slice(cut, 0) 永远返回空数组——看上去像
     * 「子会话一个字没说」。正确姿势是先 follow 拿当前 cursor，再按它翻页。
     * @param sessionId - 会话 id。
     * @returns page 的 records（每项 {type:'event', event}）。
     */
    async tail(sessionId) {
      const address = { kind: 'session', sessionId }
      // follow 的 snapshot 帧里已经带着完整的历史（records），直接用它。
      //
      // 为什么不用 page：page 的 throughSeq 是「读到第几号事件」，猜错就抛
      // "past cursor"，猜成 -1 则 slice(cut, 0) 永远是空数组——两种猜法都
      // 表现为「子会话一个字没说」。follow 不用猜，它自己报 cursor。
      // 窗口给到 200 条：回执与正文都从这份快照里读。一个 20 步的 turn
      // 光事件就上百条（step/start、assistant/message、tool/call、tool/result
      // 四条一组），60 条会把 turn 开头的工具调用挤出去——回执读不到就会被
      // 判成「没交回执」，正是这次要修的那类误判。
      const stream = await faces.stream?.('session', 'follow', { address, maxMessages: 200 })
      if (stream === undefined) {
        // 流式端点不可用：这是**读不到**，不是「子会话没说话」。
        // 抛出去让观察器记成 tailError——否则回报里会写「(没有文字答复)」，
        // 人分不清是它真没说话，还是我们没读到。
        throw new MiddlemanError('tail-unavailable', '读不到子会话历史：宿主没有提供流式端点')
      }
      const iterator = stream[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        const frame = first.done === true ? undefined : first.value
        if (frame?.type === 'snapshot' && Array.isArray(frame.records)) {
          return frame.records
        }
        throw new MiddlemanError('tail-unavailable', '读不到子会话历史：宿主没有返回历史快照')
      } finally {
        if (typeof iterator.return === 'function') await iterator.return()
      }
    },
  }
}

/**
 * 从一段会话历史里提取**这一轮**的助手答复。
 *
 * 为什么必须按轮切：会话是多轮的，把所有 assistant/message 拼起来会把上一轮
 * 的正文也塞进这一轮的报告里。事件带 `data.turn`（DSH 会话日志实测有），
 * 按它切；老日志没有 turn 号时退回到「最后一个 turn/start 之后」。
 *
 * @param events - session/page 的事件数组。
 * @param turn - 要取的轮次；缺省取最后一轮。
 * @returns 这一轮助手说的话，没有时返回空串。
 */
export function lastAssistantText(events, turn) {
  const list = Array.isArray(events) ? events : []
  const wantTurn = Number.isFinite(turn) ? turn : undefined
  let lastTurnStartAt = 0
  let targetStartAt
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]?.event ?? list[index]
    if (event?.type !== 'turn/start') continue
    lastTurnStartAt = index
    if (wantTurn !== undefined && event.data?.turn === wantTurn) targetStartAt = index
  }
  const startAt = targetStartAt ?? lastTurnStartAt
  // 下一轮的 turn/start 就是这一轮的边界：不切的话会把后面几轮的正文也拼进来。
  let endAt = list.length
  for (let index = startAt + 1; index < list.length; index += 1) {
    const event = list[index]?.event ?? list[index]
    if (event?.type === 'turn/start') {
      endAt = index
      break
    }
  }
  const texts = []
  for (let index = startAt; index < endAt; index += 1) {
    const event = list[index]?.event ?? list[index]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? event.data?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  return texts.join('\n').trim()
}

/**
 * 子会话用来交回执（自评 + 最终汇报）的工具名。
 *
 * 结算路径按这个名字在**子会话历史**里找 tool/call 的参数——不另外写台账。
 * 原因是结算本身就在读历史，把回执也放进同一次读取，就少一条
 * 「工具写台账 → 观察器写台账」的 CAS 竞争路径。
 */
export const DONE_RECEIPT_TOOL = 'middleman_report_done'

/**
 * 从这一轮历史里读回执：`{outcome, report, note}`。
 *
 * 按 turn 核实，不能只看「历史上出现过」：第 1 轮交过回执、第 2 轮续跑
 * 没交，第 2 轮就不算完成。同一轮调了多次时以**最后一次**为准。
 *
 * `outcome` 只认 `done` / `needs_review`；参数解析失败或 outcome 不合法时
 * 当成「没有回执」（返回 undefined）——中台不替子会话猜它想说什么。
 *
 * @param events - 会话历史（`tail()` 的 records，或测试里的裸事件）。
 * @param turn - 要核实的轮次；缺省时只要求出现在最后一轮里。
 * @returns {outcome, report, note} 或 undefined。
 */
export function readReceipt(events, turn) {
  const list = Array.isArray(events) ? events : []
  const wantTurn = Number.isFinite(turn) ? turn : undefined
  let found
  for (const entry of list) {
    const event = entry?.event ?? entry
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (data.name !== DONE_RECEIPT_TOOL) continue
    if (wantTurn !== undefined && typeof data.turn === 'number' && data.turn !== wantTurn) continue
    let args
    try {
      args = JSON.parse(data.arguments ?? '{}')
    } catch {
      continue
    }
    const outcome = args?.outcome
    if (outcome !== 'done' && outcome !== 'needs_review') continue
    found = {
      outcome,
      report: typeof args.report === 'string' ? args.report : '',
      note: typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim() : undefined,
    }
  }
  return found
}

/**
 * 从一段会话历史里提取结构化摘要：改了哪些文件、跑了什么命令。
 * 摘要由插件从事件里算，不靠子会话自觉写。
 * @param events - session/page 的事件数组。
 * @returns 摘要。
 */
export function summarize(events) {
  const files = new Set()
  const commands = []
  for (const entry of events) {
    const event = entry?.event ?? entry
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    let args
    try {
      args = JSON.parse(event.data?.arguments ?? '{}')
    } catch {
      continue
    }
    if (name === 'edit' || name === 'write') {
      const path = args.file_path
      if (typeof path === 'string' && path !== '') files.add(path)
    } else if (name === 'bash' || name === 'pwsh') {
      // 本机子会话的命令工具是 `pwsh`（Windows 部署）。原来只认 `bash`，
      // 于是回传摘要里的「跑了什么命令」从来是空的——按命令判断产出的
      // 任何检查都会因此误判。
      const command = args.command
      if (typeof command === 'string' && command !== '') commands.push(command.split('\n')[0].slice(0, 120))
    }
  }
  return { files: [...files], commands: commands.slice(0, 12) }
}

/**
 * 点执行（或批准后自动开跑）时发给子会话的第一条消息：任务书 + 它那张票的风险。
 *
 * **依赖表不进这里**：子会话只看得到自己的 brief，永远看不到 `blockedBy`。
 * 依赖是主会话/面板的事，写进子会话上下文只会占 token 并让它以为要等谁。
 *
 * 放在 dispatch 层而不是 routes 层：观察器在结算后自动启动后继票时也要拼
 * 同一条消息，不能让队列求值去 import HTTP 路由。
 *
 * @param batch - 批次。
 * @param ticket - 工单。
 * @returns 消息正文。
 */
export function buildBrief(batch, ticket) {
  const lines = [ticket.brief === '' ? ticket.title : ticket.brief]
  if (Array.isArray(ticket.riskIds) && ticket.riskIds.length > 0) {
    const risks = (batch.risks ?? []).filter((risk) => ticket.riskIds.includes(risk.id))
    if (risks.length > 0) {
      lines.push('')
      lines.push('## 这张工单关联的风险')
      for (const risk of risks) {
        lines.push('- ' + risk.id + ' ' + risk.title)
        lines.push('  触发: ' + risk.trigger)
        lines.push('  缓解: ' + risk.mitigation)
        lines.push('  验证: ' + risk.verification)
      }
    }
  }
  if (Array.isArray(batch.spec?.acceptance) && batch.spec.acceptance.length > 0) {
    lines.push('')
    lines.push('## 验收标准')
    for (const item of batch.spec.acceptance) lines.push('- ' + item)
  }
  // 盘问要克制：子会话能自己查、自己判断的，不该把细节抛回给主会话/用户。
  lines.push('')
  lines.push('## 遇到拿不准的')
  lines.push('- 能自己查、能自己判断的别停下来问；按你认为最合理的方案继续，'
    + '把假设和取舍写进最终汇报。')
  lines.push('- 只有真的走不下去（缺凭据、需要人授权、会改变设计方向）才调用 `request_confirmation`；'
    + '提权等待是正常的，不用报错。')
  // 收尾要求必须写进任务书：回执是子会话**自己**交自评 + 最终汇报的唯一通道，
  // 它不知道这条规矩就不会调，结算就会判成 no_receipt。
  // 通过与否由子会话自测决定——中台是程序，不读报告判断内容。
  lines.push('')
  lines.push('## 收尾（硬性）')
  lines.push('- 这一轮结束前，先写好**最终汇报**（做了什么、验证了什么、还剩什么），'
    + '把它作为 `report` 参数调用 `middleman_report_done`：')
  lines.push('  - 自测通过 → `outcome: "done"`，主会话会收到汇报，后继按依赖自动开跑；')
  lines.push('  - 没通过 / 拿不准 / 只做了一部分 → `outcome: "needs_review"`，主会话收到汇报但不会自动开跑。')
  lines.push('- 没有回执的一轮按未完成结算（no_receipt）。')
  lines.push('- 通过与否由你自测；复杂任务建议在主会话设计阶段拆一张独立验证票，不要只靠自评。')
  return lines.join('\n')
}