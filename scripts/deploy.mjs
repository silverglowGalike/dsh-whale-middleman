#!/usr/bin/env node
/**
 * 部署：把开发副本整目录同步到两份线上副本，并做一致性校验。
 *
 * 为什么必须有这一步：profile 用 `file:` 复制装载，改源码**不会**自动生效；
 * 只改一份还会出现「安装源是新的、实际加载的是旧的」那种最难查的状态。
 *
 * 用法（在源码目录里跑）：
 *   node scripts/deploy.mjs              # 同步并校验
 *   node scripts/deploy.mjs --dry-run    # 只看会动哪些文件
 *
 * 目标位置可以用环境变量覆盖（默认是这台机器的布局）：
 *   WT_DEPLOY_INSTALL  ~/.dsh/plugins/dsh-whale-middleman
 *   WT_DEPLOY_PROFILE  ~/.dsh/profiles/desktop/node_modules/dsh-whale-middleman
 *
 * 同步完必须**完全退出 DSH 再启动**（关窗口不算），否则浏览器与宿主都还是
 * 旧模块。部署脚本不做重启：那是用户的动作。
 *
 * @module dsh-whale-middleman/scripts/deploy
 */
import { cp, readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

/** 要同步的路径（相对包根）。`docs` / `locale` 是详情页与元数据要读的。 */
const ENTRIES = ['lib', 'locale', 'docs', 'scripts', 'test', 'package.json', 'cordis.patch.yml', 'README.md', 'USAGE.md', 'LICENSE', 'icon.svg']

const home = homedir()
const targets = [
  ['安装源', process.env.WT_DEPLOY_INSTALL ?? join(home, '.dsh', 'plugins', 'dsh-whale-middleman')],
  ['profile 副本', process.env.WT_DEPLOY_PROFILE
    ?? join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-whale-middleman')],
]

/** 文件 sha256，用来确认两份副本真的和源码一致。 */
async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** 递归列出相对路径（目录 → 里面的文件）。 */
async function listFiles(root, entry) {
  const full = join(root, entry)
  let info
  try {
    info = await stat(full)
  } catch {
    return []
  }
  if (info.isFile()) return [entry]
  const names = await readdir(full)
  const rows = []
  for (const name of names) {
    rows.push(...await listFiles(root, join(entry, name)))
  }
  return rows
}

const files = []
for (const entry of ENTRIES) files.push(...await listFiles(source, entry))
if (files.length === 0) {
  console.error('源码目录里一个要同步的文件都没找到：' + source)
  process.exit(1)
}

console.log('源码：' + source)
console.log('文件：' + files.length + ' 个' + (dryRun ? '（dry-run，只列不改）' : ''))

let failed = false
for (const [label, target] of targets) {
  let exists = false
  try {
    exists = (await stat(join(target, 'lib'))).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    console.error('✖ ' + label + ' 目标不像已安装的插件（找不到 lib/）：' + target)
    failed = true
    continue
  }
  console.log('\n→ ' + label + '：' + target)
  for (const entry of ENTRIES) {
    if (dryRun) {
      console.log('  would copy ' + entry)
      continue
    }
    await cp(join(source, entry), join(target, entry), { recursive: true, force: true })
  }
  if (dryRun) continue
  const mismatched = []
  for (const entry of files) {
    if (await digest(join(source, entry)) !== await digest(join(target, entry))) {
      mismatched.push(relative(source, join(source, entry)))
    }
  }
  if (mismatched.length > 0) {
    console.error('  ✖ 校验不一致：' + mismatched.join('、'))
    failed = true
  } else {
    console.log('  ✓ ' + files.length + ' 个文件 sha256 一致')
  }
  // 反向检查：目标里多出来的文件不会被 cp 删掉（也不会被上面的正向校验看见）。
  // 源码里删过/改过名的模块会在这里露出来，否则「线上比源码多一个旧文件」
  // 只能等它被 import 时才炸。
  const expectedSet = new Set(files)
  const extras = []
  for (const entry of ENTRIES) {
    for (const name of await listFiles(target, entry)) {
      if (!expectedSet.has(name)) extras.push(name)
    }
  }
  if (extras.length > 0) {
    console.error('  ! 目标里有多余文件（不会自动删除，请手动确认）：' + extras.join('、'))
    failed = true
  }
}

if (failed) process.exit(1)
if (dryRun) {
  console.log('\n没有改动任何文件。去掉 --dry-run 才会同步。')
} else {
  console.log('\n同步完成。**完全退出 DSH 再启动**（关窗口不算），然后刷新页面。')
  console.log('核对：middleman_status 可用、list_bundles 显示新版本、面板能展开批次。')
}
