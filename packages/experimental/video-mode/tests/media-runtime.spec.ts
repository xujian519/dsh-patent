/**
 * Media runtime selection, retention, cancellation, and configuration guards,
 * plus the synthetic provider's defensive paths. Provider transport behavior
 * lives in the MiniMax and ComfyUI specs.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VideoMode, {
  SYNTHETIC_IMAGE_MODEL,
  SYNTHETIC_PROVIDER_ID,
  SYNTHETIC_SPEECH_MODEL,
  SYNTHETIC_VIDEO_MODEL,
  SyntheticMediaProvider,
  estimateCost,
  resolveComfyUi,
  resolveMediaConfig,
  resolveMiniMax,
  type MediaModel,
  type MediaProvider,
  type MediaTask,
  type MediaTaskRecord,
} from '../src/index.ts'
import { messageOf } from '../src/media.ts'
import { MediaFailure } from '../src/types.ts'

/** A model table for a stub provider. */
function modelOf(id: string, overrides: Partial<MediaModel> = {}): MediaModel {
  return { id, kind: 'video', provider: 'stub', ...overrides }
}

/** A stub provider whose behavior each test overrides. */
function stubProvider(overrides: Partial<Omit<MediaProvider, 'models'>> & {
  readonly id: string
  readonly models?: readonly MediaModel[] | (() => readonly MediaModel[])
}): MediaProvider {
  const id = overrides.id
  const table = overrides.models
  const models = (): readonly MediaModel[] =>
    typeof table === 'function' ? table() : table ?? [modelOf(`${id}/video`)]
  const reason = overrides.unavailableReason
  return {
    id,
    capabilities: overrides.capabilities ?? ['video'],
    models,
    available: overrides.available ?? (() => true),
    ...reason === undefined ? {} : { unavailableReason: reason },
    estimate: overrides.estimate ?? (() => ({ confidence: 'exact' })),
    submit: overrides.submit ?? (async request => ({
      id: `${id}-1`,
      provider: id,
      model: request.model ?? models()[0]?.id ?? '',
      kind: request.kind,
      status: 'submitted',
    })),
    poll: overrides.poll ?? (async task => ({ ...task, status: 'succeeded' })),
    cancel: overrides.cancel ?? (async () => {}),
    ...overrides.resume === undefined ? {} : { resume: overrides.resume },
  }
}

/** A context carrying the runtime without the synthetic provider. */
async function bareRuntime(): Promise<{ ctx: Context; media: Context['media'] }> {
  const ctx = new Context()
  await ctx.plugin(VideoMode, { fakeProvider: false, waitMs: 50, pollMs: 1 }).await()
  return { ctx, media: ctx.media }
}

describe('configuration guards', () => {
  it('rejects invalid runtime bounds', () => {
    expect(() => resolveMediaConfig({ waitMs: -1 })).toThrow(/non-negative integer/)
    expect(() => resolveMediaConfig({ waitMs: 0 })).toThrow(/must be positive/)
    expect(() => resolveMediaConfig({ approvalThresholdCny: Number.NaN })).toThrow(/approvalThresholdCny/)
  })

  it('rejects invalid ComfyUI bounds', () => {
    expect(() => resolveComfyUi({ pollMs: 0 }, 10)).toThrow(/comfyui.pollMs/)
    expect(() => resolveComfyUi({ timeoutMs: 0 }, 10)).toThrow(/comfyui.timeoutMs/)
    expect(() => resolveComfyUi({ outputPrefix: ' ' }, 10)).toThrow(/comfyui.outputPrefix/)
    expect(() => resolveComfyUi({ video: { defaultDurationSec: 0 } }, 10)).toThrow(/defaultDurationSec/)
    expect(() => resolveComfyUi({ image: { size: 100 } }, 10)).toThrow(/comfyui.image.size/)
  })

  it('rejects invalid MiniMax bounds while accepting an empty key', () => {
    expect(() => resolveMiniMax({ baseUrl: '' }, 10)).toThrow(/minimax.baseUrl/)
    expect(() => resolveMiniMax({ timeoutMs: 0 }, 10)).toThrow(/minimax.timeoutMs/)
    expect(() => resolveMiniMax({ defaultDurationSec: 3 }, 10)).toThrow(/defaultDurationSec/)
    expect(() => resolveMiniMax({ maxDurationSec: 20 }, 10)).toThrow(/maxDurationSec/)
    expect(resolveMiniMax({}, 10).apiKey).toBe('')
  })
})

