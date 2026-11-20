#!/usr/bin/env node
/**
 * 发布前自检：几条「两份实现会各自漂」的不变式。
 *
 * 这些不跑宿主、不建会话，纯静态检查，几毫秒。`npm run check` 与
 * `scripts/test.mjs` 互补：测试盯行为，这里盯结构性一致性。
 *
 * 检查项：
 * 1. `lib/client.js` 内联的卡片判断层与 `lib/card-model.js` 逐字一致；
 * 2. `locale/*.json` 有 `meta.title` / `meta.description`（详情页与插件行要读）；
 * 3. `package.json` 的 scripts / exports / files 覆盖了实际交付的文件；
 * 4. `lib/` 里没有裸 `save(batch)`——不带 CAS 的整批回写会静默盖掉别人的写入。
 *
 * @module dsh-whale-middleman/scripts/check
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInlineBlock, findInlineBlock, CLIENT_PATH } from './inline-card-model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/** 读 JSON，失败记一条问题。 */
async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    problems.push(label + ' 读不出来：' + error.message)
    return undefined
  }
}

// 1. 内联块同步
let inline
let expected
try {
  const client = await readFile(CLIENT_PATH, 'utf8')
  inline = findInlineBlock(client)
  expected = await buildInlineBlock()
} catch (error) {
  problems.push('读 lib/client.js / 生成内联块失败：' + error.message)
}
if (inline !== undefined && expected !== undefined) {
  if (inline.text !== expected) {
    problems.push('lib/client.js 的内联卡片判断层与 lib/card-model.js 不一致：'
      + '跑 node scripts/inline-card-model.mjs --write')
  } else {
    notes.push('内联卡片判断层与 card-model.js 一致')
  }
}

// 2. locale 元数据
const locales = ['en', 'zh']
for (const lang of locales) {
  const meta = await readJson(join(root, 'locale', lang + '.json'), 'locale/' + lang + '.json')
  if (meta === undefined) continue
  for (const field of ['title', 'description']) {
    const value = meta?.meta?.[field]
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push('locale/' + lang + '.json 缺 meta.' + field)
    }
  }
  if (typeof meta?.meta?.detail === 'string') {
    const detail = meta.meta.detail
    if (!detail.endsWith('.md') && !detail.endsWith('.markdown')) {
      problems.push('locale/' + lang + '.json 的 meta.detail 不是 .md 路径：' + detail)
    } else {
      try {
        await readFile(join(root, detail), 'utf8')
      } catch {
        problems.push('locale/' + lang + '.json 指向的详情文档不存在：' + detail)
      }
    }
  }
}

// 3. package.json 接线
const pkg = await readJson(join(root, 'package.json'), 'package.json')
if (pkg !== undefined) {
  if (pkg.scripts?.test !== 'node scripts/test.mjs') {
    problems.push('package.json 的 scripts.test 应指向 node scripts/test.mjs（node --test 在沙箱里会 EPERM）')
  }
  if (pkg.scripts?.check !== 'node scripts/check.mjs') {
    problems.push('package.json 的 scripts.check 应指向 node scripts/check.mjs')
  }
  if (pkg.exports?.['./locale/*.json'] !== './locale/*.json') {
    problems.push('package.json 的 exports 缺 "./locale/*.json"：宿主读不到插件标题/描述')
  }
  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const required of ['lib', 'locale/*.json', 'docs', 'scripts', 'test', 'cordis.patch.yml', 'README.md', 'USAGE.md', 'LICENSE', 'icon.svg']) {
    if (!files.includes(required)) problems.push('package.json 的 files 缺 ' + required)
  }
}

// 4. 没有裸 save：整批回写必须带 CAS（或由 ledger 的写锁保证对象是新读的）
//
// 扫全部 lib/*.js，而不是几个固定文件：新增模块同样可能写出裸 save。
// 匹配 `save(x)`（不论带不带 await——忘记 await 比裸覆盖更难查）但放过
// `save(x, { expectedRevision })` 这种显式 CAS。注释行跳过，避免误报。
const libNames = (await readdir(join(root, 'lib'))).filter((name) => name.endsWith('.js'))
const BARE_SAVE = /(?<![\w$.])save\(\s*[A-Za-z_$][\w$]*\s*\)/
for (const name of libNames) {
  const source = await readFile(join(root, 'lib', name), 'utf8')
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    if (BARE_SAVE.test(trimmed)) {
      problems.push('lib/' + name + ':' + (index + 1) + ' 是裸 save(...)：走 patchBatch / patchTicket，别整批覆盖')
    }
  }
}

if (problems.length === 0) {
  for (const note of notes) process.stdout.write('✓ ' + note + '\n')
  process.stdout.write('自检通过（' + notes.length + ' 项 + 无裸 save）。\n')
  process.exit(0)
}
for (const problem of problems) process.stdout.write('✖ ' + problem + '\n')
process.stdout.write('自检失败：' + problems.length + ' 条。\n')
process.exit(1)
