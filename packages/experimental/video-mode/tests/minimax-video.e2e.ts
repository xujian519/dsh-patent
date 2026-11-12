import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  MINIMAX_PROVIDER_ID,
  MINIMAX_VIDEO_MODEL,
  MiniMaxMediaProvider,
  resolveMiniMax,
  solidPng,
  type MediaTask,
} from '@deepseek-ai/dsh-video-mode'

/**
 * Real-API smoke for the MiniMax-H3 video provider. Self-skips without
 * `$MINIMAX_API_KEY`. Each case generates a four-second clip and bills the
 * account 2.00 CNY, so the suite stays at two requests and disables the
 * repository-wide provider retry: a retried generation pays twice.
 */
const apiKey = process.env.MINIMAX_API_KEY?.trim()
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

/** Four seconds at 768P, the cheapest H3 request shape. */
const DURATION_SEC = 4
const POLL_MS = 3_000
const SETTLE_DEADLINE_MS = 15 * 60_000

/**
 * Build settings that mirror the shipped preset.
 * @param overrides - fields a case replaces.
 * @returns complete provider settings.
 */
function settings(overrides: { readonly apiKey?: string } = {}) {
  return resolveMiniMax({
    enabled: true,
    apiKey: overrides.apiKey ?? apiKey ?? '',
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.cn',
    pollMs: POLL_MS,
    resolution: '768P',
    defaultDurationSec: DURATION_SEC,
    maxDurationSec: 15,
    aspectRatio: '9:16',
  }, 512 * 1024 * 1024)
}

/**
 * Poll one provider task until it settles.
 * @param provider - provider that owns the task.
 * @param task - submitted task.
 * @returns the settled task.
 */
async function settle(provider: MiniMaxMediaProvider, task: MediaTask): Promise<MediaTask> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  let current = task
  while (current.status !== 'succeeded' && current.status !== 'failed' && current.status !== 'cancelled') {
    if (Date.now() > deadline) throw new Error(`task ${task.id} did not settle within ${SETTLE_DEADLINE_MS} ms`)
    await delay(POLL_MS)
    current = await provider.poll(current, new AbortController().signal)
  }
  return current
}

/**
 * Recognize an MP4 container signature anywhere near the start of the file.
 * @param bytes - downloaded video bytes.
 * @returns whether the first 64 bytes carry an `ftyp` brand.
 */
function isMp4(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes.slice(0, 64)).includes('ftyp')
}

maybe('MiniMaxMediaProvider real API', () => {
  it('renders a text-to-video clip and settles within the published price', { retry: 0, timeout: 900_000 }, async () => {
    const provider = new MiniMaxMediaProvider(settings())
    const request = {
      kind: 'video' as const,
      prompt: 'A paper lantern drifts over a calm river at dusk, warm light, slow camera push-in.',
      durationSec: DURATION_SEC,
      resolution: '768P',
      aspectRatio: '9:16',
    }

    const estimate = provider.estimate(request)
    expect(estimate.cost).toEqual({ amountMinor: 200, currency: 'CNY' })
    expect(estimate.durationSec).toBe(DURATION_SEC)

    const submitted = await provider.submit(request, new AbortController().signal)
    expect(submitted.status).toBe('submitted')
    expect(submitted.provider).toBe(MINIMAX_PROVIDER_ID)
    expect(submitted.model).toBe(MINIMAX_VIDEO_MODEL)

    const settled = await settle(provider, submitted)
    expect(settled.status, settled.error?.message).toBe('succeeded')
    expect(settled.progress).toBe(1)

    const artifact = settled.artifacts?.[0]
    if (artifact?.bytes === undefined) throw new Error('MiniMax returned no inline video')
    expect(artifact.mediaType).toBe('video/mp4')
    expect(isMp4(artifact.bytes)).toBe(true)
    expect(artifact.bytes.length).toBeGreaterThan(10_000)
    expect(artifact.durationSec).toBe(DURATION_SEC)
  })

  it('starts a clip from a first-frame image', { retry: 0, timeout: 900_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-minimax-video-'))
    const firstFramePath = join(directory, 'frame.png')
    await writeFile(firstFramePath, solidPng(512, 512, 38, 86, 140))
    const provider = new MiniMaxMediaProvider(settings())

    try {
      const submitted = await provider.submit({
        kind: 'video',
        prompt: 'The camera slowly pushes toward the blue surface while soft light shifts.',
        durationSec: DURATION_SEC,
        resolution: '768P',
        references: [{ kind: 'image', path: firstFramePath }],
      }, new AbortController().signal)

      const settled = await settle(provider, submitted)
      expect(settled.status, settled.error?.message).toBe('succeeded')
      const artifact = settled.artifacts?.[0]
      if (artifact?.bytes === undefined) throw new Error('MiniMax returned no inline video')
      expect(isMp4(artifact.bytes)).toBe(true)
      expect(artifact.bytes.length).toBeGreaterThan(10_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