describe('registration and model listing', () => {
  it('rejects a duplicate id and removes a provider on release', async () => {
    const { ctx, media } = await bareRuntime()
    const provider = stubProvider({ id: 'stub', models: [modelOf('stub/video')] })
    const release = media.register(provider)
    expect(() => media.register(provider)).toThrow(/already registered/)
    expect(media.models().map(model => model.id)).toContain('stub/video')
    release()
    expect(media.models()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('hides an unavailable provider and explains why when selection fails', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({ id: 'with-reason', available: () => false, unavailableReason: () => 'set the token', models: [modelOf('a/video')] }))
    media.register(stubProvider({ id: 'no-reason', available: () => false, models: [modelOf('b/video')] }))
    expect(media.models()).toEqual([])
    await expect(media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/with-reason \(set the token\); no-reason \(unavailable\)/)
    await ctx.fiber.dispose()
  })

  it('reports the absence of any provider', async () => {
    const { ctx, media } = await bareRuntime()
    await expect(media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/no media provider serves video/)
    await ctx.fiber.dispose()
  })
})

describe('selection rules', () => {
  it('rejects an unknown model with the available ids', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({ id: 'stub', models: [modelOf('stub/video')] }))
    await expect(media.submit({ kind: 'video', prompt: 'x', model: 'other' }, new AbortController().signal))
      .rejects.toThrow(/available: stub\/video/)
    await ctx.fiber.dispose()
  })

  it('rejects a model served by two providers', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({ id: 'one', models: [modelOf('shared')] }))
    media.register(stubProvider({ id: 'two', models: [modelOf('shared')] }))
    await expect(media.submit({ kind: 'video', prompt: 'x', model: 'shared' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_AMBIGUOUS' })
    await ctx.fiber.dispose()
  })

  it('rejects a model that disappears between the two lookups', async () => {
    const { ctx, media } = await bareRuntime()
    let calls = 0
    const flaky = modelOf('flaky')
    media.register(stubProvider({
      id: 'flaky',
      models: () => {
        calls += 1
        return calls === 1 ? [flaky] : [modelOf('other')]
      },
    }))
    await expect(media.submit({ kind: 'video', prompt: 'x', model: 'flaky' }, new AbortController().signal))
      .rejects.toThrow(/disappeared during selection/)
    await ctx.fiber.dispose()
  })

  it('rejects invalid durations, ratios, and unsupported references', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'stub',
      models: [modelOf('stub/video', { maxDurationSec: 5, aspectRatios: ['9:16'] })],
    }))
    const signal = new AbortController().signal
    const base = { kind: 'video' as const, prompt: 'x', model: 'stub/video' }
    await expect(media.submit({ ...base, durationSec: 0 }, signal)).rejects.toThrow(/must be positive/)
    await expect(media.submit({ ...base, durationSec: 6 }, signal)).rejects.toThrow(/at most 5s/)
    await expect(media.submit({ ...base, aspectRatio: '4:3' }, signal)).rejects.toThrow(/accepts 9:16/)
    await expect(media.submit({ ...base, references: [{ kind: 'image', path: 'a.png' }] }, signal))
      .rejects.toThrow(/accepts no reference inputs/)
    await ctx.fiber.dispose()
  })
})

