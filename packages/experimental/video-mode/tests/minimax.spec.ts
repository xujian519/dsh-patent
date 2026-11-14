/**
 * Tests of the cloud MiniMax-H3 provider: request construction, image data
 * URIs, published price estimates, status settlement, download, cancellation,
 * timeout, and config registration.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VideoMode, {
  MINIMAX_PROVIDER_ID,
  MINIMAX_VIDEO_MODEL,
  MiniMaxMediaProvider,
  resolveMediaConfig,
  resolveMiniMax,
  solidPng,
  type MediaTask,
  type MediaTaskRecord,
  type MiniMaxConfig,
  type MiniMaxFetchLike,
} from '../src/index.ts'

/** One recorded provider request. */
interface Call {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly authorization: string | undefined
}

/** A 16-byte MP4-shaped payload; the provider does not validate signatures. */
const MP4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])

/** JSON response helper. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** Build a fetch stub that records calls and delegates to a router. */
function recorder(route: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetchImpl: MiniMaxFetchLike } {
  const calls: Call[] = []
  const fetchImpl: MiniMaxFetchLike = async (url, init) => {
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
function settingsOf(overrides: MiniMaxConfig = {}) {
  return resolveMiniMax({ enabled: true, apiKey: 'sk-test', pollMs: 1, ...overrides }, 64 * 1024 * 1024)
}

/** Submit one video task through the provider. */
async function submitVideo(
  provider: MiniMaxMediaProvider,
  options: {
    readonly prompt?: string
    readonly durationSec?: number
    readonly resolution?: string
    readonly aspectRatio?: string
    readonly firstFramePath?: string
  } = {},
): Promise<MediaTask> {
  return provider.submit({
    kind: 'video',
    prompt: options.prompt ?? 'a lantern drifts over a river',
    ...options.durationSec === undefined ? {} : { durationSec: options.durationSec },
    ...options.resolution === undefined ? {} : { resolution: options.resolution },
    ...options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio },
    ...options.firstFramePath === undefined
      ? {}
      : { references: [{ kind: 'image', role: 'first-frame', path: options.firstFramePath }] },
  }, new AbortController().signal)
}

describe('minimax configuration', () => {
  it('applies the H3 defaults', () => {
    const settings = settingsOf()
    expect(settings.baseUrl).toBe('https://api.minimax.cn')
    expect(settings.model).toBe(MINIMAX_VIDEO_MODEL)
    expect(settings.resolution).toBe('768P')
    expect(settings.defaultDurationSec).toBe(5)
    expect(settings.maxDurationSec).toBe(15)
    expect(settings.aspectRatio).toBe('9:16')
  })

  it('keeps an empty key as unavailable configuration and rejects invalid bounds', () => {
    const unavailable = new MiniMaxMediaProvider(settingsOf({ apiKey: ' ' }))
    expect(unavailable.available()).toBe(false)
    expect(unavailable.unavailableReason()).toContain('MINIMAX_API_KEY')
    const available = new MiniMaxMediaProvider(settingsOf())
    expect(available.available()).toBe(true)
    expect(available.unavailableReason()).toBeUndefined()
    expect(() => settingsOf({ resolution: '480P' })).toThrow(/resolution/)
    expect(() => settingsOf({ defaultDurationSec: 3 })).toThrow(/defaultDurationSec/)
    expect(() => settingsOf({ maxDurationSec: 16 })).toThrow(/maxDurationSec/)
    expect(() => settingsOf({ aspectRatio: '2:1' })).toThrow(/aspectRatio/)
    expect(() => settingsOf({ pollMs: 0 })).toThrow(/pollMs/)
    expect(() => settingsOf({ model: 'MiniMax-H3-Highspeed' })).toThrow(/MiniMax-H3/)
  })

  it('resolves the provider only when enabled', () => {
    expect(resolveMediaConfig({ fakeProvider: false }).minimax).toBeUndefined()
    expect(resolveMediaConfig({ fakeProvider: false, minimax: { enabled: true, apiKey: 'k' } }).minimax?.model)
      .toBe(MINIMAX_VIDEO_MODEL)
  })

  it('registers the cloud model when enabled', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, {
      fakeProvider: false,
      videoModel: MINIMAX_VIDEO_MODEL,
      minimax: { enabled: true, apiKey: 'sk-test' },
    }).await()
    expect(ctx.media.models('video').map(model => model.id)).toEqual([MINIMAX_VIDEO_MODEL])
    expect(ctx.media.models('video')[0]?.provider).toBe(MINIMAX_PROVIDER_ID)
    await ctx.fiber.dispose()
  })
})

