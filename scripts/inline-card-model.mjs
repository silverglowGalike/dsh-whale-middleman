#!/usr/bin/env node
/**
 * 把 `lib/card-model.js` 内联进 `lib/client.js` 的浏览器半区。
 *
 * 为什么需要：浏览器侧拿不到 ESM 的 `import`（插件按 DSH 客户端模块协议
 * 注册，只有一个 factory 闭包），但卡片判断层必须与单测同源。两份各写一份
 * 必然漂，所以只允许一份源码——`lib/card-model.js`——由这个脚本生成副本。
 *
 * 用法：
 *   node scripts/inline-card-model.mjs           # 只检查是否同步（不同步退出 1）
 *   node scripts/inline-card-model.mjs --write   # 重写 client.js 里那段
 *
 * @module dsh-whale-middleman/scripts/inline-card-model
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CARD_MODEL_PATH = join(root, 'lib', 'card-model.js')
export const CLIENT_PATH = join(root, 'lib', 'client.js')

/** 内联块在 client.js 里的固定外壳（前后各一行）。 */
const OPEN = '    const cardModel = (() => {\n'
const CLOSE = '\n    })()'

/**
 * 按当前 `card-model.js` 生成应然的内联块。
 *
 * 只做一件事：去掉顶层 `export `（浏览器半区是闭包，不需要导出），
 * 其余逐字保留——包括注释，注释也是给人看的文档。
 *
 * @returns 内联块的完整文本（含首尾外壳）。
 */
export async function buildInlineBlock() {
  const source = (await readFile(CARD_MODEL_PATH, 'utf8')).replace(/\r\n/g, '\n')
  const trimmed = source.replace(/\n+$/, '')
  const exported = [...trimmed.matchAll(
    /^export\s+(?:async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,
  )].map((match) => match[1])
  if (exported.length === 0) {
    throw new Error('card-model.js 里一个导出都没找到：脚本可能读错了文件')
  }
  const stripped = trimmed.replace(/^export /gm, '')
  const returnLine = '      return { ' + exported.join(', ') + ' }'
  return OPEN + stripped + '\n' + returnLine + CLOSE
}

/**
 * 找出 client.js 里当前的内联块。
 *
 * 用锚点定位而不是行号：文件其它部分改动不该影响这里。
 *
 * @param client - client.js 全文。
 * @returns `{ start, end, text }`；找不到时抛错。
 */
export function findInlineBlock(client) {
  const start = client.indexOf(OPEN)
  if (start < 0) throw new Error('client.js 里找不到内联块起点：const cardModel = (() => {')
  const closeAt = client.indexOf('\n      return { ', start)
  if (closeAt < 0) throw new Error('client.js 里找不到内联块的 return 行')
  const end = client.indexOf(CLOSE, closeAt)
  if (end < 0) throw new Error('client.js 里找不到内联块结尾：})()')
  return { start, end: end + CLOSE.length, text: client.slice(start, end + CLOSE.length) }
}

/** 直接运行时的入口。 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write')
  const client = await readFile(CLIENT_PATH, 'utf8')
  const current = findInlineBlock(client)
  const expected = await buildInlineBlock()
  if (current.text === expected) {
    process.stdout.write('内联块与 lib/card-model.js 一致。\n')
  } else if (write) {
    await writeFile(CLIENT_PATH, client.slice(0, current.start) + expected + client.slice(current.end), 'utf8')
    process.stdout.write('已重写 client.js 的内联块（' + (expected.length - current.text.length)
      + ' 字节差异）。\n')
  } else {
    process.stdout.write('内联块与 lib/card-model.js 不一致：跑 node scripts/inline-card-model.mjs --write\n')
    process.exit(1)
  }
}