describe('submission and generation', () => {
  it('wraps a non-media provider failure with the provider id', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({ id: 'broken', submit: async () => { throw 'offline' } }))
    await expect(media.submit({ kind: 'video', prompt: 'x', model: 'broken/video' }, new AbortController().signal))
      .rejects.toThrow(/media provider broken failed to submit: offline/)
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    await ctx.fiber.dispose()
  })

  it('returns a running task after the wait deadline and backfills its cost', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'slow',
      estimate: () => ({ cost: { amountMinor: 7, currency: 'CNY' }, confidence: 'exact' }),
      submit: async request => ({
        id: 'slow-1', provider: 'slow', model: request.model ?? 'slow/video', kind: 'video', status: 'running',
      }),
      poll: async task => task,
    }))
    const task = await media.generate({ kind: 'video', prompt: 'x', model: 'slow/video' }, new AbortController().signal)
    expect(task.status).toBe('running')
    expect(task.cost).toBeUndefined()

    media.register(stubProvider({
      id: 'quick',
      models: [modelOf('quick/video')],
      estimate: () => ({ cost: { amountMinor: 9, currency: 'CNY' }, confidence: 'exact' }),
      submit: async request => ({
        id: 'quick-1', provider: 'quick', model: request.model ?? 'quick/video', kind: 'video', status: 'succeeded',
      }),
    }))
    const settled = await media.generate({ kind: 'video', prompt: 'x', model: 'quick/video' }, new AbortController().signal)
    expect(settled.cost).toEqual({ amountMinor: 9, currency: 'CNY' })
    await ctx.fiber.dispose()
  })

  it('keeps a cancelled task cancelled when its poll settles later', async () => {
    const { ctx, media } = await bareRuntime()
    let releasePoll: () => void = () => {}
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve })
    let enteredPoll: () => void = () => {}
    const polling = new Promise<void>((resolve) => { enteredPoll = resolve })
    media.register(stubProvider({
      id: 'late',
      submit: async request => ({
        id: 'late-1', provider: 'late', model: request.model ?? 'late/video', kind: 'video', status: 'running',
      }),
      poll: async (task) => {
        enteredPoll()
        await pollGate
        return { ...task, status: 'succeeded' }
      },
    }))
    const submitted = await media.submit({ kind: 'video', prompt: 'x', model: 'late/video' }, new AbortController().signal)
    const waiting = media.wait(submitted, new AbortController().signal)
    await polling
    expect((await media.cancel(submitted.id)).status).toBe('cancelled')
    releasePoll()
    expect((await waiting).status).toBe('cancelled')
    expect(media.status(submitted.id).status).toBe('cancelled')
    await ctx.fiber.dispose()
  })

  it('returns the running task when a poll does not settle within waitMs', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, waitMs: 30, pollMs: 1 }).await()
    ctx.media.register(stubProvider({
      id: 'stuck',
      submit: async request => ({
        id: 'stuck-1', provider: 'stuck', model: request.model ?? 'stuck/video', kind: 'video', status: 'running',
      }),
      poll: () => new Promise<MediaTask>(() => {}),
    }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const verdict = await Promise.race([
      ctx.media.generate({ kind: 'video', prompt: 'x', model: 'stuck/video' }, new AbortController().signal)
        .then(task => task.status, (error: unknown) => error),
      new Promise<string>((resolve) => { timer = setTimeout(() => { resolve('hung') }, 500) }),
    ])
    clearTimeout(timer)
    expect(verdict).toBe('running')
    expect(ctx.media.status('stuck-1').status).toBe('running')
    await ctx.fiber.dispose()
  })

  it('retains a settlement that arrives after the bounded wait expires', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, waitMs: 30, pollMs: 1 }).await()
    let releasePoll: () => void = () => {}
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve })
    let enteredPoll: () => void = () => {}
    const polling = new Promise<void>((resolve) => { enteredPoll = resolve })
    ctx.media.register(stubProvider({
      id: 'late-settle',
      submit: async request => ({
        id: 'late-settle-1', provider: 'late-settle', model: request.model ?? 'late-settle/video', kind: 'video', status: 'running',
      }),
      poll: async (task) => {
        enteredPoll()
        await pollGate
        return { ...task, status: 'succeeded' }
      },
    }))
    const waiting = ctx.media.generate(
      { kind: 'video', prompt: 'x', model: 'late-settle/video' },
      new AbortController().signal,
    )
    await polling
    expect((await waiting).status).toBe('running')
    releasePoll()
    await delay(10)
    expect(ctx.media.status('late-settle-1').status).toBe('succeeded')
    await ctx.fiber.dispose()
  })

  it('does not poll after the wait interval has already passed the deadline', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, waitMs: 5, pollMs: 40 }).await()
    let polls = 0
    ctx.media.register(stubProvider({
      id: 'slow-poll',
      submit: async request => ({
        id: 'slow-poll-1', provider: 'slow-poll', model: request.model ?? 'slow-poll/video', kind: 'video', status: 'running',
      }),
      poll: async (task) => {
        polls += 1
        return { ...task, status: 'succeeded' }
      },
    }))
    const task = await ctx.media.generate(
      { kind: 'video', prompt: 'x', model: 'slow-poll/video' },
      new AbortController().signal,
    )
    expect(task.status).toBe('running')
    expect(polls).toBe(0)
    await ctx.fiber.dispose()
  })

  it('propagates a poll failure from a bounded wait', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'broken-poll',
      submit: async request => ({
        id: 'broken-poll-1', provider: 'broken-poll', model: request.model ?? 'broken-poll/video', kind: 'video', status: 'running',
      }),
      poll: async () => { throw new MediaFailure('poll down', 'MEDIA_TASK_FAILED') },
    }))
    await expect(media.generate(
      { kind: 'video', prompt: 'x', model: 'broken-poll/video' },
      new AbortController().signal,
    )).rejects.toThrow(/poll down/)
    await ctx.fiber.dispose()
  })

  it('stops a generation whose provider disappears and one that is aborted', async () => {
    const { ctx, media } = await bareRuntime()
    const dispose = media.register(stubProvider({
      id: 'vanishing',
      submit: async request => ({
        id: 'vanishing-1', provider: 'vanishing', model: request.model ?? 'vanishing/video', kind: 'video', status: 'running',
      }),
      poll: async (task) => {
        dispose()
        return task
      },
    }))
    await expect(media.generate({ kind: 'video', prompt: 'x', model: 'vanishing/video' }, new AbortController().signal))
      .rejects.toThrow(/disappeared while task/)
    await ctx.fiber.dispose()

    const second = await bareRuntime()
    second.media.register(stubProvider({
      id: 'hanging',
      submit: async request => ({
        id: 'hanging-1', provider: 'hanging', model: request.model ?? 'hanging/video', kind: 'video', status: 'running',
      }),
      poll: async task => task,
    }))
    const aborted = new AbortController()
    aborted.abort()
    await expect(second.media.generate({ kind: 'video', prompt: 'x', model: 'hanging/video' }, aborted.signal)).rejects.toThrow()
    await second.ctx.fiber.dispose()
  })

  it('gives synthetic speech deterministic caption lines only when asked', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(new SyntheticMediaProvider())
    const captioned = await media.submit(
      { kind: 'speech', prompt: '一二三四五六七八九十一二 ', subtitles: true },
      new AbortController().signal,
    )
    expect(captioned.artifacts?.[0]?.subtitles).toEqual([
      { text: '一二三四五六七八九十一二', startSec: 0, endSec: 2 },
    ])
    const gapped = await media.submit(
      { kind: 'speech', prompt: `${'甲'.repeat(12)}${' '.repeat(12)}乙`, subtitles: true },
      new AbortController().signal,
    )
    expect(gapped.artifacts?.[0]?.subtitles).toEqual([
      { text: '甲'.repeat(12), startSec: 0, endSec: 1.5 },
      { text: '乙', startSec: 1.5, endSec: 3 },
    ])
    const plain = await media.submit({ kind: 'speech', prompt: '你好' }, new AbortController().signal)
    expect(plain.artifacts?.[0]?.subtitles).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('retained tasks', () => {
  it('returns terminal tasks unchanged from refresh and cancel', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'settled',
      submit: async request => ({
        id: 'settled-1', provider: 'settled', model: request.model ?? 'settled/video', kind: 'video', status: 'succeeded',
      }),
    }))
    const task = await media.submit({ kind: 'video', prompt: 'x', model: 'settled/video' }, new AbortController().signal)
    expect(await media.refresh(task.id, new AbortController().signal)).toEqual(task)
    expect(await media.cancel(task.id)).toEqual(task)
    await ctx.fiber.dispose()
  })

  it('fails refresh when its provider is gone and cancels without one', async () => {
    const { ctx, media } = await bareRuntime()
    const release = media.register(stubProvider({
      id: 'short-lived',
      submit: async request => ({
        id: 'short-lived-1', provider: 'short-lived', model: request.model ?? 'short-lived/video', kind: 'video', status: 'running',
      }),
    }))
    const running = await media.submit({ kind: 'video', prompt: 'x', model: 'short-lived/video' }, new AbortController().signal)
    release()
    await expect(media.refresh(running.id, new AbortController().signal)).rejects.toThrow(/no longer registered/)
    expect((await media.cancel(running.id)).status).toBe('cancelled')
    await ctx.fiber.dispose()
  })

  it('evicts the oldest settled task at the retention cap', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: true, maxTasks: 1, pollMs: 1 }).await()
    const first = await ctx.media.submit({ kind: 'image', prompt: 'one' }, new AbortController().signal)
    await delay(2)
    await ctx.media.submit({ kind: 'image', prompt: 'two' }, new AbortController().signal)
    expect(() => ctx.media.status(first.id)).toThrow(/unknown media task/)
    expect(ctx.media.nextTaskId('p', 'video')).toBe('p-video-1')
    await ctx.fiber.dispose()
  })
})

