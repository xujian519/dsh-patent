/**
 * Model-facing tool behavior: argument guards, model and estimate rendering,
 * generation waiting and status settlement, project mutations, artifact
 * writing, assembly output overrides, and every delivery finding.
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import VideoMode, {
  forgetTask,
  ledgerCost,
  readLedger,
  readTaskRecords,
  recordTask,
  silentWav,
  solidPng,
  type MediaArtifact,
  type MediaModel,
  type MediaProvider,
  type MediaReference,
  type MediaRuntimeConfig,
} from '../src/index.ts'
import { derivedPath, subtitlePathOf, writeArtifact } from '../src/tools/shared.ts'

const FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const MP4 = new Uint8Array([0, 0, 0, 20, ...new TextEncoder().encode('ftyp'), 0, 0, 0, 0])
const PNG = solidPng(4, 4, 1, 2, 3)

let root: string
let originalCwd: string
let ctx: Context | undefined
let callId = 0
let agentId = 0

/** Boot a fresh tool-composition context in the shared workspace. */
async function boot(config: MediaRuntimeConfig = {}): Promise<Context> {
  const created = new Context()
  await created.plugin(SystemPrompt).await()
  await created.plugin(ToolsService).await()
  await created.plugin(LocalFileSystem, { cwd: root }).await()
  await created.plugin(LocalSubprocessRuntime).await()
  await created.plugin(SessionProjectionRegistry).await()
  await created.plugin(WorkingDirectory, { defaultDirectory: root }).await()
  await created.plugin(NativeToolExecutor).await()
  await created.plugin(VideoMode, { fakeProvider: true, waitMs: 50, pollMs: 1, approvalThresholdCny: 0.01, ...config }).await()
  ctx = created
  return created
}

