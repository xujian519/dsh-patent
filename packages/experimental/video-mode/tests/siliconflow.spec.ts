/**
 * Tests of the SiliconFlow Wan2.2-I2V-A14B provider: request construction,
 * first-frame data URIs, per-video pricing, status settlement, download,
 * cancellation, timeout, resume, and configuration registration.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VideoMode, {
  SILICONFLOW_DURATION_SEC,
  SILICONFLOW_PROVIDER_ID,
  SILICONFLOW_VIDEO_MODEL,
  SiliconFlowMediaProvider,
  resolveMediaConfig,
  resolveSiliconFlow,
  solidPng,
  type MediaTask,
  type MediaTaskRecord,
  type SiliconFlowConfig,
} from '../src/index.ts'

/** One recorded provider request. */
interface Call {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly authorization: string | undefined
}

/** Minimal fetch surface the provider accepts. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** A 16-byte MP4-shaped payload; the provider does not validate signatures. */
const MP4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])

/** JSON response helper. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** Build a fetch stub that records calls and delegates to a router. */
function recorder(route: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers.get('authorization') ?? undefined,
    }
    calls.push(call)
    return route(call)
  }
  return { calls, fetchImpl }
}

/** Settings with short poll intervals and a test key. */
function settingsOf(overrides: SiliconFlowConfig = {}) {
  return resolveSiliconFlow({ enabled: true, apiKey: 'sk-test', pollMs: 1, ...overrides }, 64 * 1024 * 1024)
}

/**
 * Write one tiny PNG and return its path and directory.
 * @returns the image path and a cleanup callback.
 */
async function temporaryFrame(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siliconflow-'))
  const path = join(directory, 'start.png')
  await writeFile(path, solidPng(4, 4, 255, 128, 0))
  return { directory, path }
}

/**
 * Submit one video request through the provider.
 * @param provider - provider under test.
 * @param options - request overrides.
 * @returns the submitted task.
 */
async function submitVideo(
  provider: SiliconFlowMediaProvider,
  options: {
    readonly prompt?: string
    readonly durationSec?: number
    readonly aspectRatio?: string
    readonly firstFramePath?: string
    readonly role?: 'style' | 'character' | 'first-frame' | 'last-frame'
    readonly negativePrompt?: string
    readonly seed?: number
  } = {},
): Promise<MediaTask> {
  return provider.submit({
    kind: 'video',
    prompt: options.prompt ?? 'a lantern drifts over a river',
    ...options.durationSec === undefined ? {} : { durationSec: options.durationSec },
    ...options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio },
    ...options.negativePrompt === undefined ? {} : { negativePrompt: options.negativePrompt },
    ...options.seed === undefined ? {} : { seed: options.seed },
    ...options.firstFramePath === undefined
      ? {}
      : {
        references: [{
          kind: 'image',
          path: options.firstFramePath,
          ...options.role === undefined ? {} : { role: options.role },
        }],
      },
  }, new AbortController().signal)
}

