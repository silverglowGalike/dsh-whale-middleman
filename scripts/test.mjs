#!/usr/bin/env node
/**
 * 测试总入口：一个文件一个独立进程，逐个跑。
 *
 * 为什么不用 `node --test`：它的测试运行器用**管道**收集每个测试文件的
 * 输出，而 DSH 沙箱里带管道 stdio 的 spawn 会 EPERM（本机复现过：
 * `node --test test/*.test.mjs` → `spawn EPERM`）。用 `stdio: 'inherit'`
 * 不建管道，沙箱内外都能跑。
 *
 * 用法：
 *   node scripts/test.mjs            # 全部
 *   node scripts/test.mjs retry      # 只跑文件名含 retry 的
 *
 * @module dsh-whale-middleman/scripts/test
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const all = (await readdir(testDir)).filter((name) => name.endsWith('.test.mjs')).sort()
const selected = filters.length === 0
  ? all
  : all.filter((name) => filters.some((filter) => name.includes(filter)))

if (selected.length === 0) {
  console.error('没有匹配的测试文件：' + filters.join('、'))
  process.exit(1)
}

/**
 * 起一个子进程跑一个测试文件，等它结束。
 *
 * @param file - 文件名（test/ 下）。
 * @returns 退出码。
 */
function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(testDir, file)], {
      cwd: root,
      // inherit 而不是 pipe：沙箱禁止管道 stdio，而测试输出本来就该直接给人看。
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      console.error('[runner] 起不来 ' + file + '：' + error.message)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const failures = []
const started = Date.now()
for (const file of selected) {
  process.stdout.write('\n=== ' + file + ' ===\n')
  const code = await runFile(file)
  if (code !== 0) failures.push({ file, code })
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
process.stdout.write('\n=== 汇总 ===\n')
process.stdout.write('套件 ' + selected.length + '，通过 ' + (selected.length - failures.length)
  + '，失败 ' + failures.length + '，用时 ' + elapsed + 's\n')
for (const row of failures) {
  process.stdout.write('  ✖ ' + row.file + '（exit ' + row.code + '）\n')
}
process.exit(failures.length === 0 ? 0 : 1)