/** A registered Agent with the minimum shape the tools read. */
async function agentOf(created: Context): Promise<Agent> {
  const scope = created.plugin(() => {})
  agentId += 1
  const id = SessionId(`video-tools-agent-${agentId}`)
  const value: Agent = {
    id,
    options: {},
    session: Session.create(id),
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return value
}

/** Run one model call and return the raw result. */
async function call(created: Context, name: string, args: Record<string, unknown>) {
  callId += 1
  const owner = await agentOf(created)
  return executeToolFixture(created, {
    signal: new AbortController().signal,
    callId: ToolCallId(`tools-${callId}`),
    name,
    arguments: args,
    agent: owner,
  })
}

/** Require a successful call and return its structured value. */
function valueOf(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  if (result.isError) throw new Error(`expected success: ${result.error.message}`)
  return result.value as Record<string, unknown>
}

/** Require a failed call and return its message. */
function errorOf(result: Awaited<ReturnType<typeof call>>): string {
  if (!result.isError) throw new Error('expected a failed call')
  return result.error.message
}

/** One stub provider with an explicit model table. */
function providerOf(options: {
  readonly id?: string
  readonly models: readonly MediaModel[]
  readonly estimate?: () => { readonly confidence: 'exact' | 'estimated' | 'unknown'; readonly cost?: { readonly amountMinor: number; readonly currency: 'CNY' | 'USD' }; readonly durationSec?: number }
  readonly submit?: MediaProvider['submit']
  readonly poll?: MediaProvider['poll']
  readonly resume?: MediaProvider['resume']
}): MediaProvider {
  const id = options.id ?? 'stub'
  return {
    id,
    capabilities: ['video', 'image', 'speech'],
    models: () => options.models,
    available: () => true,
    estimate: options.estimate ?? (() => ({ confidence: 'exact', cost: { amountMinor: 5, currency: 'CNY' } })),
    submit: options.submit ?? (async request => ({
      id: `${id}-task`, provider: id, model: request.model ?? options.models[0]?.id ?? '', kind: request.kind, status: 'submitted',
    })),
    poll: options.poll ?? (async task => ({ ...task, status: 'succeeded' })),
    cancel: async () => {},
    ...options.resume === undefined ? {} : { resume: options.resume },
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-tools-')))
  originalCwd = process.cwd()
  process.chdir(root)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await ctx?.fiber.dispose()
  ctx = undefined
  await rm(root, { recursive: true, force: true })
})

describe('media tool', () => {
  it('lists priced and unpriced models and renders estimates', async () => {
    const created = await boot()
    created.media.register(providerOf({
      models: [{ id: 'free/video', kind: 'video', provider: 'stub' }],
      estimate: () => ({ confidence: 'unknown' }),
    }))
    const models = valueOf(await call(created, 'media', { action: 'models' }))
    expect(String(models.message)).toContain('synthetic/video')
    expect(models.models).toBeInstanceOf(Array)
    const filtered = valueOf(await call(created, 'media', { action: 'models', kind: 'video' }))
    expect(String(filtered.message)).toContain('free/video')

    const estimate = valueOf(await call(created, 'media', {
      action: 'estimate', kind: 'image', prompt: 'x',
    }))
    expect(String(estimate.message)).toContain('Estimated')
    expect(estimate.estimate).toMatchObject({ confidence: 'exact' })

    const unknown = valueOf(await call(created, 'media', {
      action: 'estimate', kind: 'video', prompt: 'x', model: 'free/video',
    }))
    expect(String(unknown.message)).toContain('unknown cost')
  })

  it('guards estimate and generate arguments', async () => {
    const created = await boot()
    expect(errorOf(await call(created, 'media', { action: 'estimate', prompt: 'x' }))).toContain('requires `kind`')
    expect(errorOf(await call(created, 'media', { action: 'estimate', kind: 'image' }))).toContain('non-empty `prompt`')
    expect(errorOf(await call(created, 'media', {
      action: 'estimate', kind: 'video', prompt: 'x', subtitles: true,
    }))).toContain('`subtitles` for speech only')
    expect(errorOf(await call(created, 'media', { action: 'generate', kind: 'image', prompt: 'x' }))).toContain('requires `output_path`')
    expect(errorOf(await call(created, 'media', { action: 'status' }))).toContain('requires `task_id`')
    expect(errorOf(await call(created, 'media', { action: 'cancel' }))).toContain('requires `task_id`')
  })

  it('submits without waiting, polls status with and without an output path, and cancels', async () => {
    const created = await boot()
    let polls = 0
    created.media.register(providerOf({
      id: 'stub',
      models: [{ id: 'stub/video', kind: 'video', provider: 'stub' }],
      submit: async request => ({
        id: 'stub-video-1', provider: 'stub', model: request.model ?? 'stub/video', kind: request.kind, status: 'submitted',
      }),
      poll: async (task) => {
        polls += 1
        return polls === 1
          ? { ...task, status: 'running' }
          : { ...task, status: 'succeeded', artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }] }
      },
    }))
    const submitted = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'stub/video', output_path: 'out/clip.mp4', wait: false,
    }))
    expect(String(submitted.message)).toContain('Submitted video task')

    const running = valueOf(await call(created, 'media', { action: 'status', task_id: 'stub-video-1' }))
    expect(String(running.message)).toContain('is running')
    const settled = valueOf(await call(created, 'media', {
      action: 'status', task_id: 'stub-video-1', output_path: 'out/clip.mp4',
    }))
    expect(String(settled.message)).toContain('Wrote')
    expect((await stat(join(root, 'out/clip.mp4'))).size).toBe(MP4.length)
    const cancelled = valueOf(await call(created, 'media', { action: 'cancel', task_id: 'stub-video-1' }))
    expect(String(cancelled.message)).toContain('is succeeded')
  })

  it('reports a failed task and a cancelled task from generate', async () => {
    const created = await boot()
    const failed = providerOf({
      id: 'failed',
      models: [{ id: 'failed/video', kind: 'video', provider: 'failed' }],
      submit: async request => ({ id: 'f', provider: 'failed', model: request.model ?? '', kind: request.kind, status: 'failed', error: { code: 'X', message: 'provider exploded' } }),
    })
    const cancelled = providerOf({
      id: 'cancelled',
      models: [{ id: 'cancelled/video', kind: 'video', provider: 'cancelled' }],
      submit: async request => ({ id: 'c', provider: 'cancelled', model: request.model ?? '', kind: request.kind, status: 'cancelled' }),
    })
    created.media.register(failed)
    created.media.register(cancelled)
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'failed/video', output_path: 'out/a.mp4',
    }))).toContain('provider exploded')
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'cancelled/video', output_path: 'out/b.mp4',
    }))).toContain('was cancelled')
  })

  it('requires confirmation for a non-CNY estimate and writes multiple derived artifacts', async () => {
    const created = await boot()
    created.media.register(providerOf({
      id: 'usd',
      models: [{ id: 'usd/video', kind: 'video', provider: 'usd' }],
      estimate: () => ({ confidence: 'estimated', cost: { amountMinor: 1, currency: 'USD' } }),
      submit: async request => ({
        id: 'usd-1', provider: 'usd', model: request.model ?? '', kind: request.kind, status: 'succeeded',
        artifacts: [
          { id: 'a', kind: 'video', mediaType: 'video/mp4', bytes: MP4 },
          { id: 'b', kind: 'video', mediaType: 'video/mp4', bytes: MP4 },
        ],
      }),
    }))
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Usd' }))
    const projectPath = project.path as string
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'usd/video', output_path: 'out/a.mp4', project_path: projectPath,
    }))).toContain('not in CNY')
    const written = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'usd/video', output_path: 'out/a.mp4',
      project_path: projectPath, confirm_cost: true,
    }))
    expect(String(written.message)).toContain('out/a.mp4, ')
    expect((await stat(join(root, 'out/a-2.mp4'))).size).toBe(MP4.length)
  })

  it('passes a first frame to the provider and writes an extensionless artifact', async () => {
    const created = await boot()
    const frame = join(root, 'frame.png')
    await writeFile(frame, PNG)
    let seen: readonly MediaReference[] | undefined
    created.media.register(providerOf({
      id: 'frame',
      models: [{ id: 'frame/video', kind: 'video', provider: 'frame', referenceModes: ['image', 'first-frame'] }],
      submit: async (request) => {
        seen = request.references
        return {
          id: 'frame-1', provider: 'frame', model: request.model ?? '', kind: request.kind, status: 'succeeded',
          artifacts: [{ id: 'a', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
        }
      },
    }))
    const written = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'frame/video', output_path: 'out/no-extension', first_frame_path: 'frame.png',
    }))
    expect(seen?.[0]?.path).toBe(frame)
    expect(String(written.message)).toContain('out/no-extension')
    expect((await stat(join(root, 'out/no-extension'))).size).toBe(MP4.length)
  })

  it('writes a caption sidecar for speech with timed lines', async () => {
    const created = await boot()
    const result = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'speech', prompt: '第一句。第二句。还有第三句。', subtitles: true, output_path: 'out/narration.mp3',
    }))
    expect(String(result.message)).toContain('Captions:')
    const artifacts = result.artifacts as readonly { readonly path: string; readonly subtitlesPath?: string }[]
    expect(artifacts[0]?.subtitlesPath).toMatch(/narration\.srt$/)
    const srt = await readFile(join(root, 'out/narration.srt'), 'utf8')
    expect(srt).toMatch(/^1\n00:00:00,000 --> /)
    expect(srt).toContain('第一句。第二句。还有第')
  })

  it('writes a caption sidecar when status settles a speech task', async () => {
    const created = await boot()
    created.media.register(providerOf({
      id: 'speech-stub',
      models: [{ id: 'stub/speech', kind: 'speech', provider: 'speech-stub' }],
      submit: async request => ({
        id: 'stub-speech-1', provider: 'speech-stub', model: request.model ?? 'stub/speech', kind: request.kind, status: 'submitted',
      }),
      poll: async task => ({
        ...task,
        status: 'succeeded',
        artifacts: [{
          id: 'voice',
          kind: 'speech',
          mediaType: 'audio/wav',
          bytes: silentWav(1),
          durationSec: 1,
          subtitles: [{ text: '你好。', startSec: 0, endSec: 1 }],
        }],
      }),
    }))
    const submitted = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'speech', prompt: 'x', model: 'stub/speech', subtitles: true, output_path: 'out/voice.wav', wait: false,
    }))
    expect(String(submitted.message)).toContain('Submitted speech task')

    const settled = valueOf(await call(created, 'media', {
      action: 'status', task_id: 'stub-speech-1', output_path: 'out/voice.wav',
    }))
    expect(String(settled.message)).toContain('Captions:')
    expect(await readFile(join(root, 'out/voice.srt'), 'utf8')).toContain('你好。')
  })
})