describe('siliconflow configuration', () => {
  it('falls back to an empty key and the default poll interval when omitted', () => {
    const settings = resolveSiliconFlow({ enabled: true }, 4)

    expect(settings.apiKey).toBe('')
    expect(settings.pollMs).toBe(10_000)
  })

  it('applies the mainland defaults', () => {
    const settings = settingsOf()
    expect(settings.baseUrl).toBe('https://api.siliconflow.cn/v1')
    expect(settings.model).toBe(SILICONFLOW_VIDEO_MODEL)
    expect(settings.aspectRatio).toBe('9:16')
    expect(settings.priceMinor).toBe(200)
    expect(settings.currency).toBe('CNY')
    expect(settings.pollMs).toBe(1)
  })

  it('keeps an empty key as unavailable configuration and rejects invalid bounds', () => {
    const unavailable = new SiliconFlowMediaProvider(settingsOf({ apiKey: ' ' }))
    expect(unavailable.available()).toBe(false)
    expect(unavailable.unavailableReason()).toContain('SILICONFLOW_API_KEY')
    const available = new SiliconFlowMediaProvider(settingsOf())
    expect(available.available()).toBe(true)
    expect(available.unavailableReason()).toBeUndefined()
    expect(() => settingsOf({ model: 'Wan-AI/Wan2.2-T2V-A14B' })).toThrow(/Wan-AI\/Wan2.2-I2V-A14B/)
    expect(() => settingsOf({ aspectRatio: '2:1' })).toThrow(/aspectRatio/)
    expect(() => settingsOf({ pollMs: 0 })).toThrow(/pollMs/)
    expect(() => settingsOf({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => settingsOf({ pricePerVideo: -0.01 })).toThrow(/pricePerVideo/)
    expect(() => settingsOf({ pricePerVideo: Number.NaN })).toThrow(/pricePerVideo/)
    expect(() => settingsOf({ baseUrl: ' ' })).toThrow(/baseUrl/)
  })

  it('resolves the provider only when enabled', () => {
    expect(resolveMediaConfig({ fakeProvider: false }).siliconflow).toBeUndefined()
    expect(resolveMediaConfig({
      fakeProvider: false,
      siliconflow: { enabled: true, apiKey: 'k', pricePerVideo: 0.29, currency: 'USD' },
    }).siliconflow).toMatchObject({ model: SILICONFLOW_VIDEO_MODEL, priceMinor: 29, currency: 'USD' })
    expect(resolveMediaConfig({
      fakeProvider: false,
      siliconflow: { enabled: true },
    }).siliconflow).toMatchObject({ apiKey: '', priceMinor: 200, currency: 'CNY' })
  })

  it('registers the cloud model when enabled', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, {
      fakeProvider: false,
      videoModel: SILICONFLOW_VIDEO_MODEL,
      siliconflow: { enabled: true, apiKey: 'sk-test' },
    }).await()
    expect(ctx.media.models('video').map(model => model.id)).toEqual([SILICONFLOW_VIDEO_MODEL])
    expect(ctx.media.models('video')[0]?.provider).toBe(SILICONFLOW_PROVIDER_ID)
    expect(ctx.media.models('video')[0]?.price).toEqual({ amountMinor: 200, currency: 'CNY', unit: 'video' })
    expect(ctx.media.estimate({ kind: 'video', prompt: 'x' }).cost)
      .toEqual({ amountMinor: 200, currency: 'CNY' })
    await ctx.fiber.dispose()
  })

  it('resolves an environment credential through the runtime registration', async () => {
    const frame = await temporaryFrame()
    const calls: { url: string; authorization: string | undefined }[] = []
    const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      calls.push({ url, authorization: headers.get('authorization') ?? undefined })
      return json({ requestId: 'req-env' })
    }
    process.env.SILICONFLOW_TEST_KEY = 'env-key'
    vi.stubGlobal('fetch', fetchStub)
    const ctx = new Context()
    try {
      await ctx.plugin(VideoMode, {
        fakeProvider: false,
        videoModel: SILICONFLOW_VIDEO_MODEL,
        siliconflow: {
          enabled: true,
          apiKeyEnv: 'SILICONFLOW_TEST_KEY',
          baseUrl: 'https://api.test/v1',
          pollMs: 1,
        },
      }).await()
      const task = await ctx.media.submit({
        kind: 'video',
        prompt: 'x',
        references: [{ kind: 'image', path: frame.path }],
      }, new AbortController().signal)
      expect(task.id).toBe('siliconflow-req-env')
      expect(calls[0]?.url).toBe('https://api.test/v1/video/submit')
      expect(calls[0]?.authorization).toBe('Bearer env-key')
    } finally {
      delete process.env.SILICONFLOW_TEST_KEY
      vi.unstubAllGlobals()
      await ctx.fiber.dispose()
      await rm(frame.directory, { recursive: true, force: true })
    }
  })
})