describe('cost estimation', () => {
  it('prices image, video, video-second, and 1000-character units', () => {
    const image: MediaModel = { id: 'i', kind: 'image', provider: 'p', price: { amountMinor: 3, currency: 'CNY', unit: 'image' } }
    const perVideo: MediaModel = { id: 'pv', kind: 'video', provider: 'p', price: { amountMinor: 29, currency: 'USD', unit: 'video' } }
    const video: MediaModel = { id: 'v', kind: 'video', provider: 'p', price: { amountMinor: 5, currency: 'CNY', unit: 'video-second' } }
    const speech: MediaModel = { id: 's', kind: 'speech', provider: 'p', price: { amountMinor: 2, currency: 'CNY', unit: '1000-chars' } }
    expect(estimateCost(image, { kind: 'image', prompt: 'x' })).toEqual({ amountMinor: 3, currency: 'CNY' })
    expect(estimateCost(perVideo, { kind: 'video', prompt: 'x', durationSec: 30 })).toEqual({ amountMinor: 29, currency: 'USD' })
    expect(estimateCost(video, { kind: 'video', prompt: 'x', durationSec: 3 })).toEqual({ amountMinor: 15, currency: 'CNY' })
    expect(estimateCost(video, { kind: 'video', prompt: 'x' })).toEqual({ amountMinor: 5, currency: 'CNY' })
    expect(estimateCost(speech, { kind: 'speech', prompt: 'x'.repeat(2500) })).toEqual({ amountMinor: 6, currency: 'CNY' })
    expect(estimateCost({ id: 'n', kind: 'video', provider: 'p' }, { kind: 'video', prompt: 'x' })).toBeUndefined()
  })
})

