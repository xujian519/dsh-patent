import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  SILICONFLOW_PROVIDER_ID,
  SILICONFLOW_VIDEO_MODEL,
  SiliconFlowMediaProvider,
  resolveSiliconFlow,
  type MediaTask,
} from '@deepseek-ai/dsh-video-mode'

/**
 * Real-API smoke for the SiliconFlow Wan2.2 image-to-video provider. Self-skips
 * without `$SILICONFLOW_API_KEY`. One case generates a five-second clip and
 * bills 2.00 CNY on the mainland site, so the suite stays at one request and
 * disables the repository-wide provider retry: a retried generation pays twice.
 */
const apiKey = process.env.SILICONFLOW_API_KEY?.trim()
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

const POLL_MS = 5_000
const SETTLE_DEADLINE_MS = 20 * 60_000

/**
 * Build settings that mirror the shipped preset.
 * @returns complete provider settings.
 */
function settings() {
  return resolveSiliconFlow({
    enabled: true,
    apiKey: apiKey ?? '',
    baseUrl: process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
    pollMs: POLL_MS,
    model: SILICONFLOW_VIDEO_MODEL,
    aspectRatio: '9:16',
    pricePerVideo: 2,
    currency: 'CNY',
  }, 512 * 1024 * 1024)
}

/**
 * Poll one provider task until it settles.
 * @param provider - provider that owns the task.
 * @param task - submitted task.
 * @returns the settled task.
 */
async function settle(provider: SiliconFlowMediaProvider, task: MediaTask): Promise<MediaTask> {
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
 * Recognize an MP4 container signature near the start of the file.
 * @param bytes - downloaded video bytes.
 * @returns whether the first 64 bytes carry an `ftyp` brand.
 */
function isMp4(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes.slice(0, 64)).includes('ftyp')
}

/**
 * Finish one PNG chunk.
 * @param type - four-character chunk type.
 * @param data - chunk payload.
 * @returns the length-prefixed, CRC-suffixed chunk.
 */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Encode a patterned RGB PNG. SiliconFlow rejects a blank or solid first
 * frame as an invalid task, so the smoke needs visible structure.
 * @param width - image width.
 * @param height - image height.
 * @returns the complete PNG bytes.
 */
function gradientPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = 1 + width * 3
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row++) {
    const start = row * stride
    for (let column = 0; column < width; column++) {
      const offset = start + 1 + column * 3
      raw[offset] = Math.round((column * 255) / (width - 1))
      raw[offset + 1] = Math.round((row * 255) / (height - 1))
      raw[offset + 2] = Math.round(((column + row) * 255) / (width + height - 2))
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

maybe('SiliconFlowMediaProvider real API', () => {
  it('renders a five-second clip from a first-frame image', { retry: 0, timeout: 1_500_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-siliconflow-video-'))
    const firstFramePath = join(directory, 'frame.png')
    await writeFile(firstFramePath, gradientPng(720, 1280))
    const provider = new SiliconFlowMediaProvider(settings())

    try {
      const estimate = provider.estimate({ kind: 'video', prompt: 'x', aspectRatio: '9:16' })
      expect(estimate.cost).toEqual({ amountMinor: 200, currency: 'CNY' })
      expect(estimate.durationSec).toBe(5)

      const submitted = await provider.submit({
        kind: 'video',
        prompt: 'The camera slowly pushes toward the blue surface while soft light shifts.',
        aspectRatio: '9:16',
        references: [{ kind: 'image', role: 'first-frame', path: firstFramePath }],
      }, new AbortController().signal)
      expect(submitted.status).toBe('submitted')
      expect(submitted.provider).toBe(SILICONFLOW_PROVIDER_ID)
      expect(submitted.model).toBe(SILICONFLOW_VIDEO_MODEL)

      const settled = await settle(provider, submitted)
      expect(settled.status, settled.error?.message).toBe('succeeded')
      expect(settled.progress).toBe(1)

      const artifact = settled.artifacts?.[0]
      if (artifact?.bytes === undefined) throw new Error('SiliconFlow returned no inline video')
      expect(artifact.mediaType).toBe('video/mp4')
      expect(isMp4(artifact.bytes)).toBe(true)
      expect(artifact.bytes.length).toBeGreaterThan(10_000)
      expect(artifact.durationSec).toBe(5)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
