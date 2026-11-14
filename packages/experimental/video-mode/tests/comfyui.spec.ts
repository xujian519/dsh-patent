/**
 * Tests of the local ComfyUI provider: workflow placeholder substitution,
 * canvas and frame math, submission through an injected fetch, history
 * settlement, timeout, cancellation, and config registration.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VideoMode, {
  COMFYUI_IMAGE_MODEL,
  COMFYUI_VIDEO_MODEL,
  ComfyUiMediaProvider,
  WAN22_TI2V_WORKFLOW,
  attachStartImage,
  canvasFor,
  fillWorkflow,
  frameCountFor,
  loadWorkflow,
  resolveComfyUi,
  shortSideOf,
  solidPng,
  type ComfyUiConfig,
  type FetchLike,
  type MediaTask,
  type MediaTaskRecord,
  type WorkflowValues,
} from '../src/index.ts'

/** One recorded provider request. */
interface Call {
  readonly url: string
  readonly method: string
  readonly body: string
}

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
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return route(call)
  }
  return { calls, fetchImpl }
}

/** Settings with short poll intervals for tests. */
function settingsOf(overrides: ComfyUiConfig = {}) {
  return resolveComfyUi({ enabled: true, pollMs: 1, ...overrides }, 64 * 1024 * 1024)
}

/** Values used by the fill tests. */
const VALUES: WorkflowValues = {
  prompt: 'a cat',
  negativePrompt: 'blurry',
  seed: 7,
  width: 480,
  height: 864,
  frames: 121,
  fps: 24,
  filenamePrefix: 'dsh/video',
  checkpoint: 'wan.safetensors',
  textEncoder: 'umt5.safetensors',
  vae: 'vae.safetensors',
}

describe('comfyui workflow filling', () => {
  it('replaces whole placeholders without changing their type', () => {
    const filled = fillWorkflow(WAN22_TI2V_WORKFLOW, VALUES)
    expect(filled['7']?.inputs.width).toBe(480)
    expect(filled['7']?.inputs.height).toBe(864)
    expect(filled['7']?.inputs.length).toBe(121)
    expect(filled['8']?.inputs.seed).toBe(7)
    expect(filled['10']?.inputs.fps).toBe(24)
    expect(filled['1']?.inputs.unet_name).toBe('wan.safetensors')
    expect(filled['4']?.inputs.text).toBe('a cat')
    expect(filled['5']?.inputs.text).toBe('blurry')
  })

  it('keeps unknown placeholders and substitutes inside longer strings', () => {
    const template = { '1': { class_type: 'X', inputs: { a: '{{missing}}', b: 'prefix-{{prompt}}' } } }
    const filled = fillWorkflow(template, VALUES)
    expect(filled['1']?.inputs.a).toBe('{{missing}}')
    expect(filled['1']?.inputs.b).toBe('prefix-a cat')
  })

  it('wires a first frame into the Wan latent node', () => {
    const attached = attachStartImage(fillWorkflow(WAN22_TI2V_WORKFLOW, VALUES), 'frame.png')
    expect(attached['7']?.inputs.start_image).toEqual(['12', 0])
    expect(attached['12']?.class_type).toBe('LoadImage')
    expect(attached['12']?.inputs.image).toBe('frame.png')
    expect(() => attachStartImage({ '1': { class_type: 'X', inputs: {} } }, 'frame.png'))
      .toThrow(/no Wan22ImageToVideoLatent/)
  })
})

describe('comfyui canvas math', () => {
  it('computes portrait, landscape, and square canvases on the pixel lattice', () => {
    expect(canvasFor('9:16', 480, 32)).toEqual({ width: 480, height: 864 })
    expect(canvasFor('16:9', 480, 32)).toEqual({ width: 864, height: 480 })
    expect(canvasFor('1:1', 480, 32)).toEqual({ width: 480, height: 480 })
    expect(() => canvasFor('4:3', 480, 32)).toThrow(/Unsupported aspect ratio/)
  })

  it('rounds frames onto the length lattice', () => {
    expect(frameCountFor(5, 24)).toBe(121)
    expect(frameCountFor(10, 24)).toBe(241)
    expect(frameCountFor(0.1, 24)).toBe(1)
  })

  it('parses resolution labels and rejects malformed ones', () => {
    expect(shortSideOf('480p')).toBe(480)
    expect(shortSideOf('720p')).toBe(720)
    expect(() => shortSideOf('480')).toThrow(/Unsupported resolution/)
    expect(() => shortSideOf('1080')).toThrow(/Unsupported resolution/)
  })
})