describe('synthetic provider', () => {
  it('estimates known and unknown models', () => {
    const provider = new SyntheticMediaProvider()
    expect(provider.estimate({ kind: 'image', prompt: 'x', model: SYNTHETIC_IMAGE_MODEL }).confidence).toBe('exact')
    expect(provider.estimate({ kind: 'video', prompt: 'x', model: SYNTHETIC_VIDEO_MODEL, durationSec: 2 }).durationSec).toBe(2)
    expect(provider.estimate({ kind: 'image', prompt: 'x', model: 'missing' })).toEqual({ confidence: 'unknown' })
  })

  it('honors latency, aborts, and reports an unknown model', async () => {
    const provider = new SyntheticMediaProvider(2)
    await expect(provider.submit(
      { kind: 'video', prompt: 'x', model: 'missing' },
      new AbortController().signal,
    )).rejects.toThrow(/no model/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(provider.submit(
      { kind: 'video', prompt: 'x', model: SYNTHETIC_VIDEO_MODEL },
      aborted.signal,
    )).rejects.toThrow()
  })

  it('settles speech with an explicit and a derived duration', async () => {
    const provider = new SyntheticMediaProvider()
    const explicit = await provider.submit(
      { kind: 'speech', prompt: 'short', model: SYNTHETIC_SPEECH_MODEL, durationSec: 3 },
      new AbortController().signal,
    )
    expect(explicit.artifacts?.[0]?.durationSec).toBe(3)
    const derived = await provider.submit(
      { kind: 'speech', prompt: 'x'.repeat(30), model: SYNTHETIC_SPEECH_MODEL },
      new AbortController().signal,
    )
    expect(derived.artifacts?.[0]?.durationSec).toBe(3)
    const task: MediaTask = { id: 't', provider: SYNTHETIC_PROVIDER_ID, model: SYNTHETIC_VIDEO_MODEL, kind: 'video', status: 'running' }
    expect(await provider.poll(task)).toEqual(task)
    await provider.cancel()
  })
})

describe('media runtime remaining branches', () => {
  it('passes a MediaFailure from a provider submit through unchanged', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'typed',
      submit: async () => { throw new MediaFailure('typed failure', 'MEDIA_REQUEST_INVALID') },
    }))
    await expect(media.submit({ kind: 'video', prompt: 'x', model: 'typed/video' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MEDIA_REQUEST_INVALID' })
    await ctx.fiber.dispose()
  })

  it('cancels a running task through its registered provider', async () => {
    const { ctx, media } = await bareRuntime()
    let cancelled = 0
    media.register(stubProvider({
      id: 'live',
      submit: async request => ({ id: 'live-1', provider: 'live', model: request.model ?? 'live/video', kind: 'video', status: 'running' }),
      cancel: async () => { cancelled += 1 },
    }))
    const task = await media.submit({ kind: 'video', prompt: 'x', model: 'live/video' }, new AbortController().signal)
    expect((await media.cancel(task.id)).status).toBe('cancelled')
    expect(cancelled).toBe(1)
    await ctx.fiber.dispose()
  })

  it('exhausts the eviction scan when no retained task is terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, maxTasks: 1 }).await()
    let index = 0
    ctx.media.register(stubProvider({
      id: 'running',
      submit: async (request) => {
        index += 1
        return { id: `running-${index}`, provider: 'running', model: request.model ?? 'running/video', kind: 'video', status: 'running' }
      },
    }))
    await ctx.media.submit({ kind: 'video', prompt: 'one', model: 'running/video' }, new AbortController().signal)
    await ctx.media.submit({ kind: 'video', prompt: 'two', model: 'running/video' }, new AbortController().signal)
    expect(ctx.media.status('running-2').status).toBe('running')
    await ctx.fiber.dispose()
  })

  it('estimates and submits an unpriced synthetic model', async () => {
    const provider = new SyntheticMediaProvider()
    Object.defineProperty(provider, 'modelsById', {
      value: [{ id: 'free/image', kind: 'image', provider: SYNTHETIC_PROVIDER_ID }],
    })
    expect(provider.estimate({ kind: 'image', prompt: 'x', model: 'free/image' }))
      .toEqual({ confidence: 'exact' })
    const task = await provider.submit({ kind: 'image', prompt: 'x', model: 'free/image' }, new AbortController().signal)
    expect(task.cost).toBeUndefined()
  })
})