describe('minimax provider', () => {
  it('submits a text-to-video request with the configured ratio and price', async () => {
    const { calls, fetchImpl } = recorder(() => json({ task_id: '424010985738629' }))
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    const task = await submitVideo(provider, { durationSec: 4, aspectRatio: '16:9' })

    expect(task).toMatchObject({
      id: 'minimax-424010985738629',
      provider: 'minimax',
      model: MINIMAX_VIDEO_MODEL,
      kind: 'video',
      status: 'submitted',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.minimax.cn/v2/video_generation')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      model?: string
      content?: { type?: string; text?: string }[]
      duration?: number
      resolution?: string
      ratio?: string
    }
    expect(body.model).toBe(MINIMAX_VIDEO_MODEL)
    expect(body.content).toEqual([{ type: 'text', text: 'a lantern drifts over a river' }])
    expect(body.duration).toBe(4)
    expect(body.resolution).toBe('768P')
    expect(body.ratio).toBe('16:9')

    expect(provider.estimate({ kind: 'video', prompt: 'x', durationSec: 4, resolution: '2K' }))
      .toEqual({ cost: { amountMinor: 320, currency: 'CNY' }, durationSec: 4, confidence: 'exact' })
    expect(provider.estimate({ kind: 'video', prompt: 'x', durationSec: 5 }))
      .toEqual({ cost: { amountMinor: 250, currency: 'CNY' }, durationSec: 5, confidence: 'exact' })
  })

  it('attaches a local first frame as a PNG data URI and forces adaptive ratio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-minimax-'))
    try {
      const frame = join(directory, 'start.png')
      await writeFile(frame, solidPng(4, 4, 255, 128, 0))
      const { calls, fetchImpl } = recorder(() => json({ task_id: 't-1' }))
      const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
      await submitVideo(provider, { firstFramePath: frame, aspectRatio: '9:16' })

      const body = JSON.parse(calls[0]?.body ?? '{}') as {
        content?: { type?: string; role?: string; image_url?: { url?: string } }[]
        ratio?: string
      }
      expect(body.ratio).toBe('adaptive')
      expect(body.content?.[1]?.type).toBe('image_url')
      expect(body.content?.[1]?.role).toBe('first_frame')
      expect(body.content?.[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects mixing a first frame with a reference image', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't-1' })).fetchImpl)
    await expect(provider.submit({
      kind: 'video',
      prompt: 'x',
      references: [
        { kind: 'image', role: 'first-frame', path: '/tmp/start.png' },
        { kind: 'image', role: 'style', path: '/tmp/style.png' },
      ],
    }, new AbortController().signal)).rejects.toThrow(/cannot mix/)
  })

  it('rejects a 480P request and a non-integer duration', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't-1' })).fetchImpl)
    await expect(submitVideo(provider, { resolution: '480P' })).rejects.toThrow(/768P or 2K/)
    await expect(submitVideo(provider, { durationSec: 4.5 })).rejects.toThrow(/whole-second/)
  })

  it('maps a payment failure to the budget failure code', async () => {
    const provider = new MiniMaxMediaProvider(
      settingsOf(),
      recorder(() => json({ error: { message: 'insufficient balance' } }, 402)).fetchImpl,
    )
    await expect(submitVideo(provider)).rejects.toMatchObject({ code: 'MEDIA_BUDGET_EXCEEDED' })
  })

  it('settles a running task and downloads its video', async () => {
    let statusPolls = 0
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      if (call.url.includes('/v2/query/video_generation/')) {
        statusPolls += 1
        return statusPolls === 1
          ? json({ task: { id: 't-1', status: 'running' } })
          : json({
            task: {
              id: 't-1',
              status: 'succeeded',
              content: { url: 'https://cdn.example.test/video.mp4' },
            },
          })
      }
      if (call.url === 'https://cdn.example.test/video.mp4') {
        return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } })
      }
      return json({ error: { message: 'unexpected call' } }, 500)
    })
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    const submitted = await submitVideo(provider, { durationSec: 4 })
    const running = await provider.poll(submitted, new AbortController().signal)
    expect(running.status).toBe('running')
    await delay(2)
    const settled = await provider.poll(running, new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(settled.artifacts?.[0]).toMatchObject({
      id: 'video',
      kind: 'video',
      mediaType: 'video/mp4',
      durationSec: 4,
    })
    expect(settled.artifacts?.[0]?.bytes).toEqual(MP4)
  })

  it('reports the provider failure message', async () => {
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: { id: 't-1', status: 'failed', error: { code: '1026', message: 'sensitive content' } } })
    })
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    const submitted = await submitVideo(provider)
    const settled = await provider.poll(submitted, new AbortController().signal)
    expect(settled.status).toBe('failed')
    expect(settled.error).toEqual({ code: 'MEDIA_TASK_FAILED', message: 'sensitive content' })
  })

  it('cancels through the delete endpoint', async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task_id: 't-1', action: 'cancelled', status: 'cancelled' })
    })
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    const submitted = await submitVideo(provider)
    await provider.cancel(submitted)
    expect(calls[1]?.method).toBe('DELETE')
    expect(calls[1]?.url).toBe('https://api.minimax.cn/v2/video_generation/t-1')
  })

  it('times out a task that does not settle', async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      if (call.method === 'DELETE') return json({ task_id: 't-1', action: 'cancelled', status: 'cancelled' })
      return json({ task: { id: 't-1', status: 'running' } })
    })
    const provider = new MiniMaxMediaProvider(settingsOf({ timeoutMs: 1 }), fetchImpl)
    const submitted = await submitVideo(provider)
    // Advance the clock past the deadline instead of racing real elapsed time.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2)
    try {
      const settled = await provider.poll(submitted, new AbortController().signal)
      expect(settled.status).toBe('failed')
      expect(settled.error?.code).toBe('MEDIA_TASK_TIMEOUT')
      expect(calls.some(call => call.method === 'DELETE')).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('rejects an artifact above the configured cap', async () => {
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      if (call.url.includes('/v2/query/video_generation/')) {
        return json({ task: { id: 't-1', status: 'succeeded', content: { url: 'https://cdn.example.test/large.mp4' } } })
      }
      return new Response(MP4, { status: 200, headers: { 'content-length': '999999' } })
    })
    const settings = resolveMiniMax({ enabled: true, apiKey: 'k', pollMs: 1 }, 100)
    const provider = new MiniMaxMediaProvider(settings, fetchImpl)
    const submitted = await submitVideo(provider)
    const settled = await provider.poll(submitted, new AbortController().signal)
    expect(settled.status).toBe('failed')
    expect(settled.error?.code).toBe('MEDIA_ARTIFACT_TOO_LARGE')
  })
})