describe('comfyui provider', () => {
  it('submits a Wan workflow with typed canvas and duration values', async () => {
    const { calls, fetchImpl } = recorder(() => json({ prompt_id: 'prompt-1' }))
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const task = await provider.submit(
      { kind: 'video', prompt: 'a cat', durationSec: 5, aspectRatio: '9:16', seed: 7 },
      new AbortController().signal,
    )
    expect(task).toMatchObject({ provider: 'comfyui', model: COMFYUI_VIDEO_MODEL, kind: 'video', status: 'submitted' })
    expect(task.id).toBe('comfyui-prompt-1')
    const body = calls[0]?.body ?? ''
    expect(body).toContain('"width":480')
    expect(body).toContain('"height":864')
    expect(body).toContain('"length":121')
    expect(body).toContain('"seed":7')
    expect(body).toContain('"text":"a cat"')
    expect(body).toContain('wan2.2_ti2v_5B_fp16.safetensors')
    expect(body).toContain('"filename_prefix":"dsh/video"')
  })

  it('submits an image workflow at the configured long side', async () => {
    const { calls, fetchImpl } = recorder(() => json({ prompt_id: 'prompt-2' }))
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const task = await provider.submit(
      { kind: 'image', prompt: 'a lantern', aspectRatio: '16:9' },
      new AbortController().signal,
    )
    expect(task.model).toBe(COMFYUI_IMAGE_MODEL)
    const body = calls[0]?.body ?? ''
    expect(body).toContain('"width":1024')
    expect(body).toContain('"height":576')
    expect(body).toContain('qwen_3_4b.safetensors')
    expect(body).toContain('SaveImage')
  })

  it('settles a running task and downloads its video', async () => {
    let historyPolls = 0
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-1' })
      if (call.url.includes('/history/')) {
        historyPolls += 1
        if (historyPolls === 1) return json({})
        return json({
          'prompt-1': {
            status: { status_str: 'success', completed: true },
            outputs: { '11': { images: [{ filename: 'dsh_video_00001_.mp4', subfolder: 'dsh/video', type: 'output' }] } },
          },
        })
      }
      if (call.url.includes('/queue')) return json({ queue_running: [['1', 'prompt-1']], queue_pending: [] })
      if (call.url.includes('/view')) return new Response(MP4, { status: 200 })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const submitted = await provider.submit({ kind: 'video', prompt: 'a cat', durationSec: 5 }, new AbortController().signal)
    const running = await provider.poll(submitted, new AbortController().signal)
    expect(running.status).toBe('running')
    await delay(3)
    const done = await provider.poll(running, new AbortController().signal)
    expect(done.status).toBe('succeeded')
    expect(done.artifacts?.[0]).toMatchObject({ kind: 'video', mediaType: 'video/mp4', width: 480, height: 864, durationSec: 5 })
    expect(done.artifacts?.[0]?.bytes).toEqual(MP4)
    expect(calls.some(call => call.url.includes('/view?filename=dsh_video_00001_.mp4'))).toBe(true)
  })

  it('reports a workflow execution error as a failed task', async () => {
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-3' })
      if (call.url.includes('/history/')) {
        return json({
          'prompt-3': {
            status: {
              status_str: 'error',
              completed: false,
              messages: [['execution_error', { exception_message: 'MPS backend failed' }]],
            },
            outputs: {},
          },
        })
      }
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const submitted = await provider.submit({ kind: 'video', prompt: 'a cat' }, new AbortController().signal)
    await delay(3)
    const failed = await provider.poll(submitted, new AbortController().signal)
    expect(failed.status).toBe('failed')
    expect(failed.error?.message).toContain('MPS backend failed')
  })

  it('fails a task that exceeds the configured timeout', async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-4' })
      if (call.url.endsWith('/queue') || call.url.endsWith('/interrupt')) return new Response('{}', { status: 200 })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf({ timeoutMs: 1 }), fetchImpl)
    const submitted = await provider.submit({ kind: 'video', prompt: 'a cat' }, new AbortController().signal)
    await delay(5)
    const failed = await provider.poll(submitted, new AbortController().signal)
    expect(failed.status).toBe('failed')
    expect(failed.error?.code).toBe('MEDIA_TASK_TIMEOUT')
    expect(calls.some(call => call.url.endsWith('/interrupt'))).toBe(true)
  })

  it('cancels through the queue and interrupt endpoints', async () => {
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-5' })
      if (call.url.endsWith('/queue') || call.url.endsWith('/interrupt')) return new Response('{}', { status: 200 })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const submitted: MediaTask = await provider.submit({ kind: 'video', prompt: 'a cat' }, new AbortController().signal)
    await provider.cancel(submitted)
    const deletion = calls.find(call => call.url.endsWith('/queue'))
    expect(deletion?.body).toContain('prompt-5')
    const interruption = calls.find(call => call.url.endsWith('/interrupt'))
    expect(interruption?.body).toContain('prompt-5')
  })

  it('reports a task that ComfyUI stopped tracking', async () => {
    const { fetchImpl } = recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-6' })
      if (call.url.includes('/history/')) return json({})
      if (call.url.includes('/queue')) return json({ queue_running: [], queue_pending: [] })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const submitted = await provider.submit({ kind: 'video', prompt: 'a cat' }, new AbortController().signal)
    const failed = await provider.poll(submitted, new AbortController().signal)
    expect(failed.status).toBe('failed')
    expect(failed.error?.message).toContain('no longer reports')
  })

  it('uploads a first-frame image before submitting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-video-frame-'))
    const frame = join(directory, 'frame.png')
    await writeFile(frame, solidPng(8, 8, 200, 30, 30))
    try {
      const { calls, fetchImpl } = recorder((call) => {
        if (call.url.endsWith('/upload/image')) return json({ name: 'frame.png', subfolder: '', type: 'input' })
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'prompt-frame' })
        throw new Error(`unexpected request ${call.url}`)
      })
      const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
      const task = await provider.submit(
        { kind: 'video', prompt: 'a cat', references: [{ kind: 'image', role: 'first-frame', path: frame }] },
        new AbortController().signal,
      )
      expect(task.status).toBe('submitted')
      expect(calls[0]?.url).toContain('/upload/image')
      expect(calls[0]?.method).toBe('POST')
      const body = calls[1]?.body ?? ''
      expect(body).toContain('"LoadImage"')
      expect(body).toContain('"start_image":["12",0]')
      expect(body).toContain('"image":"frame.png"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('surfaces a rejected workflow with node diagnostics', async () => {
    const { fetchImpl } = recorder(() => json({ error: { message: 'Prompt outputs failed validation' } }, 400))
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    await expect(provider.submit({ kind: 'video', prompt: 'a cat' }, new AbortController().signal))
      .rejects.toThrow(/Prompt outputs failed validation/)
  })
})