describe('siliconflow provider', () => {
  it('submits an image-to-video request with price, size, and prompt fields', async () => {
    const frame = await temporaryFrame()
    try {
      const { calls, fetchImpl } = recorder(() => json({ requestId: 'req-1' }))
      const provider = new SiliconFlowMediaProvider(settingsOf(), fetchImpl)
      const task = await submitVideo(provider, {
        firstFramePath: frame.path,
        aspectRatio: '16:9',
        negativePrompt: 'blurry',
        seed: 7,
      })

      expect(task).toMatchObject({
        id: 'siliconflow-req-1',
        provider: 'siliconflow',
        model: SILICONFLOW_VIDEO_MODEL,
        kind: 'video',
        status: 'submitted',
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('https://api.siliconflow.cn/v1/video/submit')
      expect(calls[0]?.method).toBe('POST')
      expect(calls[0]?.authorization).toBe('Bearer sk-test')
      const body = JSON.parse(calls[0]?.body ?? '{}') as {
        model?: string
        prompt?: string
        negative_prompt?: string
        image_size?: string
        image?: string
        seed?: number
      }
      expect(body.model).toBe(SILICONFLOW_VIDEO_MODEL)
      expect(body.prompt).toBe('a lantern drifts over a river')
      expect(body.negative_prompt).toBe('blurry')
      expect(body.image_size).toBe('1280x720')
      expect(body.image).toMatch(/^data:image\/png;base64,/)
      expect(body.seed).toBe(7)

      expect(provider.estimate({ kind: 'video', prompt: 'x' }))
        .toEqual({ cost: { amountMinor: 200, currency: 'CNY' }, durationSec: 5, confidence: 'exact' })
      expect(provider.estimate({ kind: 'image', prompt: 'x' })).toEqual({ confidence: 'unknown' })
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('maps 1:1 and the default 9:16 to their image sizes', async () => {
    const frame = await temporaryFrame()
    try {
      for (const [ratio, size] of [['1:1', '960x960'], [undefined, '720x1280']] as const) {
        const { calls, fetchImpl } = recorder(() => json({ requestId: 'req-1' }))
        const provider = new SiliconFlowMediaProvider(settingsOf(), fetchImpl)
        await submitVideo(provider, { firstFramePath: frame.path, ...ratio === undefined ? {} : { aspectRatio: ratio } })
        const body = JSON.parse(calls[0]?.body ?? '{}') as { image_size?: string }
        expect(body.image_size).toBe(size)
      }
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('requires exactly one first-frame image', async () => {
    const frame = await temporaryFrame()
    try {
      const provider = new SiliconFlowMediaProvider(settingsOf(), recorder(() => json({ requestId: 'r' })).fetchImpl)
      await expect(submitVideo(provider)).rejects.toThrow(/exactly one first-frame image/)
      await expect(provider.submit({
        kind: 'video',
        prompt: 'x',
        references: [
          { kind: 'image', path: frame.path },
          { kind: 'image', path: frame.path },
        ],
      }, new AbortController().signal)).rejects.toThrow(/exactly one first-frame image/)
      await expect(provider.submit({
        kind: 'video',
        prompt: 'x',
        references: [{ kind: 'video', path: frame.path }],
      }, new AbortController().signal)).rejects.toThrow(/must be images/)
      await expect(submitVideo(provider, { firstFramePath: frame.path, role: 'style' }))
        .rejects.toThrow(/first-frame image, not a style reference/)
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('rejects a duration the model cannot produce', async () => {
    const provider = new SiliconFlowMediaProvider(settingsOf(), recorder(() => json({ requestId: 'r' })).fetchImpl)
    await expect(submitVideo(provider, { durationSec: 4 })).rejects.toThrow(/fixed 5-second clip/)
    await expect(submitVideo(provider, { durationSec: 6 })).rejects.toThrow(/fixed 5-second clip/)
  })

  it('rejects non-video requests, unknown models, and overlong prompts', async () => {
    const frame = await temporaryFrame()
    try {
      const provider = new SiliconFlowMediaProvider(settingsOf(), recorder(() => json({ requestId: 'r' })).fetchImpl)
      await expect(provider.submit({ kind: 'image', prompt: 'x' }, new AbortController().signal))
        .rejects.toThrow(/serves video only/)
      await expect(provider.submit({ kind: 'video', prompt: 'x', model: 'other' }, new AbortController().signal))
        .rejects.toThrow(/serves no video model/)
      await expect(submitVideo(provider, { prompt: 'x'.repeat(7001), firstFramePath: frame.path }))
        .rejects.toThrow(/at most 7000 characters/)
      await expect(submitVideo(provider, { firstFramePath: frame.path, aspectRatio: '2:1' }))
        .rejects.toThrow(/accepts 16:9, 9:16, 1:1/)
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('maps HTTP rejections and malformed submissions', async () => {
    const frame = await temporaryFrame()
    try {
      const cases: readonly (readonly [number, string, string])[] = [
        [400, JSON.stringify({ message: 'bad prompt' }), 'MEDIA_REQUEST_INVALID'],
        [402, 'plain text rejection', 'MEDIA_BUDGET_EXCEEDED'],
        [500, '', 'MEDIA_TASK_FAILED'],
      ]
      for (const [status, body, code] of cases) {
        const provider = new SiliconFlowMediaProvider(
          settingsOf(),
          recorder(() => new Response(body, { status })).fetchImpl,
        )
        await expect(submitVideo(provider, { firstFramePath: frame.path })).rejects.toMatchObject({ code })
      }

      for (const response of [new Response('not json'), new Response('{"requestId":""}'), new Response('[]')]) {
        const provider = new SiliconFlowMediaProvider(settingsOf(), recorder(() => response).fetchImpl)
        await expect(submitVideo(provider, { firstFramePath: frame.path }))
          .rejects.toThrow(/without returning a requestId/)
      }
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('reads the image formats SiliconFlow accepts and rejects the others', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-siliconflow-images-'))
    try {
      for (const [name, type] of [['a.jpg', 'jpeg'], ['b.jpeg', 'jpeg'], ['c.webp', 'webp'], ['d.heic', 'heic'], ['e.heif', 'heif']] as const) {
        const path = join(directory, name)
        await writeFile(path, solidPng(2, 2, 1, 2, 3))
        const { calls, fetchImpl } = recorder(() => json({ requestId: 'r' }))
        const provider = new SiliconFlowMediaProvider(settingsOf(), fetchImpl)
        await submitVideo(provider, { firstFramePath: path })
        const body = JSON.parse(calls[0]?.body ?? '{}') as { image?: string }
        expect(body.image?.startsWith(`data:image/${type};base64,`)).toBe(true)
      }

      const provider = new SiliconFlowMediaProvider(settingsOf(), recorder(() => json({ requestId: 'r' })).fetchImpl)
      await expect(submitVideo(provider, { firstFramePath: join(directory, 'a.gif') })).rejects.toThrow(/png, jpeg, webp, heic, and heif/)
      await expect(submitVideo(provider, { firstFramePath: join(directory, 'missing.png') }))
        .rejects.toThrow(/cannot read the SiliconFlow reference image/)

      const empty = join(directory, 'empty.png')
      await writeFile(empty, new Uint8Array(0))
      await expect(submitVideo(provider, { firstFramePath: empty })).rejects.toThrow(/is empty/)

      const large = join(directory, 'large.png')
      await writeFile(large, new Uint8Array(10 * 1024 * 1024 + 1))
      await expect(submitVideo(provider, { firstFramePath: large })).rejects.toThrow(/capped at/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves a credential reference per request', async () => {
    const frame = await temporaryFrame()
    try {
      const { calls, fetchImpl } = recorder(() => json({ requestId: 'r' }))
      const provider = new SiliconFlowMediaProvider(
        settingsOf({ apiKey: '', apiKeyEnv: 'SILICONFLOW_API_KEY' }),
        fetchImpl,
        async () => 'rotated-key',
      )
      await submitVideo(provider, { firstFramePath: frame.path })
      expect(calls[0]?.authorization).toBe('Bearer rotated-key')

      const missing = new SiliconFlowMediaProvider(
        settingsOf({ apiKey: '', apiKeyEnv: 'SILICONFLOW_API_KEY' }),
        fetchImpl,
        async () => undefined,
      )
      await expect(submitVideo(missing, { firstFramePath: frame.path }))
        .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_UNAVAILABLE' })

      const unconfigured = new SiliconFlowMediaProvider(settingsOf({ apiKey: ' ' }), fetchImpl)
      await expect(submitVideo(unconfigured, { firstFramePath: frame.path }))
        .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_UNAVAILABLE' })
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('settles a running task and downloads its video', async () => {
    const frame = await temporaryFrame()
    let statusPolls = 0
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
      if (call.url.endsWith('/video/status')) {
        statusPolls += 1
        if (statusPolls === 1) return json({ status: 'InQueue' })
        if (statusPolls === 2) return json({ status: 'InProgress' })
        return json({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.example.test/video.mp4' }] } })
      }
      if (call.url === 'https://cdn.example.test/video.mp4') {
        return new Response(MP4, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) },
        })
      }
      return json({ message: 'unexpected call' }, 500)
    })
    try {
      const provider = new SiliconFlowMediaProvider(settingsOf(), fetchImpl)
      const submitted = await submitVideo(provider, { firstFramePath: frame.path })
      const queued = await provider.poll(submitted, new AbortController().signal)
      expect(queued.status).toBe('queued')
      await delay(2)
      const running = await provider.poll(queued, new AbortController().signal)
      expect(running.status).toBe('running')
      await delay(2)
      const settled = await provider.poll(running, new AbortController().signal)
      expect(settled.status).toBe('succeeded')
      expect(settled.progress).toBe(1)
      expect(settled.artifacts?.[0]).toMatchObject({
        id: 'video',
        kind: 'video',
        mediaType: 'video/mp4',
        durationSec: SILICONFLOW_DURATION_SEC,
      })
      expect(settled.artifacts?.[0]?.bytes).toEqual(MP4)
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('reports provider failures and missing URLs', async () => {
    const frame = await temporaryFrame()
    try {
      const run = async (status: unknown): Promise<MediaTask> => {
        const provider = new SiliconFlowMediaProvider(settingsOf(), recorder((call) => {
          if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
          return json(status)
        }).fetchImpl)
        return provider.poll(await submitVideo(provider, { firstFramePath: frame.path }), new AbortController().signal)
      }

      expect((await run({ status: 'Failed', reason: 'sensitive content' })).error)
        .toEqual({ code: 'MEDIA_TASK_FAILED', message: 'sensitive content' })
      expect((await run({ status: 'Failed' })).error?.message)
        .toContain('reported a failed task without a reason')
      expect((await run({ status: 'Failed' })).error?.message).toContain('non-blank image')
      expect((await run({ status: 'Succeed', results: {} })).error?.message).toContain('without a video URL')
      expect((await run({ status: 'Succeed', results: { videos: [] } })).status).toBe('failed')
      expect((await run({ status: 'Succeed', results: { videos: [{}] } })).status).toBe('failed')
      expect((await run({ status: 'Succeed', results: { videos: [{ url: '' }] } })).status).toBe('failed')
      expect((await run({ status: 'Succeed' })).status).toBe('failed')
      expect((await run({ status: 'Waiting' })).error?.message).toContain('unknown status')
      expect((await run({ reason: 'no status' })).error?.message).toContain('has no status')
      expect((await run([])).error?.message).toContain('has no status')
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('fails status queries and download errors', async () => {
    const frame = await temporaryFrame()
    try {
      const queryFailure = new SiliconFlowMediaProvider(settingsOf(), recorder((call) => {
        if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
        return json({ message: 'query denied' }, 403)
      }).fetchImpl)
      expect((await queryFailure.poll(await submitVideo(queryFailure, { firstFramePath: frame.path }), new AbortController().signal))
        .error?.message).toContain('status query failed')

      const routes: readonly (readonly [() => Response | Promise<Response>, string])[] = [
        [() => new Response('no', { status: 500 }), 'MEDIA_TASK_FAILED'],
        [() => new Response(new Uint8Array(0)), 'MEDIA_ARTIFACT_INVALID'],
        [() => new Response(new Uint8Array(8), { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }), 'MEDIA_ARTIFACT_TOO_LARGE'],
        [() => { throw new Error('socket closed') }, 'MEDIA_TASK_FAILED'],
      ]
      for (const [download, code] of routes) {
        const provider = new SiliconFlowMediaProvider(settingsOf(), recorder((call) => {
          if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
          if (call.url.endsWith('/video/status')) {
            return json({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.test/out.mp4' }] } })
          }
          return download()
        }).fetchImpl)
        const settled = await provider.poll(await submitVideo(provider, { firstFramePath: frame.path }), new AbortController().signal)
        expect(settled.status, code).toBe('failed')
        expect(settled.error?.code).toBe(code)
      }

      const capped = new SiliconFlowMediaProvider(
        resolveSiliconFlow({ enabled: true, apiKey: 'k', pollMs: 1 }, 4),
        recorder((call) => {
          if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
          if (call.url.endsWith('/video/status')) {
            return json({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.test/out.mp4' }] } })
          }
          return new Response(new Uint8Array(8))
        }).fetchImpl,
      )
      const cappedTask = await capped.poll(await submitVideo(capped, { firstFramePath: frame.path }), new AbortController().signal)
      expect(cappedTask.error?.code).toBe('MEDIA_ARTIFACT_TOO_LARGE')
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('reports an untracked task, throttles polls, and times out', async () => {
    const frame = await temporaryFrame()
    try {
      const throttled = new SiliconFlowMediaProvider(settingsOf({ pollMs: 100 }), recorder((call) => {
        if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
        return json({ status: 'InQueue' })
      }).fetchImpl)
      const task = await submitVideo(throttled, { firstFramePath: frame.path })
      expect((await throttled.poll(task, new AbortController().signal)).status).toBe('queued')
      expect((await throttled.poll({ ...task, status: 'queued' }, new AbortController().signal)).status).toBe('queued')

      const untracked: MediaTask = {
        id: 'siliconflow-missing',
        provider: 'siliconflow',
        model: SILICONFLOW_VIDEO_MODEL,
        kind: 'video',
        status: 'running',
      }
      expect((await throttled.poll(untracked, new AbortController().signal)).status).toBe('failed')

      const provider = new SiliconFlowMediaProvider(settingsOf({ timeoutMs: 1 }), recorder((call) => {
        if (call.url.endsWith('/video/submit')) return json({ requestId: 'req-1' })
        return json({ status: 'InProgress' })
      }).fetchImpl)
      const submitted = await submitVideo(provider, { firstFramePath: frame.path })
      // Advance the clock past the deadline instead of racing real elapsed time.
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2)
      try {
        const settled = await provider.poll(submitted, new AbortController().signal)
        expect(settled.error?.code).toBe('MEDIA_TASK_TIMEOUT')
      } finally {
        now.mockRestore()
      }
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })

  it('cancels by dropping the local task and rejects foreign resume records', async () => {
    const frame = await temporaryFrame()
    try {
      const { calls, fetchImpl } = recorder(() => json({ requestId: 'req-1' }))
      const provider = new SiliconFlowMediaProvider(settingsOf(), fetchImpl)
      const submitted = await submitVideo(provider, { firstFramePath: frame.path })
      await provider.cancel(submitted)
      expect(calls).toHaveLength(1)
      expect((await provider.poll(submitted, new AbortController().signal)).error?.message)
        .toContain('not tracked')

      const record: MediaTaskRecord = {
        task: {
          id: 'siliconflow-req-9',
          provider: 'siliconflow',
          model: SILICONFLOW_VIDEO_MODEL,
          kind: 'video',
          status: 'running',
        },
        submittedAt: Date.now(),
        request: { kind: 'video', model: SILICONFLOW_VIDEO_MODEL, prompt: 'x' },
        outputPath: 'out.mp4',
      }
      expect(provider.resume(record)?.id).toBe('siliconflow-req-9')
      expect(provider.resume({ ...record, task: { ...record.task, provider: 'minimax' } })).toBeUndefined()
      expect(provider.resume({ ...record, task: { ...record.task, kind: 'image' } })).toBeUndefined()
      expect(provider.resume({ ...record, task: { ...record.task, id: 'req-9' } })).toBeUndefined()
      expect(provider.resume({ ...record, task: { ...record.task, id: 'siliconflow-' } })).toBeUndefined()
    } finally {
      await rm(frame.directory, { recursive: true, force: true })
    }
  })
})