describe('minimax edge cases', () => {
  it('reports non-video requests and unknown model ids', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't' })).fetchImpl)
    expect(provider.estimate({ kind: 'image', prompt: 'x' })).toEqual({ confidence: 'unknown' })
    await expect(provider.submit({ kind: 'image', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/serves video only/)
    await expect(provider.submit({ kind: 'video', prompt: 'x', model: 'other' }, new AbortController().signal))
      .rejects.toThrow(/serves no video model/)
  })

  it('rejects a response without a task id, including non-JSON and array bodies', async () => {
    for (const body of [new Response('not json', { status: 200 }), new Response('[]', { status: 200 })]) {
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => body).fetchImpl)
      await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
        .rejects.toThrow(/without returning a task_id/)
    }
  })

  it('maps HTTP rejections to request, budget, and task failures', async () => {
    const cases: readonly (readonly [number, string, string])[] = [
      [400, JSON.stringify({ base_resp: { status_msg: 'bad prompt' } }), 'MEDIA_REQUEST_INVALID'],
      [422, 'plain text rejection', 'MEDIA_REQUEST_INVALID'],
      [500, '', 'MEDIA_TASK_FAILED'],
    ]
    for (const [status, body, code] of cases) {
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => new Response(body, { status })).fetchImpl)
      await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
        .rejects.toMatchObject({ code })
    }
  })

  it('reports an untracked task and throttles repeated polls', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf({ pollMs: 100 }), recorder(() => json({ task_id: 't-1' })).fetchImpl)
    const untracked: MediaTask = { id: 'minimax-missing', provider: 'minimax', model: MINIMAX_VIDEO_MODEL, kind: 'video', status: 'running' }
    expect((await provider.poll(untracked, new AbortController().signal)).status).toBe('failed')

    let polls = 0
    const throttled = new MiniMaxMediaProvider(settingsOf({ pollMs: 100 }), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      polls += 1
      return json({ task: { id: 't-1', status: 'queued' } })
    }).fetchImpl)
    const task = await submitVideo(throttled)
    expect((await throttled.poll(task, new AbortController().signal)).status).toBe('queued')
    expect((await throttled.poll({ ...task, status: 'queued' }, new AbortController().signal)).status).toBe('queued')
    expect(polls).toBe(1)
  })

  it('settles queued, cancelled, failed, and unknown statuses', async () => {
    const statuses: readonly (readonly [string, string])[] = [
      ['queued', 'queued'],
      ['cancelled', 'cancelled'],
      ['waiting', 'failed'],
    ]
    for (const [remote, expected] of statuses) {
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
        if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
        return json({ task: { id: 't-1', status: remote } })
      }).fetchImpl)
      const submitted = await submitVideo(provider)
      await delay(2)
      expect((await provider.poll(submitted, new AbortController().signal)).status).toBe(expected)
    }

    const failedProvider = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: { id: 't-1', status: 'failed' } })
    }).fetchImpl)
    const failed = await failedProvider.poll(await submitVideo(failedProvider), new AbortController().signal)
    expect(failed.error?.message).toContain('MiniMax reported a failed task')
  })

  it('fails a succeeded task without a URL and surfaces query failures', async () => {
    const noUrl = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: { id: 't-1', status: 'succeeded', content: {} } })
    }).fetchImpl)
    expect((await noUrl.poll(await submitVideo(noUrl), new AbortController().signal)).error?.message)
      .toContain('without a download URL')

    const malformed = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: {} })
    }).fetchImpl)
    expect((await malformed.poll(await submitVideo(malformed), new AbortController().signal)).error?.message)
      .toContain('no task status')

    const rejected = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ error: { message: 'query denied' } }, 403)
    }).fetchImpl)
    expect((await rejected.poll(await submitVideo(rejected), new AbortController().signal)).error?.message)
      .toContain('status query failed')
  })

  it('fails downloads with an HTTP error, an empty body, and both size caps', async () => {
    const router = (download: () => Response) => (call: Call): Response => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      if (call.url.includes('/v2/query/')) return json({ task: { id: 't-1', status: 'succeeded', content: { url: 'https://cdn.test/out.mp4' } } })
      return download()
    }
    const run = async (download: () => Response, cap = 1024): Promise<MediaTask> => {
      const provider = new MiniMaxMediaProvider(
        resolveMiniMax({ enabled: true, apiKey: 'k', pollMs: 1 }, cap),
        recorder(router(download)).fetchImpl,
      )
      return provider.poll(await submitVideo(provider), new AbortController().signal)
    }
    expect((await run(() => new Response('no', { status: 500 }))).error?.code).toBe('MEDIA_TASK_FAILED')
    expect((await run(() => new Response(new Uint8Array(0)))).error?.code).toBe('MEDIA_ARTIFACT_INVALID')
    expect((await run(() => new Response(new Uint8Array(8), { headers: { 'content-length': '2048' } }), 10)).error?.code)
      .toBe('MEDIA_ARTIFACT_TOO_LARGE')
    expect((await run(() => new Response(new Uint8Array(8)), 4)).error?.code).toBe('MEDIA_ARTIFACT_TOO_LARGE')
  })

  it('does not fetch a settled video whose URL is not http or https', async () => {
    for (const videoUrl of ['file:///etc/passwd', 'out.mp4']) {
      let downloads = 0
      const provider = new MiniMaxMediaProvider(settingsOf(), async (url) => {
        if (url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
        if (url.includes('/v2/query/')) {
          return json({ task: { id: 't-1', status: 'succeeded', content: { url: videoUrl } } })
        }
        downloads += 1
        return new Response(new Uint8Array([1]))
      })
      const settled = await provider.poll(await submitVideo(provider), new AbortController().signal)
      expect(settled.error?.code).toBe('MEDIA_ARTIFACT_INVALID')
      expect(downloads).toBe(0)
    }
  })

  it('fails a download whose transport throws a non-Error', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), async (url) => {
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      if (url.includes('/v2/query/')) return json({ task: { id: 't-1', status: 'succeeded', content: { url: 'https://cdn.test/out.mp4' } } })
      throw 'socket closed'
    })
    const settled = await provider.poll(await submitVideo(provider), new AbortController().signal)
    expect(settled.error).toEqual({ code: 'MEDIA_TASK_FAILED', message: 'socket closed' })
  })

  it('cancels an untracked task through its recovered remote id and swallows transport errors', async () => {
    const calls: string[] = []
    const provider = new MiniMaxMediaProvider(settingsOf(), async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 't-9' })
      throw 'offline'
    })
    const submitted = await submitVideo(provider)
    await provider.cancel(submitted)
    await provider.cancel(submitted)
    expect(calls.filter(call => call.startsWith('DELETE'))).toHaveLength(2)
    expect(calls.some(call => call.endsWith('/v2/video_generation/t-9'))).toBe(true)
  })

  it('validates prompt, reference count, roles, and image extensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-minimax-images-'))
    try {
      const png = join(directory, 'a.png')
      await writeFile(png, solidPng(1, 1, 1, 1, 1))
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't-1' })).fetchImpl)
      const signal = new AbortController().signal
      await expect(provider.submit({ kind: 'video', prompt: 'x'.repeat(7001) }, signal))
        .rejects.toThrow(/at most 7000 characters/)
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: Array.from({ length: 10 }, () => ({ kind: 'image' as const, role: 'style' as const, path: png })),
      }, signal)).rejects.toThrow(/at most 9 reference images/)
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [
          { kind: 'image', role: 'first-frame', path: png },
          { kind: 'image', role: 'first-frame', path: png },
        ],
      }, signal)).rejects.toThrow(/at most one first frame/)
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [{ kind: 'audio', path: png }],
      }, signal)).rejects.toThrow(/must be images/)
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [{ kind: 'image', path: join(directory, 'missing.png') }],
      }, signal)).rejects.toThrow(/cannot read the MiniMax reference image/)
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [{ kind: 'image', path: join(directory, 'frame.gif') }],
      }, signal)).rejects.toThrow(/accepts png, jpeg, webp, heic, and heif/)

      const extensions = ['a.jpg', 'a.jpeg', 'a.webp', 'a.heic', 'a.heif']
      const references = []
      for (const name of extensions) {
        const path = join(directory, name)
        await writeFile(path, 'x')
        references.push({ kind: 'image' as const, role: 'style' as const, path })
      }
      references.push({ kind: 'image' as const, role: 'character' as const, path: png })
      await expect(provider.submit({ kind: 'video', prompt: 'x', references }, signal)).resolves.toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an oversized image and an aggregate request above the transport cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-minimax-large-'))
    try {
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't-1' })).fetchImpl)
      const signal = new AbortController().signal
      const oversized = join(directory, 'huge.png')
      await writeFile(oversized, Buffer.alloc(30 * 1024 * 1024 + 1))
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [{ kind: 'image', path: oversized }],
      }, signal)).rejects.toThrow(/capped at 31457280 bytes/)

      const aggregate = join(directory, 'aggregate.png')
      await writeFile(aggregate, Buffer.alloc(24 * 1024 * 1024))
      await expect(provider.submit({
        kind: 'video', prompt: 'x',
        references: [
          { kind: 'image', role: 'style', path: aggregate },
          { kind: 'image', role: 'style', path: aggregate },
          { kind: 'image', role: 'style', path: aggregate },
        ],
      }, signal)).rejects.toThrow(/capped at 67108864 bytes/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('minimax branch coverage', () => {
  it('appends a non-empty negative prompt', async () => {
    const { calls, fetchImpl } = recorder(() => json({ task_id: 't-1' }))
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    await provider.submit({
      kind: 'video', prompt: 'a door', negativePrompt: 'blurry', durationSec: 4, resolution: '2K',
    }, new AbortController().signal)
    const body = JSON.parse(calls[0]?.body ?? '{}') as { content?: { text?: string }[] }
    expect(body.content?.[0]?.text).toBe('a door\n\nAvoid: blurry')
  })

  it('rejects durations below the minimum, above the maximum, and an unsupported ratio', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json({ task_id: 't-1' })).fetchImpl)
    const signal = new AbortController().signal
    await expect(provider.submit({ kind: 'video', prompt: 'x', durationSec: 3 }, signal))
      .rejects.toThrow(/durations from 4 to 15/)
    await expect(provider.submit({ kind: 'video', prompt: 'x', durationSec: 16 }, signal))
      .rejects.toThrow(/durations from 4 to 15/)
    await expect(provider.submit({ kind: 'video', prompt: 'x', aspectRatio: '2:1' }, signal))
      .rejects.toThrow(/text-to-video accepts/)
  })

  it('maps a last frame reference and rejects a status body without a task object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-minimax-last-'))
    try {
      const frame = join(directory, 'end.png')
      await writeFile(frame, solidPng(1, 1, 1, 1, 1))
      const { calls, fetchImpl } = recorder(() => json({ task_id: 't-1' }))
      const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
      await provider.submit({
        kind: 'video', prompt: 'x',
        references: [{ kind: 'image', role: 'last-frame', path: frame }],
      }, new AbortController().signal)
      const body = JSON.parse(calls[0]?.body ?? '{}') as { content?: { role?: string }[] }
      expect(body.content?.[1]?.role).toBe('last_frame')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    const arrayStatus = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json([])
    }).fetchImpl)
    const task = await submitVideo(arrayStatus)
    const settled = await arrayStatus.poll(task, new AbortController().signal)
    expect(settled.error?.message).toContain('no task status')
  })

  it('reports a failed task whose error object has no message', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: { id: 't-1', status: 'failed', error: {} } })
    }).fetchImpl)
    const settled = await provider.poll(await submitVideo(provider), new AbortController().signal)
    expect(settled.error?.message).toContain('MiniMax reported a failed task')
  })

  it('cancels a task id without the provider prefix', async () => {
    const calls: string[] = []
    const provider = new MiniMaxMediaProvider(settingsOf(), async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return json({ task_id: 'x' })
    })
    await provider.cancel({
      id: 'remote-7', provider: 'minimax', model: MINIMAX_VIDEO_MODEL, kind: 'video', status: 'running',
    })
    expect(calls[0]).toBe('DELETE https://api.minimax.cn/v2/video_generation/remote-7')
  })
})