describe('comfyui configuration', () => {
  it('applies defaults and rejects invalid bounds', () => {
    const settings = settingsOf()
    expect(settings.baseUrl).toBe('http://127.0.0.1:8188')
    expect(settings.video.model).toBe(COMFYUI_VIDEO_MODEL)
    expect(settings.video.resolution).toBe('480p')
    expect(settings.image.size).toBe(1024)
    expect(() => settingsOf({ video: { fps: 0 } })).toThrow(/fps/)
    expect(() => settingsOf({ baseUrl: ' ' })).toThrow(/baseUrl/)
    expect(() => settingsOf({ video: { resolution: '480' } })).toThrow(/resolution/)
    expect(() => settingsOf({ video: { defaultDurationSec: 20, maxDurationSec: 10 } })).toThrow(/maxDurationSec/)
  })

  it('registers the provider models when enabled', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, comfyui: { enabled: true } }).await()
    expect(ctx.media.models('video').map(model => model.id)).toEqual([COMFYUI_VIDEO_MODEL])
    expect(ctx.media.models('image').map(model => model.id)).toEqual([COMFYUI_IMAGE_MODEL])
    await ctx.fiber.dispose()
  })

  it('polls a submitted task through the runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(VideoMode, { fakeProvider: false, videoModel: 'stub/video' }).await()
    let polls = 0
    ctx.media.register({
      id: 'stub',
      capabilities: ['video'],
      models: () => [{
        id: 'stub/video',
        kind: 'video',
        provider: 'stub',
        price: { amountMinor: 1, currency: 'CNY', unit: 'video-second' },
      }],
      available: () => true,
      estimate: () => ({ confidence: 'exact' }),
      submit: async request => ({ id: 'stub-1', provider: 'stub', model: 'stub/video', kind: request.kind, status: 'submitted' }),
      poll: async (task) => {
        polls += 1
        return { ...task, status: 'succeeded' }
      },
      cancel: async () => {},
    })
    const submitted = await ctx.media.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    expect(submitted.status).toBe('submitted')
    const settled = await ctx.media.refresh(submitted.id, new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(polls).toBe(1)
    await ctx.fiber.dispose()
  })
})

