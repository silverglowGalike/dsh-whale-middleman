/**
 * 台账：一个设计批次一份 JSON，落在 $DSH_HOME/middleman/designs/<id>.json。
 *
 * 只存状态与引用，不存对话正文：正文留在各自会话里，台账只回答
 * 「这个批次走到哪一步、每张票派给了谁」。
 *
 * @module dsh-whale-middleman/ledger
 */
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MiddlemanError } from './refusals.js'

/** DSH 根目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshRoot() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** 本进程第一次选定的台账根目录：一旦选定就不再漂移。 */
let chosenRoot

/**
 * 台账根目录。
 *
 * 三道来源，按优先级：
 * 1. `WT_HOME` 环境变量——测试与演示指到临时目录用。
 * 2. `DSH_HOME`（或默认 `~/.dsh`）下的 `middleman`——正常位置。
 * 3. 同一目录下的 `whale-tail`——**改名之前（原型 whale-tail 鲸鱼尾巴）的旧位置**。
 *
 * 为什么要认旧位置：这插件原型叫 whale-tail（鲸鱼尾巴），台账存在
 * ~/.dsh/whale-tail。改名时如果不认旧路径，手上所有设计批次会在一夜
 * 之间「消失」——数据还在盘上，但插件看不见它们。那种「东西没了又
 * 不知道丢在哪」的体验，比一句明确的报错更糟。
 *
 * 所以只要新目录还没建、而旧目录有东西，就继续用旧的。**不自动搬家**：
 * 搬家要动用户的文件，出问题时更难收拾。等用户自己想清楚再挪，
 * 或者就这么一直用着也没关系。
 *
 * 选定后缓存在进程内：否则新目录一被创建（比如另一处代码先 mkdir），
 * 根就从 whale-tail 静默切走，老批次在面板上整体消失。
 *
 * @returns 台账根目录。
 */
export function home() {
  const override = process.env.WT_HOME
  if (typeof override === 'string' && override !== '') return override
  if (chosenRoot !== undefined) return chosenRoot
  const root = dshRoot()
  const fresh = join(root, 'middleman')
  const legacy = join(root, 'whale-tail')
  chosenRoot = existsSync(fresh) ? fresh : (existsSync(legacy) ? legacy : fresh)
  return chosenRoot
}

/**
 * 批次 id 的合法形状。
 *
 * 为什么必须校验：`pathOf` 把 id 直接拼进台账路径。id 来自 HTTP 查询参数与
 * 模型工具参数，如果允许 `..`、`/`、`\`、`:`，一个 `..\..\..\Users\...`
 * 就能把「读一个批次」变成「读盘上任意一个 JSON 文件」。合法 id 只允许
 * 字母、数字、下划线与短横线，128 个字符以内。
 */
export const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * 这个 id 能不能安全地当文件名用。
 * @param id - 待检查的批次 id。
 * @returns {boolean}
 */
export function isValidBatchId(id) {
  return typeof id === 'string' && BATCH_ID_PATTERN.test(id)
}

/** 一个批次的落盘路径；id 不合法时直接拒绝，绝不拼出工作目录之外的路径。 */
function pathOf(id) {
  if (!isValidBatchId(id)) {
    throw new MiddlemanError('invalid-request', '批次 id 不合法：' + String(id).slice(0, 80))
  }
  return join(home(), 'designs', id + '.json')
}

/**
 * 进程内的写锁。
 *
 * `save` 的 CAS 是「读盘 → 比较 revision → 写盘」三步。没有锁时，两个
 * 并发的 save 可能都读到同一个旧 revision、都通过检查、然后先后写盘——
 * 后写的把前一个覆盖掉，CAS 形同虚设。真撞到过：两张前序几乎同时结算，
 * 同一张后继被启动两次（`p1-relay` 的并发双触发用例复现）。
 *
 * 这里用一条 promise 链把本进程的写串起来：每个 save 等前一个写完再读盘。
 * 跨进程不覆盖（DSH 只有一个插件宿主进程）；真要跨进程得用锁文件。
 * 锁只包住「读-比较-写」，不包 IO 之外的业务逻辑。
 */
let saveTail = Promise.resolve()

/**
 * 写入一个批次（整份覆盖，先写临时文件再改名，避免半截文件）。
 *
 * 带乐观并发控制：盘上每次写入 `revision + 1`。调用方若传 `expectedRevision`，
 * 与盘上不符就拒绝——**宁可报错，也不要把别人刚写的状态盖掉**。
 *
 * 为什么需要：观察器在「读历史 → 写结算」之间会 await 一个流式端点，
 * 这几百毫秒里工具可能已经改过台账；没有版本号，后写的那个会把先写的
 * 悄悄抹掉——「状态怎么不更新」有一半是这么来的。
 *
 * 并发语义：本进程内的 save 串行执行，所以「检查 + 写」是原子的；
 * 并发的第二个写会看到前一个写出的新 revision，从而拿到 revision-conflict。
 *
 * @param batch - 要写的批次。
 * @param options - { expectedRevision }：要求盘上是这个版本才允许写。
 * @returns 写好的批次（已带新的 revision）。
 */
export async function save(batch, options = {}) {
  const previous = saveTail
  let release
  saveTail = new Promise((resolve) => { release = resolve })
  await previous
  try {
    return await writeBatch(batch, options)
  } finally {
    // 无论这次写成功还是抛错，都放行下一个 save；否则一次失败会把整条链卡死。
    release()
  }
}

