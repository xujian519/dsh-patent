/**
 * Append one charge through the built video-mode package. The first guarded
 * write waits at an IPC barrier after the ledger read, so the parent can make
 * two operating-system processes publish from the same observed version.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { appendLedgerEntry } from '../../lib/index.js'

const [root, projectPath, ledgerDir, taskId] = process.argv.slice(2)
const send = process.send?.bind(process)
if (send === undefined) throw new Error('ledger writer requires a Node IPC channel')

const ctx = new Context()
try {
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  const writeText = ctx.fs.writeText.bind(ctx.fs)
  let firstWrite = true
  ctx.fs.writeText = async (...args) => {
    if (firstWrite) {
      firstWrite = false
      const released = new Promise(resolve => process.once('message', resolve))
      await new Promise((resolve, reject) => {
        send('before-write', error => { if (error === null) resolve(); else reject(error) })
      })
      if (await released !== 'release') throw new Error('ledger writer received an unexpected barrier message')
    }
    return writeText(...args)
  }
  const appended = await appendLedgerEntry(ctx, projectPath, {
    taskId,
    kind: 'video',
    model: 'MiniMax-H3',
    costCny: 2,
    at: '2026-10-31T00:00:00.000Z',
  }, ledgerDir, root)
  process.stdout.write(`${JSON.stringify({ appended })}\n`)
} finally {
  await ctx.fiber.dispose()
}