describe('comfyui workflow files', () => {
  it('fills nested objects and arrays', () => {
    const template = {
      '1': { class_type: 'X', inputs: { nested: { seed: '{{seed}}', list: ['{{prompt}}', 7] } } },
    }
    expect(fillWorkflow(template, VALUES)['1']?.inputs.nested).toEqual({ seed: 7, list: ['a cat', 7] })
  })

  it('loads a valid file and rejects a missing, non-JSON, or malformed workflow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-comfy-workflow-'))
    try {
      const valid = join(directory, 'valid.json')
      await writeFile(valid, JSON.stringify({ '1': { class_type: 'X', inputs: {} } }))
      expect(loadWorkflow(valid, {})).toEqual({ '1': { class_type: 'X', inputs: {} } })
      expect(() => loadWorkflow(join(directory, 'missing.json'), {})).toThrow(/cannot read/)
      const broken = join(directory, 'broken.json')
      await writeFile(broken, '{')
      expect(() => loadWorkflow(broken, {})).toThrow(/is not JSON/)
      const malformed = join(directory, 'malformed.json')
      await writeFile(malformed, JSON.stringify({ '1': { inputs: {} } }))
      expect(() => loadWorkflow(malformed, {})).toThrow(/not an API-format workflow/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('comfyui request validation', () => {
  it('estimates video, image, and unsupported kinds', () => {
    const provider = new ComfyUiMediaProvider(settingsOf())
    expect(provider.estimate({ kind: 'video', prompt: 'x' }).durationSec).toBe(5)
    expect(provider.estimate({ kind: 'video', prompt: 'x', durationSec: 99 }).durationSec).toBe(10)
    expect(provider.estimate({ kind: 'image', prompt: 'x' }).cost?.amountMinor).toBe(0)
    expect(provider.estimate({ kind: 'speech', prompt: 'x' })).toEqual({ confidence: 'unknown' })
  })

  it('rejects speech, unknown models, an invalid duration, duplicate frames, and image references', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder(() => json({ prompt_id: 'p' })).fetchImpl)
    const signal = new AbortController().signal
    await expect(provider.submit({ kind: 'speech', prompt: 'x' }, signal)).rejects.toThrow(/does not serve speech/)
    await expect(provider.submit({ kind: 'video', prompt: 'x', model: 'other' }, signal)).rejects.toThrow(/serves no video model/)
    await expect(provider.submit({ kind: 'video', prompt: 'x', durationSec: 0 }, signal)).rejects.toThrow(/duration must be positive/)
    await expect(provider.submit({
      kind: 'video', prompt: 'x',
      references: [
        { kind: 'image', role: 'first-frame', path: '/tmp/a.png' },
        { kind: 'image', role: 'first-frame', path: '/tmp/b.png' },
      ],
    }, signal)).rejects.toThrow(/one first-frame reference/)
    await expect(provider.submit({
      kind: 'image', prompt: 'x',
      references: [{ kind: 'image', role: 'first-frame', path: '/tmp/a.png' }],
    }, signal)).rejects.toThrow(/references to video requests only/)
  })

  it('renders portrait and square image canvases and rejects an unsupported ratio', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder(() => json({ prompt_id: 'p' })).fetchImpl)
    const signal = new AbortController().signal
    await provider.submit({ kind: 'image', prompt: 'x', aspectRatio: '9:16' }, signal)
    await provider.submit({ kind: 'image', prompt: 'x', aspectRatio: '16:9' }, signal)
    await provider.submit({ kind: 'image', prompt: 'x', aspectRatio: '1:1' }, signal)
    await expect(provider.submit({ kind: 'image', prompt: 'x', aspectRatio: '4:3' }, signal)).rejects.toThrow(/Unsupported aspect ratio/)
  })

  it('reports an upload that cannot be read, rejected, or unnamed, and keeps a subfolder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-comfy-upload-'))
    try {
      const frame = join(directory, 'frame.png')
      await writeFile(frame, solidPng(2, 2, 1, 1, 1))
      const submit = (fetchImpl: FetchLike, path = frame) => new ComfyUiMediaProvider(settingsOf(), fetchImpl)
        .submit({ kind: 'video', prompt: 'x', references: [{ kind: 'image', role: 'first-frame', path }] }, new AbortController().signal)

      await expect(submit(recorder(() => json({})).fetchImpl, join(directory, 'missing.png')))
        .rejects.toThrow(/cannot read the first-frame image/)
      await expect(submit(recorder(() => json({}, 500)).fetchImpl)).rejects.toThrow(/rejected the first-frame upload/)
      await expect(submit(recorder(() => json({})).fetchImpl)).rejects.toThrow(/without returning a file name/)

      const { calls, fetchImpl } = recorder((call) => {
        if (call.url.endsWith('/upload/image')) return json({ name: 'frame.png', subfolder: 'inputs' })
        return json({ prompt_id: 'p' })
      })
      await submit(fetchImpl)
      expect(calls[1]?.body).toContain('"image":"inputs/frame.png"')

      const unsafe = recorder((call) => {
        if (call.url.endsWith('/upload/image')) return json({ name: '../secret.png', subfolder: '' })
        return json({ prompt_id: 'p' })
      })
      await expect(submit(unsafe.fetchImpl)).rejects.toThrow(/single path segment/)
      expect(unsafe.calls.some(call => call.url.endsWith('/prompt'))).toBe(false)
      const dotdot = recorder((call) => {
        if (call.url.endsWith('/upload/image')) return json({ name: 'frame.png', subfolder: '..' })
        return json({ prompt_id: 'p' })
      })
      await expect(submit(dotdot.fetchImpl)).rejects.toThrow(/single path segment/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('comfyui settlement edge cases', () => {
  /** Submit one task and poll it against a fixed history entry. */
  async function settleWith(entry: unknown, options: { readonly kind?: 'video' | 'image'; readonly maxArtifactBytes?: number } = {}): Promise<MediaTask> {
    const kind = options.kind ?? 'video'
    const provider = new ComfyUiMediaProvider(
      resolveComfyUi({ enabled: true, pollMs: 1 }, options.maxArtifactBytes ?? 64 * 1024 * 1024),
      recorder((call) => {
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
        if (call.url.includes('/history/')) return json({ p: entry })
        if (call.url.includes('/view')) return new Response(MP4, { status: 200 })
        throw new Error(`unexpected ${call.url}`)
      }).fetchImpl,
    )
    const task = await provider.submit({ kind, prompt: 'x', durationSec: 1 }, new AbortController().signal)
    return provider.poll(task, new AbortController().signal)
  }

  it('reports malformed and incomplete history entries', async () => {
    expect((await settleWith('not a record')).error?.message).toContain('malformed history entry')
    expect((await settleWith({ status: { status_str: 'error' } })).error?.message).toContain('workflow error')
    expect((await settleWith({ status: { completed: false } })).status).toBe('running')
    expect((await settleWith({ status: { completed: true }, outputs: {} })).error?.code).toBe('MEDIA_ARTIFACT_INVALID')
  })

  it('collects saved files from malformed output nodes', async () => {
    const settled = await settleWith({
      status: { completed: true },
      outputs: {
        a: 'not a node',
        b: { images: 'not an array', values: ['not a record', { filename: 7 }] },
        c: { images: [{ filename: 'clip.mp4' }] },
      },
    })
    expect(settled.status).toBe('succeeded')
    expect(settled.artifacts?.[0]?.mediaType).toBe('video/mp4')
  })

  it('maps execution errors, including an empty execution_error payload', async () => {
    const empty = await settleWith({ status: { status_str: 'error', messages: [['execution_error', { exception_message: '  ' }]] } })
    expect(empty.error?.message).toContain('workflow error')
    const noisy = await settleWith({
      status: {
        status_str: 'error',
        messages: ['not an array', ['other', {}], ['execution_error', 'not a record'], ['execution_error', { exception_message: 'engine failed' }]],
      },
    })
    expect(noisy.error?.message).toBe('engine failed')
  })

  it('downloads every preferred video and image extension with its media type', async () => {
    const cases: readonly (readonly ['video' | 'image', string, string])[] = [
      ['video', 'a.mp4', 'video/mp4'],
      ['video', 'a.webm', 'video/webm'],
      ['video', 'a.mkv', 'video/x-matroska'],
      ['image', 'a.png', 'image/png'],
      ['image', 'a.jpg', 'image/jpeg'],
      ['image', 'a.jpeg', 'image/jpeg'],
      ['image', 'a.webp', 'image/webp'],
    ]
    for (const [kind, filename, mediaType] of cases) {
      const settled = await settleWith({
        status: { completed: true },
        outputs: { node: { images: [{ filename, subfolder: 'sub', type: 'output' }] } },
      }, { kind })
      expect(settled.artifacts?.[0]?.mediaType, filename).toBe(mediaType)
    }
  })

  it('fails a download with an HTTP error and both size caps', async () => {
    const provider = (view: () => Response, cap = 1024): ComfyUiMediaProvider => new ComfyUiMediaProvider(
      resolveComfyUi({ enabled: true, pollMs: 1 }, cap),
      recorder((call) => {
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
        if (call.url.includes('/history/')) {
          return json({ p: { status: { completed: true }, outputs: { node: { images: [{ filename: 'a.mp4' }] } } } })
        }
        return view()
      }).fetchImpl,
    )
    const run = async (view: () => Response, cap?: number): Promise<MediaTask> => {
      const instance = provider(view, cap)
      return instance.poll(await instance.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal), new AbortController().signal)
    }
    expect((await run(() => new Response('no', { status: 500 }))).error?.code).toBe('MEDIA_ARTIFACT_INVALID')
    expect((await run(() => new Response(new Uint8Array(4), { headers: { 'content-length': '2048' } }), 10)).error?.code)
      .toBe('MEDIA_ARTIFACT_TOO_LARGE')
    expect((await run(() => new Response(new Uint8Array(8)), 4)).error?.code).toBe('MEDIA_ARTIFACT_TOO_LARGE')
  })

  it('does not request a history file whose name leaves the output directory', async () => {
    const files = [
      { filename: '../secret.mp4', subfolder: '', type: 'output' },
      { filename: 'a.mp4', subfolder: '.', type: 'output' },
      { filename: 'a.mp4', subfolder: '', type: '' },
      { filename: 'a\\b.mp4', subfolder: '', type: 'output' },
      { filename: 'a.mp4', subfolder: 'dsh\\video', type: 'output' },
    ]
    for (const file of files) {
      const { calls, fetchImpl } = recorder((call) => {
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
        if (call.url.includes('/history/')) {
          return json({ p: { status: { completed: true }, outputs: { node: { images: [file] } } } })
        }
        return new Response(new Uint8Array([1, 2, 3, 4]))
      })
      const provider = new ComfyUiMediaProvider(resolveComfyUi({ enabled: true, pollMs: 1 }, 1024), fetchImpl)
      const settled = await provider.poll(
        await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal),
        new AbortController().signal,
      )
      expect(settled.error?.code).toBe('MEDIA_ARTIFACT_INVALID')
      expect(calls.some(call => call.url.includes('/view'))).toBe(false)
    }
  })

  it('fails a download whose body stream throws a non-Error', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      if (call.url.includes('/history/')) {
        return json({ p: { status: { completed: true }, outputs: { node: { images: [{ filename: 'a.mp4' }] } } } })
      }
      return new Response(new ReadableStream({
        start(controller) { controller.error('stream broken') },
      }))
    }).fetchImpl)
    const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    const settled = await provider.poll(task, new AbortController().signal)
    expect(settled.error).toEqual({ code: 'MEDIA_TASK_FAILED', message: 'stream broken' })
  })
})