describe('project tool', () => {
  it('guards required arguments and records a render', async () => {
    const created = await boot()
    expect(errorOf(await call(created, 'video_project', { action: 'init' }))).toContain('requires `title`')
    expect(errorOf(await call(created, 'video_project', { action: 'read' }))).toContain('requires `project_path`')
    expect(errorOf(await call(created, 'video_project', { action: 'upsert_shot', project_path: 'p.json' }))).toContain('requires `shot`')
    expect(errorOf(await call(created, 'video_project', { action: 'remove_shot', project_path: 'p.json' }))).toContain('requires `shot_id`')
    expect(errorOf(await call(created, 'video_project', { action: 'record_render', project_path: 'p.json' }))).toContain('requires `render`')

    const createdProject = valueOf(await call(created, 'video_project', { action: 'init', title: 'Recorded' }))
    const path = createdProject.path as string
    const recorded = valueOf(await call(created, 'video_project', {
      action: 'record_render', project_path: path, render: { id: 'r1', path: 'out/final.mp4', duration_sec: 12, cost_cny: 3 },
    }))
    expect(String(recorded.message)).toContain('1 renders')
    expect(errorOf(await call(created, 'video_project', {
      action: 'remove_shot', project_path: path, shot_id: 'missing',
    }))).toContain('does not exist')
  })
})