describe('runtime and synthetic default branches', () => {
  it('estimates a video request with the default synthetic duration', () => {
    const provider = new SyntheticMediaProvider()
    expect(provider.estimate({ kind: 'video', prompt: 'x', model: SYNTHETIC_VIDEO_MODEL }))
      .toMatchObject({ durationSec: 1 })
  })
})

describe('cloud credential resolution', () => {
  it('resolves an environment key, a stored key, and rejects an empty stored value', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.MINIMAX_API_KEY
    const authorizations: (string | null)[] = []
    globalThis.fetch = async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return new Response(JSON.stringify({ task_id: 't-1' }), { status: 200 })
    }
    try {
      process.env.MINIMAX_API_KEY = 'sk-env'
      const environment = new Context()
      await environment.plugin(VideoMode, {
        fakeProvider: false,
        videoModel: 'MiniMax-H3',
        minimax: { enabled: true, apiKeyEnv: 'MINIMAX_API_KEY' },
      }).await()
      await environment.media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
      expect(authorizations[0]).toBe('Bearer sk-env')
      await environment.fiber.dispose()

      process.env.MINIMAX_API_KEY = ''
      const stored = new Context()
      stored.provide('credentials', {
        resolve: async (ref: string) => ref === 'EMPTY_KEY' ? { value: '', source: 'file' } : { value: 'sk-stored', source: 'file' },
      } as never)
      await stored.plugin(VideoMode, {
        fakeProvider: false,
        videoModel: 'MiniMax-H3',
        minimax: { enabled: true, apiKeyEnv: 'MINIMAX_API_KEY' },
      }).await()
      await stored.media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
      expect(authorizations[1]).toBe('Bearer sk-stored')
      await stored.fiber.dispose()

      const empty = new Context()
      empty.provide('credentials', {
        resolve: async () => ({ value: '', source: 'file' }),
      } as never)
      await empty.plugin(VideoMode, {
        fakeProvider: false,
        videoModel: 'MiniMax-H3',
        minimax: { enabled: true, apiKeyEnv: 'EMPTY_KEY' },
      }).await()
      await expect(empty.media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
        .rejects.toThrow(/EMPTY_KEY is not set/)
      await empty.fiber.dispose()
    } finally {
      globalThis.fetch = originalFetch
      if (originalKey === undefined) Reflect.deleteProperty(process.env, 'MINIMAX_API_KEY')
      else process.env.MINIMAX_API_KEY = originalKey
    }
  })
})

