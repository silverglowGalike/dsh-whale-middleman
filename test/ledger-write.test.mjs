/**
 * 台账写入的可靠性：rename 瞬时失败要重试，CAS 要真的挡住旧写入。
 *
 * 现场事故（I-05）：Windows 上覆盖 rename 撞到句柄占用 → EPERM → 整次写入
 * 失败，`/answer` 返回 500，答复丢了、票停在 waiting。同一请求立刻重试就
 * 成功，说明这是毫秒级窗口，不该让调用方看见。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'wt-ledger-'))
process.env.WT_HOME = HOME

const {
  save, load, blankBatch, renameWithRetry, isTransientRenameError, RENAME_ATTEMPTS,
} = await import('../lib/ledger.js')

/** 造一个带 code 的错误。 */
function fsError(code) {
  const error = new Error(code + ': injected')
  error.code = code
  return error
}

test('renameWithRetry：瞬时错误重试到成功', async () => {
  const calls = []
  const sleeps = []
  let attempts = 0
  await renameWithRetry('temp-path', 'target-path', {
    rename: async (from, to) => {
      calls.push({ from, to })
      attempts += 1
      if (attempts < 3) throw fsError('EPERM')
    },
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [20, 50])
})

test('renameWithRetry：用尽次数后抛错并清掉临时文件', async () => {
  const temp = join(HOME, 'exhausted.tmp')
  await writeFile(temp, 'x', 'utf8')
  let attempts = 0
  await assert.rejects(
    renameWithRetry(temp, join(HOME, 'exhausted.json'), {
      rename: async () => {
        attempts += 1
        throw fsError('EBUSY')
      },
      sleep: async () => {},
    }),
    (error) => error.code === 'EBUSY',
  )
  assert.equal(attempts, RENAME_ATTEMPTS)
  await assert.rejects(readFile(temp, 'utf8'), '临时文件应被清掉')
})

test('renameWithRetry：非瞬时错误不重试', async () => {
  const temp = join(HOME, 'fatal.tmp')
  await writeFile(temp, 'x', 'utf8')
  let attempts = 0
  const sleeps = []
  await assert.rejects(
    renameWithRetry(temp, join(HOME, 'fatal.json'), {
      rename: async () => {
        attempts += 1
        throw fsError('ENOSPC')
      },
      sleep: async (ms) => { sleeps.push(ms) },
    }),
    (error) => error.code === 'ENOSPC',
  )
  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
})

test('isTransientRenameError：只认 Windows 上会被释放的几种', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']) {
    assert.equal(isTransientRenameError(fsError(code)), true, code)
  }
  for (const code of ['ENOENT', 'ENOSPC', 'EIO', undefined]) {
    assert.equal(isTransientRenameError(fsError(code)), false, String(code))
  }
})

test('save：revision 递增，CAS 挡住旧写入', async () => {
  const batch = blankBatch('写台账')
  await save(batch)
  const first = await load(batch.id)
  assert.equal(first.revision, 1)

  await save({ ...first, title: '新标题' }, { expectedRevision: 1 })
  const second = await load(batch.id)
  assert.equal(second.revision, 2)
  assert.equal(second.title, '新标题')

  await assert.rejects(
    save({ ...first, title: '旧副本' }, { expectedRevision: 1 }),
    (error) => error.code === 'revision-conflict',
  )
  const third = await load(batch.id)
  assert.equal(third.title, '新标题', '被拒的写入不能落盘')
})

test('save：并发写串行执行，不丢 revision', async () => {
  const batch = blankBatch('并发')
  await save(batch)
  const rows = await Promise.all(Array.from({ length: 8 }, (_, index) => {
    return (async () => {
      const fresh = await load(batch.id)
      const copy = { ...fresh }
      copy.title = '并发-' + index
      return save(copy, { expectedRevision: fresh.revision }).then(() => 'ok', (error) => error.code)
    })()
  }))
  const conflicts = rows.filter((row) => row === 'revision-conflict').length
  const written = await load(batch.id)
  assert.equal(written.revision, 1 + (rows.length - conflicts))
  const leftovers = (await readdir(HOME)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '成功后不该留临时文件')
})