describe('artifact writing', () => {
  it('derives suffixed and caption paths', () => {
    expect(derivedPath('out/a.mp4', 0)).toBe('out/a.mp4')
    expect(derivedPath('out/a.mp4', 1)).toBe('out/a-2.mp4')
    expect(derivedPath('out/a', 1)).toBe('out/a-2')
    expect(subtitlePathOf('out/voice.mp3')).toBe('out/voice.srt')
    expect(subtitlePathOf('out/voice')).toBe('out/voice.srt')
  })

  it('rejects missing, empty, oversized, and mislabeled artifacts', async () => {
    const created = await boot()
    const signal = new AbortController().signal
    const write = (artifact: MediaArtifact, maxBytes = 1024): Promise<{ readonly path: string; readonly bytes: number }> =>
      writeArtifact(created, artifact, 'out/a.png', root, maxBytes, signal)
    await expect(write({ id: 'a', kind: 'image', mediaType: 'image/png' })).rejects.toThrow(/URL only/)
    await expect(write({ id: 'a', kind: 'image', mediaType: 'image/png', bytes: new Uint8Array() })).rejects.toThrow(/is empty/)
    await expect(write({ id: 'a', kind: 'image', mediaType: 'image/png', bytes: PNG }, 4)).rejects.toThrow(/above the configured/)
    await expect(write({ id: 'a', kind: 'image', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/bytes are not that format/)
    const written = await write({ id: 'a', kind: 'image', mediaType: 'image/png', bytes: PNG })
    expect(written.bytes).toBe(PNG.length)
  })
})

describe('assembly and delivery tools', () => {
  it('overrides the EDL output and reports absent probe fields', async () => {
    const script = join(root, 'fake-ffprobe.sh')
    await writeFile(script, '#!/bin/sh\necho \'{"streams":[]}\'\nexit 0\n')
    await chmod(script, 0o755)
    const created = await boot({ ffprobePath: script, ffmpegPath: script })
    const result = valueOf(await call(created, 'video_assemble', {
      edl: {
        version: 1,
        canvas: { width: 64, height: 96, fps: 12 },
        clips: [{ kind: 'color', color: '000000', durationSec: 0.1 }],
        output: 'out/ignored.mp4',
      },
      output: 'out/override.mp4',
    }))
    expect(result.output).toBe('out/override.mp4')
    expect(String(result.message)).toContain('unknown duration')
    expect(String(result.message)).toContain('?x?')
    expect(result.hasAudio).toBe(false)
  })

  it('keeps the EDL output and reports complete probe fields', async () => {
    const ffmpeg = join(root, 'complete-ffmpeg.sh')
    await writeFile(ffmpeg, '#!/bin/sh\nfor last; do :; done\necho rendered > "$last"\nexit 0\n')
    await chmod(ffmpeg, 0o755)
    const probe = join(root, 'complete-ffprobe.sh')
    await writeFile(probe, '#!/bin/sh\necho \'{"format":{"duration":"2.5"},"streams":[{"codec_type":"video","width":64,"height":96},{"codec_type":"audio"}]}\'\nexit 0\n')
    await chmod(probe, 0o755)
    const created = await boot({ ffprobePath: probe, ffmpegPath: ffmpeg })
    const result = valueOf(await call(created, 'video_assemble', {
      edl: {
        version: 1,
        canvas: { width: 64, height: 96, fps: 12 },
        clips: [{ kind: 'color', color: '000000', durationSec: 0.1 }],
        output: 'out/ep.mp4',
      },
    }))
    expect(result.output).toBe('out/ep.mp4')
    expect(result.durationSec).toBe(2.5)
    expect(result.width).toBe(64)
    expect(result.height).toBe(96)
    expect(String(result.message)).toContain('2.50s')
    expect(String(result.message)).toContain('with audio')
  })

  it('passes a clean delivery and blocks a shot without a selected clip', async () => {
    const probe = join(root, 'clean-ffprobe.sh')
    await writeFile(probe, '#!/bin/sh\necho \'{"format":{"duration":"1"},"streams":[{"codec_type":"video","width":64,"height":96},{"codec_type":"audio"}]}\'\nexit 0\n')
    await chmod(probe, 0o755)
    const created = await boot({ ffprobePath: probe })
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Clean', target_seconds: 2, budget_cny: 10 }))
    const path = project.path as string
    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's1', index: 1, prompt: 'x', duration_sec: 1, status: 'ready', clip_path: 'out/clean.mp4' },
    }))
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out/clean.mp4'), 'video bytes')
    const clean = valueOf(await call(created, 'video_deliver', {
      project_path: path, files: [{ path: 'out/clean.mp4', format: 'video' }],
    }))
    expect(clean.ok).toBe(true)
    expect(String(clean.message)).toContain('all checks passed')

    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's2', index: 2, prompt: 'y', duration_sec: 1, status: 'draft' },
    }))
    expect(errorOf(await call(created, 'video_deliver', {
      project_path: path, files: [{ path: 'out/clean.mp4', format: 'video' }],
    }))).toContain('shots without a selected clip: s2')
  })

  it.runIf(FFMPEG)('reports a complete probe for a real render', async () => {
    const created = await boot()
    const result = valueOf(await call(created, 'video_assemble', {
      edl: {
        version: 1,
        canvas: { width: 64, height: 96, fps: 12 },
        clips: [{ kind: 'color', color: '112233', durationSec: 0.25 }],
        output: 'out/real.mp4',
      },
    }))
    expect(Number(result.durationSec)).toBeGreaterThan(0)
    expect(result.width).toBe(64)
    expect(result.height).toBe(96)
    expect(result.hasAudio).toBe(true)
  })

  it('reports every delivery finding', async () => {
    const script = join(root, 'delivery-ffprobe.sh')
    await writeFile(script, [
      '#!/bin/sh',
      'case "$*" in',
      '  *empty*) echo \'{"format":{"duration":"1"},"streams":[]}\';;',
      '  *) echo \'{"format":{"duration":"20"},"streams":[{"codec_type":"video","width":64,"height":96}]}\';;',
      'esac',
      'exit 0',
      '',
    ].join('\n'))
    await chmod(script, 0o755)
    const created = await boot({ ffprobePath: script })
    const emptyProject = valueOf(await call(created, 'video_project', { action: 'init', title: 'Empty' }))
    expect(errorOf(await call(created, 'video_deliver', {
      project_path: emptyProject.path,
      files: [{ path: 'out/missing.mp4', format: 'video' }],
    }))).toContain('the project has no shots')

    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Findings', target_seconds: 2, budget_cny: 1 }))
    const path = project.path as string
    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's1', index: 1, prompt: 'x', duration_sec: 4, status: 'ready', clip_path: 'out/s1.mp4', cost_cny: 2 },
    }))
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out/empty.mp4'), '')
    await writeFile(join(root, 'out/broken.mp4'), 'not video')
    await writeFile(join(root, 'out/other.txt'), 'text')
    await mkdir(join(root, 'out/folder'), { recursive: true })
    const message = errorOf(await call(created, 'video_deliver', {
      project_path: path,
      files: [
        { path: 'out/missing.mp4', format: 'video' },
        { path: 'out/empty.mp4', format: 'video' },
        { path: 'out/broken.mp4', format: 'video' },
        { path: 'out/other.txt', format: 'other' },
        { path: 'out/folder', format: 'other' },
      ],
    }))
    expect(message).toContain('duration_plan')
    expect(message).toContain('budget')
    expect(message).toContain('is missing')
    expect(message).toContain('is empty')
  })

  it('warns about a missing audio stream and a duration drift without blocking', async () => {
    const script = join(root, 'warn-ffprobe.sh')
    await writeFile(script, '#!/bin/sh\necho \'{"format":{"duration":"20"},"streams":[{"codec_type":"video","width":64,"height":96}]}\'\nexit 0\n')
    await chmod(script, 0o755)
    const created = await boot({ ffprobePath: script })
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Warnings', target_seconds: 10, budget_cny: 50 }))
    const path = project.path as string
    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's1', index: 1, prompt: 'x', duration_sec: 1, status: 'ready', clip_path: 'out/warn.mp4' },
    }))
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out/warn.mp4'), 'video bytes')
    const value = valueOf(await call(created, 'video_deliver', {
      project_path: path,
      files: [{ path: 'out/warn.mp4', format: 'video' }],
    }))
    expect(value.ok).toBe(true)
    expect(String(value.message)).toContain('audio_stream')
    expect(String(value.message)).toContain('duration')
    expect(value.findings).toHaveLength(2)
  })

  it('blocks delivery when no file is declared as video', async () => {
    const created = await boot()
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'No Video' }))
    const path = project.path as string
    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's1', index: 1, prompt: 'x', duration_sec: 1, status: 'ready', clip_path: 'out/s1.mp4' },
    }))
    await writeFile(join(root, 'notes.txt'), 'text')
    expect(errorOf(await call(created, 'video_deliver', {
      project_path: path, files: [{ path: 'notes.txt', format: 'other' }],
    }))).toContain('no file was declared with format `video`')
  })
})