describe('comfyui transport failures', () => {
  it('reports queue shapes that do not name the prompt', async () => {
    const shapes: readonly unknown[] = [
      'not a record',
      { queue_running: 'bad', queue_pending: 'bad' },
      { queue_running: ['bad'], queue_pending: [] },
      { queue_running: [], queue_pending: ['bad'] },
    ]
    for (const queue of shapes) {
      const provider = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
        if (call.url.includes('/history/')) return json({})
        return json(queue)
      }).fetchImpl)
      const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
      expect((await provider.poll(task, new AbortController().signal)).error?.message).toContain('no longer reports')
    }
  })

  it('returns queued and running states from the queue', async () => {
    for (const [queue, expected] of [
      [{ queue_running: [], queue_pending: [['1', 'p']] }, 'queued'],
      [{ queue_running: [['1', 'p']], queue_pending: [] }, 'running'],
    ] as const) {
      const provider = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
        if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
        if (call.url.includes('/history/')) return json({})
        return json(queue)
      }).fetchImpl)
      const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
      expect((await provider.poll(task, new AbortController().signal)).status).toBe(expected)
    }
  })

  it('reports non-success and invalid JSON from a status read', async () => {
    const rejected = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      return json({}, 500)
    }).fetchImpl)
    const first = await rejected.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    await expect(rejected.poll(first, new AbortController().signal)).rejects.toThrow(/returned HTTP 500/)

    const invalid = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      return new Response('not json', { status: 200 })
    }).fetchImpl)
    const second = await invalid.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    await expect(invalid.poll(second, new AbortController().signal)).rejects.toThrow(/returned invalid JSON/)
  })

  it('reports rejected prompt bodies by every diagnostic shape', async () => {
    const bodies: readonly unknown[] = [
      null,
      {},
      { error: { message: 'bad graph' } },
      { node_errors: { '3': { errors: [{ message: 'missing model' }] }, '4': 'bad' } },
      { node_errors: { '5': { errors: 'bad' } } },
    ]
    for (const body of bodies) {
      const provider = new ComfyUiMediaProvider(settingsOf(), recorder(() => json(body, 400)).fetchImpl)
      await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)).rejects.toThrow(/rejected the video workflow/)
    }
  })

  it('rejects a success body without a prompt id and a task id without the provider prefix', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder(() => new Response('', { status: 200 })).fetchImpl)
    await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/without returning a prompt id/)

    const plain = await provider.poll(
      { id: 'plain', provider: 'comfyui', model: COMFYUI_VIDEO_MODEL, kind: 'video', status: 'running' },
      new AbortController().signal,
    )
    expect(plain.error?.message).toContain('not tracked')
  })

  it('swallows cancellation transport failures', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      throw new Error('offline')
    }).fetchImpl)
    const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    await expect(provider.cancel(task)).resolves.toBeUndefined()
  })
})

