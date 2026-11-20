/**
 * 台账写入的唯一入口：读最新一份 → 只改你真正改过的字段 → CAS 写。
 *
 * 为什么必须有这一层：`save(batch)` 只保证「读盘比 revision → 写盘」这三步
 * 原子，**不保证你手里那份 batch 是新的**。任何 `load → await 一点东西 →
 * save(batch)` 的写法，都会把中间别人写进去的状态整批盖掉。真撞过的窗口：
 *
 * - `/run` 在 `dispatcher.run`（网络往返，几百毫秒到几秒）之后整批回写；
 * - 批准/求值路径在 `spawn` 之后整批回写——同一批两张票并发启动时，后写的
 *   会把先写的 `childSessionId` 抹成 undefined：会话建出来了，台账不知道，
 *   那张票从此点「执行」也走不动，还留下一个孤儿会话。
 *
 * 所以写台账只有两条路：
 * 1. 新批次第一次落盘：`save(blank, { expectedRevision: 0 })`（ledger 的写锁）；
 * 2. 已存在的批次：`patchBatch` / `patchTicket` —— 这里。
 *
 * **副作用不能放进 mutate**：CAS 冲突会重跑 mutate。spawn / run / cancel
 * 这些宿主调用必须先做完，再进来只贴运行期字段。
 *
 * @module dsh-whale-middleman/commit
 */
import { load, save } from './ledger.js'
import { MiddlemanError, isMiddlemanError } from './refusals.js'

/** 默认重试次数（含第一次）。与 ledger 的写锁叠加，覆盖并发心跳。 */
export const PATCH_ATTEMPTS = 3

/** 是不是「别人先写了」，值得拿最新副本重来一次。 */
function isConflict(error) {
  return isMiddlemanError(error) && error.code === 'revision-conflict'
}

/**
 * 改一个批次：mutate 拿到的是**刚读出来的**批次，改完按它的 revision 写。
 *
 * mutate 的返回值约定：
 * - 返回 `{ refuse }`：不写盘，原样把 refuse 交给调用方（参数校验失败、
 *   状态不符这类拒绝，一个字节都不该落盘）；
 * - 返回其它（或 undefined）：写盘，把 `outcome.result` 放进结果里。
 *
 * @param batchId - 批次 id。
 * @param mutate - `(batch) => Promise<{refuse?}|{result?}|undefined>`。
 * @param options - `{ attempts? }`。
 * @returns `{ ok: true, batch, result? }` 或 mutate 给出的 refuse。
 */
export async function patchBatch(batchId, mutate, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : PATCH_ATTEMPTS
  for (let attempt = 0; attempt < attempts; attempt++) {
    const batch = await load(batchId)
    const outcome = await mutate(batch)
    if (outcome !== undefined && outcome !== null && outcome.refuse !== undefined) {
      return outcome.refuse
    }
    try {
      await save(batch, { expectedRevision: batch.revision })
      return {
        ok: true,
        batch,
        ...(outcome === undefined || outcome === null || outcome.result === undefined
          ? {}
          : { result: outcome.result }),
      }
    } catch (error) {
      if (isConflict(error) && attempt < attempts - 1) continue
      throw error
    }
  }
  throw new MiddlemanError('revision-conflict', '台账一直被别的写入占着：重读一次再试')
}

/**
 * 改一张票：定位、改、写。
 *
 * 找不到票时返回与路由/工具双方都能读懂的形状（`ok:false` + 稳定机器码），
 * 由调用方决定怎么翻成 HTTP 或工具拒绝。
 *
 * @param batchId - 批次 id。
 * @param ticketId - 工单 id。
 * @param mutate - `(ticket, batch) => Promise<{refuse?}|{result?}|undefined>`。
 * @param options - `{ attempts? }`。
 * @returns patchBatch 的返回值。
 */
export async function patchTicket(batchId, ticketId, mutate, options = {}) {
  return patchBatch(batchId, async (batch) => {
    const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
    const ticket = tickets.find((candidate) => candidate !== null && typeof candidate === 'object'
      && candidate.id === ticketId)
    if (ticket === undefined) {
      return {
        refuse: {
          ok: false,
          code: 'ticket-missing',
          message: '没有这张工单：' + String(ticketId),
        },
      }
    }
    return await mutate(ticket, batch)
  }, options)
}