describe('working directory fallbacks', () => {
  it('uses the process directory without an Agent and without the working-directory service', async () => {
    process.chdir(root)
    const created = await boot()
    const init = await created.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('no-agent'), name: 'video_project', arguments: JSON.stringify({ action: 'init', title: 'No Agent' }) }],
      signal: new AbortController().signal,
    })
    expect(init.results[0]?.result.isError).toBe(false)

    const bare = new Context()
    await bare.plugin(SystemPrompt).await()
    await bare.plugin(ToolsService).await()
    await bare.plugin(LocalFileSystem, { cwd: root }).await()
    await bare.plugin(LocalSubprocessRuntime).await()
    await bare.plugin(NativeToolExecutor).await()
    await bare.plugin(VideoMode, { fakeProvider: true }).await()
    const owner = await agentOf(bare)
    const result = await executeToolFixture(bare, {
      signal: new AbortController().signal,
      callId: ToolCallId('no-working-service'),
      name: 'video_project',
      arguments: { action: 'init', title: 'Bare' },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    await bare.fiber.dispose()
  })
})

describe('remaining tool branches', () => {
  it('records keyframes, clips, an explicit id, an aspect, and a render without optional fields', async () => {
    const created = await boot()
    const project = valueOf(await call(created, 'video_project', {
      action: 'init', title: 'Explicit', id: 'explicit-id', aspect: '1:1', target_seconds: 5, budget_cny: 2,
    }))
    const path = project.path as string
    expect(path).toContain('explicit-id')
    const updated = valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: {
        id: 's1', index: 1, prompt: 'x', duration_sec: 1, status: 'ready',
        keyframe_path: 'out/s1.png', clip_path: 'out/s1.mp4', provider: 'stub', model: 'stub/video', cost_cny: 1,
      },
    }))
    expect(String(updated.message)).toContain('s1')
    const rendered = valueOf(await call(created, 'video_project', {
      action: 'record_render', project_path: path, render: { id: 'r1', path: 'out/final.mp4' },
    }))
    expect(String(rendered.message)).toContain('1 renders')
  })

  it('renders an estimate duration, a failed status, progress, and a cost-free artifact message', async () => {
    const created = await boot()
    const estimate = valueOf(await call(created, 'media', {
      action: 'estimate', kind: 'video', prompt: 'x', duration_sec: 3,
    }))
    expect((estimate.estimate as { durationSec?: number }).durationSec).toBe(3)

    let submittedCount = 0
    created.media.register(providerOf({
      id: 'progress',
      models: [{ id: 'progress/video', kind: 'video', provider: 'progress' }],
      estimate: () => ({ confidence: 'exact' }),
      submit: async (request) => {
        submittedCount += 1
        return {
          id: `progress-${submittedCount}`, provider: 'progress', model: request.model ?? '', kind: request.kind, status: 'submitted',
        }
      },
      poll: async task => task.id === 'progress-1'
        ? { ...task, status: 'failed', error: { code: 'X', message: 'boom' } }
        : { ...task, status: 'succeeded', progress: 1, artifacts: [{ id: 'a', kind: task.kind, mediaType: 'video/mp4', bytes: MP4 }] },
    }))
    const submitted = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'progress/video', output_path: 'out/p.mp4', wait: false,
    }))
    expect(submitted.task).toMatchObject({ status: 'submitted' })
    const failed = valueOf(await call(created, 'media', { action: 'status', task_id: 'progress-1' }))
    expect(String(failed.message)).toContain('is failed: boom')

    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'progress/video', output_path: 'out/p.mp4', wait: false,
    }))
    const succeeded = valueOf(await call(created, 'media', {
      action: 'status', task_id: 'progress-2', output_path: 'out/p.mp4',
    }))
    expect(String(succeeded.message)).toContain('Wrote')
    expect(String(succeeded.message)).not.toContain('Cost')
    expect((succeeded.task as { progress?: number }).progress).toBe(1)
  })

  it('forwards every optional request field', async () => {
    const created = await boot()
    let seen: Record<string, unknown> | undefined
    created.media.register(providerOf({
      id: 'args',
      models: [{ id: 'args/video', kind: 'video', provider: 'args' }],
      submit: async (request) => {
        seen = { ...request }
        return {
          id: 'args-1', provider: 'args', model: request.model ?? '', kind: request.kind, status: 'succeeded',
          artifacts: [{ id: 'a', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
        }
      },
    }))
    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'args/video', output_path: 'out/a.mp4',
      negative_prompt: 'blurry', duration_sec: 2, aspect_ratio: '9:16', resolution: '768p', seed: 7, voice: 'v',
    }))
    expect(seen).toMatchObject({
      negativePrompt: 'blurry', durationSec: 2, aspectRatio: '9:16', resolution: '768p', seed: 7, voice: 'v',
    })
  })

  it('reports a successful generation without a recorded cost', async () => {
    const created = await boot()
    created.media.register(providerOf({
      id: 'free',
      models: [{ id: 'free/video', kind: 'video', provider: 'free' }],
      estimate: () => ({ confidence: 'exact' }),
      submit: async request => ({
        id: 'free-1', provider: 'free', model: request.model ?? '', kind: request.kind, status: 'succeeded',
        artifacts: [{ id: 'a', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
      }),
    }))
    const value = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'free/video', output_path: 'out/free.mp4',
    }))
    expect(String(value.message)).toContain('Generated video')
    expect(String(value.message)).not.toContain('Cost')
  })

  it('reports a failed task without an error message and a success without artifacts', async () => {
    const created = await boot()
    created.media.register(providerOf({
      id: 'noerror',
      models: [{ id: 'noerror/video', kind: 'video', provider: 'noerror' }],
      submit: async request => ({ id: 'noerror-1', provider: 'noerror', model: request.model ?? '', kind: request.kind, status: 'failed' }),
    }))
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'noerror/video', output_path: 'out/n.mp4',
    }))).toContain('provider reported failure')

    created.media.register(providerOf({
      id: 'empty',
      models: [{ id: 'empty/video', kind: 'video', provider: 'empty' }],
      submit: async request => ({ id: 'empty-1', provider: 'empty', model: request.model ?? '', kind: request.kind, status: 'succeeded' }),
    }))
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'empty/video', output_path: 'out/e.mp4',
    }))).toContain('succeeded without artifacts')
  })

  it('describes an empty model list with and without a filter', async () => {
    const created = await boot({ fakeProvider: false })
    const any = valueOf(await call(created, 'media', { action: 'models' }))
    expect(String(any.message)).toContain('any capability')
    const filtered = valueOf(await call(created, 'media', { action: 'models', kind: 'video' }))
    expect(String(filtered.message)).toContain('serve video')
  })
})