describe('minimax rejection fallbacks', () => {
  it('falls back to the raw body for non-string provider messages', async () => {
    for (const body of [
      { error: { message: 7 } },
      { base_resp: { status_msg: 7 } },
      { base_resp: 'bad' },
    ]) {
      const provider = new MiniMaxMediaProvider(settingsOf(), recorder(() => json(body, 400)).fetchImpl)
      await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'MEDIA_REQUEST_INVALID' })
    }
  })
})

describe('minimax credential references', () => {
  it('resolves a named credential per request', async () => {
    const settings = resolveMiniMax({ enabled: true, apiKeyEnv: 'MINIMAX_API_KEY', pollMs: 1 }, 1024)
    const authorizations: (string | undefined)[] = []
    let reads = 0
    const provider = new MiniMaxMediaProvider(settings, async (url, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? undefined)
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 't-1' })
      return json({ task: { id: 't-1', status: 'running' } })
    }, async (ref) => {
      reads += 1
      expect(ref).toBe('MINIMAX_API_KEY')
      return reads === 1 ? 'sk-first' : 'sk-rotated'
    })
    const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    await provider.poll(task, new AbortController().signal)
    expect(authorizations).toEqual(['Bearer sk-first', 'Bearer sk-rotated'])
  })

  it('fails loudly when the named credential is unset', async () => {
    const settings = resolveMiniMax({ enabled: true, apiKeyEnv: 'DSH_MISSING_MINIMAX_KEY', pollMs: 1 }, 1024)
    const provider = new MiniMaxMediaProvider(settings, recorder(() => json({ task_id: 't' })).fetchImpl)
    await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_UNAVAILABLE' })
  })

  it('rejects a request with neither a direct key nor a reference', async () => {
    const provider = new MiniMaxMediaProvider(settingsOf({ apiKey: '' }), recorder(() => json({ task_id: 't' })).fetchImpl)
    expect(provider.available()).toBe(false)
    await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/set MINIMAX_API_KEY or configure minimax.apiKeyEnv/)
  })
})