describe('comfyui remaining branches', () => {
  it('wires a first frame into a workflow without numeric node ids', () => {
    const attached = attachStartImage({ latent: { class_type: 'Wan22ImageToVideoLatent', inputs: {} } }, 'a.png')
    expect(attached['1']?.class_type).toBe('LoadImage')
  })

  it('throttles a repeated history poll', async () => {
    let polls = 0
    const provider = new ComfyUiMediaProvider(settingsOf({ pollMs: 100 }), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      if (call.url.includes('/history/')) {
        polls += 1
        return json({})
      }
      return json({ queue_running: [['1', 'p']], queue_pending: [] })
    }).fetchImpl)
    const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    const running = await provider.poll(task, new AbortController().signal)
    expect(running.status).toBe('running')
    expect((await provider.poll(running, new AbortController().signal)).status).toBe('running')
    expect(polls).toBe(1)
  })

  it('handles non-object history and a missing status field', async () => {
    const arrayHistory = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      if (call.url.includes('/history/')) return json([])
      return json({ queue_running: [], queue_pending: [] })
    }).fetchImpl)
    const first = await arrayHistory.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    expect((await arrayHistory.poll(first, new AbortController().signal)).error?.message).toContain('no longer reports')

    const noStatus = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      return json({ p: { completed: true, outputs: { node: { images: [{ filename: 'a.mp4' }] } } } })
    }).fetchImpl)
    const second = await noStatus.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    expect((await noStatus.poll(second, new AbortController().signal)).status).toBe('running')
  })

  it('fails a completed entry with non-object outputs', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      return json({ p: { status: { completed: true }, outputs: 'bad' } })
    }).fetchImpl)
    const task = await provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    expect((await provider.poll(task, new AbortController().signal)).error?.code).toBe('MEDIA_ARTIFACT_INVALID')
  })

  it('ignores non-string execution errors and non-object node errors', async () => {
    const execution = new ComfyUiMediaProvider(settingsOf(), recorder((call) => {
      if (call.url.endsWith('/prompt')) return json({ prompt_id: 'p' })
      return json({ p: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 7 }]] } } })
    }).fetchImpl)
    const first = await execution.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal)
    expect((await execution.poll(first, new AbortController().signal)).error?.message).toContain('workflow error')

    const rejection = new ComfyUiMediaProvider(settingsOf(), recorder(() => json({
      node_errors: { '1': { errors: ['bad', { message: 'missing checkpoint' }] } },
    }, 400)).fetchImpl)
    await expect(rejection.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/node 1: missing checkpoint/)
  })

  it('uploads without a subfolder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-comfy-nosub-'))
    try {
      const frame = join(directory, 'frame.png')
      await writeFile(frame, solidPng(2, 2, 1, 1, 1))
      const { calls, fetchImpl } = recorder((call) => {
        if (call.url.endsWith('/upload/image')) return json({ name: 'frame.png' })
        return json({ prompt_id: 'p' })
      })
      const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
      await provider.submit({
        kind: 'video', prompt: 'x', references: [{ kind: 'image', role: 'first-frame', path: frame }],
      }, new AbortController().signal)
      expect(calls[1]?.body).toContain('"image":"frame.png"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('comfyui non-JSON success body', () => {
  it('reports a missing prompt id from a non-JSON success body', async () => {
    const provider = new ComfyUiMediaProvider(settingsOf(), recorder(() => new Response('not json', { status: 200 })).fetchImpl)
    await expect(provider.submit({ kind: 'video', prompt: 'x' }, new AbortController().signal))
      .rejects.toThrow(/without returning a prompt id/)
  })
})