describe('task resumption', () => {
  /** One journal record for a stub video task. */
  function recordOf(overrides: Partial<MediaTaskRecord> = {}): MediaTaskRecord {
    return {
      task: { id: 'stub-video-1', provider: 'stub', model: 'stub/video', kind: 'video', status: 'running' },
      submittedAt: 1_000,
      request: { kind: 'video', model: 'stub/video', prompt: 'x', durationSec: 4 },
      outputPath: 'out/clip.mp4',
      ...overrides,
    }
  }

  it('resumes through the provider and prices the settlement in remember', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'stub',
      estimate: () => ({ cost: { amountMinor: 7, currency: 'CNY' }, confidence: 'exact' }),
      poll: async task => ({ ...task, status: 'succeeded' }),
      resume: record => record.task,
    }))

    const resumed = media.resume(recordOf())
    expect(resumed).toMatchObject({ id: 'stub-video-1', status: 'running' })
    expect(media.status('stub-video-1').status).toBe('running')
    expect(media.resume(recordOf()).id).toBe('stub-video-1')

    const settled = await media.refresh('stub-video-1', new AbortController().signal)
    expect(settled.cost).toEqual({ amountMinor: 7, currency: 'CNY' })
    await ctx.fiber.dispose()
  })

  it('tolerates a record whose model is no longer served and propagates other estimate failures', async () => {
    const { ctx, media } = await bareRuntime()
    media.register(stubProvider({
      id: 'stub',
      resume: record => record.task,
      poll: async task => ({ ...task, status: 'succeeded' }),
    }))
    const resumed = media.resume(recordOf({ request: { kind: 'video', model: 'gone/video', prompt: 'x' } }))
    expect(resumed.id).toBe('stub-video-1')
    const settled = await media.refresh('stub-video-1', new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(settled.cost).toBeUndefined()
    await ctx.fiber.dispose()

    const ctx2 = new Context()
    await ctx2.plugin(VideoMode, { fakeProvider: false }).await()
    ctx2.media.register(stubProvider({
      id: 'stub',
      estimate: () => { throw new Error('pricing down') },
      resume: record => record.task,
    }))
    expect(() => ctx2.media.resume(recordOf())).toThrow('pricing down')
    await ctx2.fiber.dispose()
  })

  it('reports a missing provider, an unsupported provider, and a rejected record', async () => {
    const { ctx, media } = await bareRuntime()
    expect(() => media.resume(recordOf())).toThrow(/provider "stub" is not registered/)

    media.register(stubProvider({ id: 'stub' }))
    expect(() => media.resume(recordOf())).toThrow(/cannot resume a task across a restart/)

    const wrongId = stubProvider({ id: 'stub', resume: () => ({ id: 'other', provider: 'stub', model: 'stub/video', kind: 'video', status: 'running' }) })
    const ctx2 = new Context()
    await ctx2.plugin(VideoMode, { fakeProvider: false }).await()
    ctx2.media.register(wrongId)
    expect(() => ctx2.media.resume(recordOf())).toThrow(/rejected the journal record/)
    await ctx2.fiber.dispose()

    expect(() => media.status('stub-video-1')).toThrow(/unknown media task/)
    await ctx.fiber.dispose()
  })
})