describe('resumption', () => {
  /** One journal record for a MiniMax task. */
  function record(): MediaTaskRecord {
    return {
      task: { id: 'minimax-remote-1', provider: 'minimax', model: MINIMAX_VIDEO_MODEL, kind: 'video', status: 'running' },
      submittedAt: Date.now(),
      request: { kind: 'video', model: MINIMAX_VIDEO_MODEL, prompt: 'a lantern', durationSec: 4, aspectRatio: '9:16', resolution: '768P' },
      outputPath: 'shots/s01.mp4',
    }
  }

  it('rebuilds pending state from the remote id and downloads the settled clip', async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.includes('/v2/query/video_generation/remote-1')) {
        return json({ task: { status: 'succeeded', content: { url: 'https://cdn.test/clip.mp4' } } })
      }
      if (call.url === 'https://cdn.test/clip.mp4') return new Response(MP4, { status: 200 })
      throw new Error(`unexpected ${call.url}`)
    })
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl)
    const resumed = provider.resume(record())
    expect(resumed?.id).toBe('minimax-remote-1')

    const settled = await provider.poll(resumed as MediaTask, new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(settled.artifacts?.[0]).toMatchObject({ mediaType: 'video/mp4', durationSec: 4 })
    expect(settled.artifacts?.[0]?.bytes).toEqual(MP4)
    expect(calls[0]?.url).toContain('/v2/query/video_generation/remote-1')
  })

  it('ignores foreign records and rejects a resumed duration the API cannot serve', () => {
    const provider = new MiniMaxMediaProvider(settingsOf())
    const base = record()
    expect(provider.resume({ ...base, task: { ...base.task, provider: 'comfyui' } })).toBeUndefined()
    expect(provider.resume({ ...base, task: { ...base.task, kind: 'speech' } })).toBeUndefined()
    expect(provider.resume({ ...base, task: { ...base.task, id: 'other' } })).toBeUndefined()
    expect(provider.resume({ ...base, task: { ...base.task, id: 'minimax-' } })).toBeUndefined()
    expect(provider.resume({ ...base, request: { ...base.request, durationSec: undefined } })?.id).toBe('minimax-remote-1')
    expect(() => provider.resume({ ...base, request: { ...base.request, durationSec: 2 } })).toThrow(/4 to 15/)
  })
})