describe('delivery stream findings', () => {
  it('blocks a video without a readable stream and skips a duration check without a duration', async () => {
    const script = join(root, 'stream-ffprobe.sh')
    await writeFile(script, '#!/bin/sh\necho \'{"format":{},"streams":[]}\'\nexit 0\n')
    await chmod(script, 0o755)
    const created = await boot({ ffprobePath: script })
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Streams' }))
    const path = project.path as string
    valueOf(await call(created, 'video_project', {
      action: 'upsert_shot', project_path: path,
      shot: { id: 's1', index: 1, prompt: 'x', duration_sec: 1, status: 'ready', clip_path: 'out/s1.mp4' },
    }))
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out/s1.mp4'), 'video bytes')
    const message = errorOf(await call(created, 'video_deliver', {
      project_path: path, files: [{ path: 'out/s1.mp4', format: 'video' }],
    }))
    expect(message).toContain('no readable video stream')
    expect(message).toContain('no audio stream')
  })
})

describe('durable tasks and the budget ledger', () => {
  it('journals a pending task, recovers it after a restart, and ledgers one charge', async () => {
    const first = await boot({ approvalThresholdCny: 100 })
    first.media.register(providerOf({
      id: 'durable',
      models: [{ id: 'durable/video', kind: 'video', provider: 'durable' }],
      estimate: () => ({ confidence: 'exact', cost: { amountMinor: 700, currency: 'CNY' } }),
      submit: async request => ({
        id: 'durable-video-1', provider: 'durable', model: request.model ?? '', kind: request.kind, status: 'submitted',
      }),
    }))
    const project = valueOf(await call(first, 'video_project', { action: 'init', title: 'Durable', budget_cny: 10 }))
    const projectPath = project.path as string

    const submitted = valueOf(await call(first, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'durable/video', output_path: 'out/clip.mp4',
      wait: false, project_path: projectPath,
    }))
    expect(String(submitted.message)).toContain('Submitted video task')
    expect(await readTaskRecords(first, projectPath, root)).toHaveLength(1)
    await first.fiber.dispose()

    const second = await boot()
    let resumed = 0
    second.media.register(providerOf({
      id: 'durable',
      models: [{ id: 'durable/video', kind: 'video', provider: 'durable' }],
      estimate: () => ({ confidence: 'exact', cost: { amountMinor: 700, currency: 'CNY' } }),
      resume: (record) => {
        resumed += 1
        return record.task
      },
      poll: async task => ({
        ...task,
        status: 'succeeded',
        artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
      }),
    }))

    const settled = valueOf(await call(second, 'media', {
      action: 'status', task_id: 'durable-video-1', project_path: projectPath,
    }))
    expect(resumed).toBe(1)
    expect(String(settled.message)).toContain('Wrote')
    expect((await stat(join(root, 'out/clip.mp4'))).size).toBe(MP4.length)
    expect(await readTaskRecords(second, projectPath, root)).toEqual([])
    const charges = await readLedger(second, projectPath, root)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({
      taskId: 'durable-video-1', kind: 'video', model: 'durable/video', costCny: 7,
    })
    expect(charges[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    valueOf(await call(second, 'media', { action: 'status', task_id: 'durable-video-1', project_path: projectPath }))
    expect(await readLedger(second, projectPath, root)).toHaveLength(1)
    await second.fiber.dispose()
  })

  it('counts the ledger against the budget when a shot records no cost', async () => {
    const created = await boot()
    let price = 100
    created.media.register(providerOf({
      id: 'priced',
      models: [{ id: 'priced/video', kind: 'video', provider: 'priced' }],
      estimate: () => ({ confidence: 'exact', cost: { amountMinor: price, currency: 'CNY' } }),
      submit: async request => ({
        id: `priced-${price}`, provider: 'priced', model: request.model ?? '', kind: request.kind,
        status: 'succeeded', artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
      }),
    }))
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Priced', budget_cny: 3 }))
    const projectPath = project.path as string

    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'priced/video', output_path: 'out/a.mp4',
      project_path: projectPath, confirm_cost: true,
    }))
    expect(await readLedger(created, projectPath, root)).toHaveLength(1)

    price = 300
    const error = errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'priced/video', output_path: 'out/b.mp4',
      project_path: projectPath, confirm_cost: true,
    }))
    expect(error).toContain('exceeds the 2.00 CNY remaining')
    expect(await readLedger(created, projectPath, root)).toHaveLength(1)
  })

  it('lets two generations compare the same ledger and then blocks the next one', async () => {
    const created = await boot({ approvalThresholdCny: 100 })
    let started = 0
    let releaseBoth: () => void = () => {}
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve })
    created.media.register(providerOf({
      id: 'race',
      models: [{ id: 'race/video', kind: 'video', provider: 'race' }],
      estimate: () => ({ confidence: 'exact', cost: { amountMinor: 200, currency: 'CNY' } }),
      submit: async (request) => {
        started += 1
        const id = `race-${started}`
        if (started === 2) releaseBoth()
        await bothStarted
        return {
          id, provider: 'race', model: request.model ?? '', kind: request.kind, status: 'succeeded',
          artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
        }
      },
    }))
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Race', budget_cny: 3 }))
    const projectPath = project.path as string
    const generate = (name: string): ReturnType<typeof call> => call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'race/video', output_path: `out/${name}.mp4`,
      project_path: projectPath, confirm_cost: true,
    })
    const concurrent = Promise.all([generate('a'), generate('b')])
    await bothStarted
    const [first, second] = await concurrent
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    const charges = await readLedger(created, projectPath, root)
    expect(charges).toHaveLength(2)
    expect(ledgerCost(charges)).toBe(4)
    expect(errorOf(await generate('c'))).toContain('remaining in the project budget')
    expect(await readLedger(created, projectPath, root)).toHaveLength(2)
  })

  it('journals only pending tasks and clears a record on failure or cancel', async () => {
    const created = await boot({ approvalThresholdCny: 100 })
    created.media.register(providerOf({
      id: 'sync',
      models: [{ id: 'sync/video', kind: 'video', provider: 'sync' }],
      submit: async request => ({
        id: 'sync-1', provider: 'sync', model: request.model ?? '', kind: request.kind, status: 'succeeded',
        artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
      }),
    }))
    created.media.register(providerOf({
      id: 'flaky',
      models: [{ id: 'flaky/video', kind: 'video', provider: 'flaky' }],
      submit: async request => ({
        id: 'flaky-1', provider: 'flaky', model: request.model ?? '', kind: request.kind, status: 'submitted',
      }),
      poll: async task => ({ ...task, status: 'failed', error: { code: 'X', message: 'bad' } }),
    }))
    created.media.register(providerOf({
      id: 'slow',
      models: [{ id: 'slow/video', kind: 'video', provider: 'slow' }],
      submit: async request => ({
        id: 'slow-1', provider: 'slow', model: request.model ?? '', kind: request.kind, status: 'submitted',
      }),
      poll: async task => task,
    }))
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Cleanup' }))
    const projectPath = project.path as string

    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'sync/video', output_path: 'out/a.mp4', project_path: projectPath,
    }))
    expect(await readTaskRecords(created, projectPath, root)).toEqual([])

    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'flaky/video', output_path: 'out/f.mp4', project_path: projectPath,
    }))).toContain('bad')
    expect(await readTaskRecords(created, projectPath, root)).toEqual([])

    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'slow/video', output_path: 'out/s.mp4',
      wait: false, project_path: projectPath,
    }))
    expect(await readTaskRecords(created, projectPath, root)).toHaveLength(1)
    valueOf(await call(created, 'media', { action: 'cancel', task_id: 'slow-1', project_path: projectPath }))
    expect(await readTaskRecords(created, projectPath, root)).toEqual([])

    created.media.register(providerOf({
      id: 'cancel',
      models: [{ id: 'cancel/video', kind: 'video', provider: 'cancel' }],
      submit: async request => ({
        id: 'cancel-1', provider: 'cancel', model: request.model ?? '', kind: request.kind, status: 'cancelled',
      }),
    }))
    expect(errorOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'cancel/video', output_path: 'out/c.mp4', project_path: projectPath,
    }))).toContain('was cancelled')
    expect(await readTaskRecords(created, projectPath, root)).toEqual([])
  })

  it('leaves a failed status without a project path unflagged', async () => {
    const created = await boot({ approvalThresholdCny: 100 })
    created.media.register(providerOf({
      id: 'late',
      models: [{ id: 'late/video', kind: 'video', provider: 'late' }],
      submit: async request => ({
        id: 'late-1', provider: 'late', model: request.model ?? '', kind: request.kind, status: 'submitted',
      }),
      poll: async task => ({ ...task, status: 'failed', error: { code: 'X', message: 'late failure' } }),
    }))
    const submitted = valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'late/video', output_path: 'out/l.mp4', wait: false,
    }))
    expect(String(submitted.message)).toContain('Submitted')
    const failed = valueOf(await call(created, 'media', { action: 'status', task_id: 'late-1' }))
    expect(String(failed.message)).toContain('is failed: late failure')

    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Late' }))
    const projectPath = project.path as string
    created.media.register(providerOf({
      id: 'later',
      models: [{ id: 'later/video', kind: 'video', provider: 'later' }],
      submit: async request => ({
        id: 'later-1', provider: 'later', model: request.model ?? '', kind: request.kind, status: 'submitted',
      }),
      poll: async task => ({ ...task, status: 'failed', error: { code: 'X', message: 'still bad' } }),
    }))
    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'later/video', output_path: 'out/ll.mp4',
      wait: false, project_path: projectPath,
    }))
    expect(await readTaskRecords(created, projectPath, root)).toHaveLength(1)
    const settled = valueOf(await call(created, 'media', { action: 'status', task_id: 'later-1', project_path: projectPath }))
    expect(String(settled.message)).toContain('is failed')
    expect(await readTaskRecords(created, projectPath, root)).toEqual([])
  })

  it('reports a lost task when the journal has no usable record', async () => {
    const created = await boot()
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Lost' }))
    const projectPath = project.path as string

    expect(errorOf(await call(created, 'media', { action: 'status', task_id: 'missing', project_path: projectPath })))
      .toContain('unknown media task')
    expect(errorOf(await call(created, 'media', { action: 'status', task_id: 'missing' })))
      .toContain('unknown media task')

    await recordTask(created, projectPath, {
      task: { id: 'ghost-video-1', provider: 'ghost', model: 'ghost/video', kind: 'video', status: 'running' },
      submittedAt: Date.now(),
      request: { kind: 'video', model: 'ghost/video', prompt: 'x', durationSec: 4 },
      outputPath: 'out/ghost.mp4',
    }, root)
    expect(errorOf(await call(created, 'media', { action: 'status', task_id: 'ghost-video-1', project_path: projectPath })))
      .toContain('provider "ghost" is not registered')
    await forgetTask(created, projectPath, 'ghost-video-1', root)
  })

  it('keeps a recovered task journaled while it is still running', async () => {
    const created = await boot()
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Running' }))
    const projectPath = project.path as string
    created.media.register(providerOf({
      id: 'slow',
      models: [{ id: 'slow/video', kind: 'video', provider: 'slow' }],
      resume: record => record.task,
      poll: async task => ({ ...task, status: 'running' }),
    }))
    await recordTask(created, projectPath, {
      task: { id: 'slow-video-1', provider: 'slow', model: 'slow/video', kind: 'video', status: 'running' },
      submittedAt: Date.now(),
      request: { kind: 'video', model: 'slow/video', prompt: 'x', durationSec: 4 },
      outputPath: 'out/slow.mp4',
    }, root)

    const running = valueOf(await call(created, 'media', { action: 'status', task_id: 'slow-video-1', project_path: projectPath }))
    expect(String(running.message)).toContain('is running')
    expect(await readTaskRecords(created, projectPath, root)).toHaveLength(1)
  })

  it('does not ledger a settlement in another currency', async () => {
    const created = await boot()
    created.media.register(providerOf({
      id: 'usd',
      models: [{ id: 'usd/video', kind: 'video', provider: 'usd' }],
      estimate: () => ({ confidence: 'exact', cost: { amountMinor: 1, currency: 'USD' } }),
      submit: async request => ({
        id: 'usd-1', provider: 'usd', model: request.model ?? '', kind: request.kind, status: 'succeeded',
        artifacts: [{ id: 'clip', kind: 'video', mediaType: 'video/mp4', bytes: MP4 }],
      }),
    }))
    const project = valueOf(await call(created, 'video_project', { action: 'init', title: 'Usd Ledger' }))
    const projectPath = project.path as string
    valueOf(await call(created, 'media', {
      action: 'generate', kind: 'video', prompt: 'x', model: 'usd/video', output_path: 'out/u.mp4',
      project_path: projectPath, confirm_cost: true,
    }))
    expect(await readLedger(created, projectPath, root)).toEqual([])
  })
})