describe('comfyui resumption', () => {
  /** One journal record for a ComfyUI prompt. */
  function record(overrides: Partial<MediaTaskRecord> = {}): MediaTaskRecord {
    return {
      task: { id: 'comfyui-prompt-9', provider: 'comfyui', model: COMFYUI_VIDEO_MODEL, kind: 'video', status: 'running' },
      submittedAt: Date.now(),
      request: { kind: 'video', model: COMFYUI_VIDEO_MODEL, prompt: 'a cat', durationSec: 2, aspectRatio: '9:16', resolution: '480p' },
      outputPath: 'shots/s01.mp4',
      ...overrides,
    }
  }

  it('resumes a video prompt and downloads its history file', async () => {
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes('/history/prompt-9')) {
        return json({
          'prompt-9': {
            status: { status_str: 'success', completed: true },
            outputs: { '11': { images: [{ filename: 'clip.mp4', subfolder: 'dsh/video', type: 'output' }] } },
          },
        })
      }
      if (call.url.includes('/view')) return new Response(MP4, { status: 200 })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const resumed = provider.resume(record())
    expect(resumed?.id).toBe('comfyui-prompt-9')

    const settled = await provider.poll(resumed as MediaTask, new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(settled.artifacts?.[0]).toMatchObject({ mediaType: 'video/mp4', width: 480, height: 864, durationSec: 2 })
    expect(settled.artifacts?.[0]?.bytes).toEqual(MP4)
  })

  it('resumes an image prompt with its stored canvas', async () => {
    const png = solidPng(4, 4, 1, 2, 3)
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes('/history/prompt-8')) {
        return json({
          'prompt-8': {
            status: { status_str: 'success', completed: true },
            outputs: { '9': { images: [{ filename: 'frame.png', subfolder: 'dsh/image', type: 'output' }] } },
          },
        })
      }
      if (call.url.includes('/view')) return new Response(new Uint8Array(png), { status: 200 })
      throw new Error(`unexpected request ${call.url}`)
    })
    const provider = new ComfyUiMediaProvider(settingsOf(), fetchImpl)
    const resumed = provider.resume(record({
      task: { id: 'comfyui-prompt-8', provider: 'comfyui', model: COMFYUI_IMAGE_MODEL, kind: 'image', status: 'running' },
      request: { kind: 'image', model: COMFYUI_IMAGE_MODEL, prompt: 'a cat', aspectRatio: '1:1' },
      outputPath: 'assets/frame.png',
    }))
    expect(resumed?.kind).toBe('image')

    const settled = await provider.poll(resumed as MediaTask, new AbortController().signal)
    expect(settled.status).toBe('succeeded')
    expect(settled.artifacts?.[0]).toMatchObject({ mediaType: 'image/png', width: 1024, height: 1024 })
  })

  it('ignores foreign records and rejects an unservable request', () => {
    const provider = new ComfyUiMediaProvider(settingsOf())
    const base = record()
    expect(provider.resume({ ...base, task: { ...base.task, provider: 'minimax' } })).toBeUndefined()
    expect(provider.resume({ ...base, task: { ...base.task, kind: 'speech' } })).toBeUndefined()
    expect(provider.resume({ ...base, task: { ...base.task, id: 'prompt-9' } })).toBeUndefined()
    const sparse = provider.resume({
      ...base,
      request: { ...base.request, durationSec: undefined, aspectRatio: undefined, resolution: undefined },
    })
    expect(sparse?.id).toBe('comfyui-prompt-9')
    expect(() => provider.resume({ ...base, request: { ...base.request, aspectRatio: '2:1' } }))
      .toThrow(/Unsupported aspect ratio/)
  })
})