/** 覆盖 rename 的总尝试次数（含第一次）。 */
export const RENAME_ATTEMPTS = 5

/** 每次失败后的等待（毫秒）。句柄释放通常是毫秒级，不需要指数退避到秒。 */
export const RENAME_BACKOFF_MS = [20, 50, 100, 200]

/**
 * 这个 rename 错误是不是「目标被短暂占用」，值得重试。
 *
 * Windows 上覆盖已有文件的 rename，在目标文件正被另一个句柄（索引器、杀毒、
 * 我们的另一个读者）打开时会报 EPERM / EBUSY / EACCES。它们都是瞬时的：
 * 同一请求立刻重试就成功了（I-05 现场记录）。
 *
 * @param error - rename 抛出的错误。
 * @returns 是否值得重试。
 */
export function isTransientRenameError(error) {
  const code = error?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EAGAIN'
}

/**
 * 先写临时文件、再 rename 覆盖；对瞬时错误重试。
 *
 * 为什么必须有重试：`writeBatch` 的 rename 没有重试时，一次 EPERM 就让这次
 * 写入整个失败——`/approve`、`/answer` 这类一次性动作直接 500，答复丢了、
 * 票还停在 waiting。重试 5 次覆盖掉句柄释放的毫秒级窗口，仍然失败才抛。
 *
 * 失败时清掉临时文件：留着只会让 designs/ 里堆一堆 `<id>.json.<uuid>.tmp`，
 * 而错误信息里已经带了路径，排查不需要它留在盘上。
 *
 * @param temp - 临时文件路径。
 * @param target - 目标文件路径。
 * @param options - `{ rename?, sleep? }`：测试注入用。
 * @returns 写入完成。
 */
export async function renameWithRetry(temp, target, options = {}) {
  const renameImpl = typeof options.rename === 'function' ? options.rename : rename
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  for (let attempt = 0; ; attempt++) {
    try {
      await renameImpl(temp, target)
      return
    } catch (error) {
      const retryable = isTransientRenameError(error) && attempt < RENAME_ATTEMPTS - 1
      if (!retryable) {
        await unlink(temp).catch(() => {})
        throw error
      }
      await sleep(RENAME_BACKOFF_MS[attempt] ?? 200)
    }
  }
}

/**
 * `save` 的真正写入部分；由 `save` 的进程内锁串行调用。
 * @param batch - 要写的批次。
 * @param options - { expectedRevision }。
 * @returns 写好的批次。
 */
async function writeBatch(batch, options = {}) {
  const target = pathOf(batch.id)
  let current = 0
  try {
    const raw = await readFile(target, 'utf8')
    const onDisk = JSON.parse(raw)
    if (typeof onDisk?.revision === 'number') current = onDisk.revision
  } catch {
    current = 0
  }
  const expected = options.expectedRevision
  if (expected !== undefined && expected !== current) {
    throw new MiddlemanError(
      'revision-conflict',
      '台账已被改过（期望 r' + expected + '，盘上是 r' + current + '）：重新读一次再加改动',
    )
  }
  await mkdir(dirname(target), { recursive: true })
  batch.revision = current + 1
  batch.updatedAt = Date.now()
  const temp = target + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify(batch, null, 2) + '\n', 'utf8')
  await renameWithRetry(temp, target)
  return batch
}

/**
 * 读一个批次；不存在时抛出可读错误，不返回 undefined。
 *
 * 抛的是带机器码的 MiddlemanError，不是裸 Error——路由层靠这个码把
 * 「批次不存在」映射成 404，而不是一律 500。之前这里抛的是普通 Error，
 * 于是 refusals.js 里那条 batch-missing → 404 的分支永远走不到。
 */
export async function load(id) {
  // 先取路径：id 不合法要在 readFile 之前拒绝，不能被下面的 catch 吞成
  // 「批次不存在」——那会把一次参数攻击伪装成一次普通的 404。
  const target = pathOf(id)
  let raw
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    throw new MiddlemanError('batch-missing', '没有这个设计批次：' + id)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new MiddlemanError('batch-unreadable', '这个设计批次读不出来：' + id)
  }
}

/** 列出全部批次，最新在前。坏文件跳过，不让一个读不出来的批次拖垮列表。 */
export async function list() {
  let names = []
  try {
    names = await readdir(join(home(), 'designs'))
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      rows.push(JSON.parse(await readFile(join(home(), 'designs', name), 'utf8')))
    } catch {
      // 跳过
    }
  }
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** 生成批次 id。 */
export function newBatchId() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return 'D-' + stamp + '-' + randomUUID().slice(0, 4)
}

/** 建一个空白批次。 */
export function blankBatch(title) {
  return {
    id: newBatchId(),
    title,
    createdAt: Date.now(),
    status: 'grilling',
    // 乐观并发控制的版本号：每次写入 +1，冲突时报错而不是覆盖。
    revision: 0,
    decisions: [],
    // 盘问的账本：问过用户的问题与答案。派发前至少要有 3 条已回答的。
    questions: [],
    // 流程规划：分几步、产出什么、什么能并行。派发前必须写。
    plan: undefined,
    risks: [],
    tickets: [],
    spec: undefined,
  }
}
