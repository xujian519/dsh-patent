/** Host configuration supplies the studio's inline-preview cap to browser pages. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/config.ts'
import * as host from '../src/index.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('exposes the inline HTML cap on the Host entry', () => {
  expect(host.Config).toBe(Config)
  expect(Config({})).toEqual({ htmlPreviewMaxBytes: 8 * 1024 * 1024 })
  expect(Config({ htmlPreviewMaxBytes: 2048 })).toEqual({ htmlPreviewMaxBytes: 2048 })
  expect(() => Config({ htmlPreviewMaxBytes: 0 })).toThrow()
})

it('embeds the cap in browser pages and withdraws it on disposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ htmlPreviewMaxBytes: 1024 })
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, PAGE_PEER)
  expect(rows).toEqual([{ kind: 'global', name: '__DSH_DOCUMENT_STUDIO_CONFIG__', value: config }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, PAGE_PEER)
  expect(after).toEqual([])
})
