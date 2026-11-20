/**
 * 浏览器半区与判断层必须同源。
 *
 * 现场教训：`lib/client.js` 内联的那份卡片判断层，`return { ... }` 里少列了
 * 一个 `modelLabel`——两份各写一份就是会漂，而注释里写着「由
 * test/client-bundle.test.mjs 守住」，那个文件根本不存在。这条测试补上，
 * 顺便把「谁来生成这份副本」钉在 scripts/inline-card-model.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildInlineBlock, findInlineBlock, CLIENT_PATH, CARD_MODEL_PATH } from '../scripts/inline-card-model.mjs'

test('client.js 内联的判断层与 card-model.js 逐字一致', async () => {
  const client = await readFile(CLIENT_PATH, 'utf8')
  const current = findInlineBlock(client)
  const expected = await buildInlineBlock()
  assert.equal(current.text, expected,
    '内联块漂了：跑 node scripts/inline-card-model.mjs --write 重新生成，别手改')
})

test('内联块里没有残留的 export 关键字', async () => {
  const client = await readFile(CLIENT_PATH, 'utf8')
  const block = findInlineBlock(client).text
  assert.equal(/^export /m.test(block), false, '浏览器半区是闭包，不能出现 export')
})

test('card-model.js 的每个导出都出现在内联块的 return 里', async () => {
  const source = await readFile(CARD_MODEL_PATH, 'utf8')
  const exported = [...source.matchAll(/^export\s+(?:async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1])
  const client = await readFile(CLIENT_PATH, 'utf8')
  const block = findInlineBlock(client).text
  const returnLine = block.split('\n').reverse().find((line) => line.trim().startsWith('return {'))
  for (const name of exported) {
    assert.ok(returnLine.includes(name), '内联块的 return 少了 ' + name)
  }
})
