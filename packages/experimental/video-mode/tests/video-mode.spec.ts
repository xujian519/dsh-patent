/**
 * End-to-end tests of the experimental video mode through the real tool
 * registry: synthetic media generation writes validated bytes, the project
 * document round-trips, ffmpeg assembles an EDL, and delivery refuses
 * incomplete work. ffmpeg-dependent cases skip when the binary is absent.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import VideoMode, {
  MediaRuntime,
  buildFfmpegArgs,
  colorFor,
  newProject,
  silentWav,
  solidPng,
  validateEdl,
  type Edl,
} from '../src/index.ts'

const FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let root: string
let originalCwd: string
let ctx: Context
let media: MediaRuntime
let callId = 0

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-mode-')))
  originalCwd = process.cwd()
  process.chdir(root)
  ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolsService).await()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  await ctx.plugin(LocalSubprocessRuntime).await()
  await ctx.plugin(NativeToolExecutor).await()
  await ctx.plugin(VideoMode, {
    fakeProvider: true,
    waitMs: 5000,
    pollMs: 10,
    approvalThresholdCny: 0.1,
    ledgerDir: join(root, '.host-ledgers'),
  }).await()
  media = ctx.media
})

afterEach(async () => {
  await ctx.fiber.dispose()
  process.chdir(originalCwd)
  await rm(root, { recursive: true, force: true })
})

/** Run one model call through the native executor. */
async function call(name: string, args: Record<string, unknown>) {
  callId += 1
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: `call-${callId}` as ToolCallId, name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`no result for ${name}`)
  return result
}

/** Read the canonical value of a successful call. */
function valueOf(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  if (result.isError) throw new Error(`expected success: ${result.error.message}`)
  return result.value as Record<string, unknown>
}

describe('fixture encoders', () => {
  it('write valid PNG and WAV signatures with the requested dimensions', async () => {
    const png = solidPng(8, 8, 10, 20, 30)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const wav = silentWav(0.25, 48_000)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE')
    expect(colorFor('same')).toEqual(colorFor('same'))
    expect(colorFor('a')).not.toEqual(colorFor('b'))
  })
})

describe('media runtime', () => {
  it('lists synthetic models and settles image, video, and speech tasks', async () => {
    expect(media.models('image').map(model => model.id)).toContain('synthetic/image')
    const image = await media.generate({ kind: 'image', prompt: 'a blue door' }, new AbortController().signal)
    expect(image.status).toBe('succeeded')
    expect(image.artifacts?.[0]?.mediaType).toBe('image/png')
    expect(image.cost?.amountMinor).toBe(35)

    const video = await media.generate({ kind: 'video', prompt: 'a walk', durationSec: 2 }, new AbortController().signal)
    expect(video.artifacts?.[0]?.mediaType).toBe('video/mp4')
    expect(video.cost?.amountMinor).toBe(72)

    const speech = await media.generate({ kind: 'speech', prompt: 'hello there' }, new AbortController().signal)
    expect(speech.artifacts?.[0]?.mediaType).toBe('audio/wav')
  })

  it('reports an unknown task and rejects an empty prompt', async () => {
    expect(() => media.status('missing')).toThrow(/unknown media task/)
    await expect(media.generate({ kind: 'image', prompt: '  ' }, new AbortController().signal))
      .rejects.toThrow(/non-empty prompt/)
  })

  it('estimates without starting work', () => {
    expect(media.estimate({ kind: 'video', prompt: 'x', durationSec: 3 }).cost?.amountMinor).toBe(108)
  })
})

describe('project document', () => {
  it('creates, reads, mutates, and validates a project', async () => {
    const init = valueOf(await call('video_project', { action: 'init', title: 'Test Film', budget_cny: 50 }))
    const path = init.path as string
    expect(path.startsWith(root)).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('"schemaVersion": 1')

    const added = valueOf(await call('video_project', {
      action: 'upsert_shot',
      project_path: path,
      shot: { id: 's01', index: 1, prompt: 'a door', duration_sec: 2, status: 'draft' },
    }))
    expect(added.message).toContain('s01')

    const read = valueOf(await call('video_project', { action: 'read', project_path: path }))
    expect(read.message).toContain('"shots"')
    expect(read.message).toContain('a door')

    const removed = valueOf(await call('video_project', { action: 'remove_shot', project_path: path, shot_id: 's01' }))
    expect(removed.message).toContain('0 shots')
  })

  it('rejects an invalid project id', () => {
    expect(() => newProject({ title: 'x', id: 'Not A Slug' })).toThrow(/invalid video project/)
  })
})

describe('EDL', () => {
  it('validates clips and builds a normalized filter graph', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 320, height: 568, fps: 30 },
      clips: [
        { kind: 'image', source: 'a.png', durationSec: 2 },
        { kind: 'color', color: '112233', durationSec: 1 },
      ],
      audio: [{ source: 'voice.wav', gainDb: -3 }],
      subtitles: 'out/ep.srt',
      output: 'out/ep.mp4',
    }
    expect(validateEdl(edl).clips).toHaveLength(2)
    const args = buildFfmpegArgs(edl, { subtitleFont: 'PingFang SC' })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain('concat=n=2:v=1:a=0')
    expect(graph).toContain('subtitles=filename=')
    expect(graph).toContain('amix=inputs=1')
    expect(args).toContain('+faststart')
    expect(args[args.length - 1]).toBe('out/ep.mp4')
  })

  it('rejects an inverted video range', () => {
    expect(() => validateEdl({
      version: 1,
      canvas: { width: 320, height: 568, fps: 30 },
      clips: [{ kind: 'video', source: 'a.mp4', inSec: 3, outSec: 2 }],
      output: 'out.mp4',
    })).toThrow(/outSec must be greater/)
  })
})

describe('tools', () => {
  it('registers all four tools', () => {
    for (const name of ['media', 'video_project', 'video_assemble', 'video_deliver']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })

  it('enforces the confirmation threshold and the project budget', async () => {
    const project = valueOf(await call('video_project', { action: 'init', title: 'Budget', budget_cny: 50 }))
    const projectPath = project.path as string
    const unconfirmed = await call('media', {
      action: 'generate', kind: 'image', prompt: 'a door', output_path: 'assets/budget.png', project_path: projectPath,
    })
    expect(unconfirmed.isError).toBe(true)
    if (unconfirmed.isError) expect(unconfirmed.error.message).toContain('confirmation threshold')

    const confirmed = valueOf(await call('media', {
      action: 'generate', kind: 'image', prompt: 'a door', output_path: 'assets/budget.png',
      project_path: projectPath, confirm_cost: true,
    }))
    expect(confirmed.message).toContain('Generated image')

    const tight = valueOf(await call('video_project', { action: 'init', title: 'Tight Budget', budget_cny: 0.2 }))
    const tightPath = tight.path as string
    const blocked = await call('media', {
      action: 'generate', kind: 'image', prompt: 'a door', output_path: 'assets/tight.png',
      project_path: tightPath, confirm_cost: true,
    })
    expect(blocked.isError).toBe(true)
    if (blocked.isError) expect(blocked.error.message).toContain('remaining in the project budget')
  })

  it('writes a settled task artifact when status names an output path', async () => {
    const generated = valueOf(await call('media', {
      action: 'generate', kind: 'image', prompt: 'a door', output_path: 'assets/first.png', confirm_cost: true,
    }))
    const task = generated.task as { id: string }
    const status = valueOf(await call('media', {
      action: 'status', task_id: task.id, output_path: 'assets/second.png',
    }))
    expect(status.message).toContain('Wrote')
    expect((await stat(join(root, 'assets/second.png'))).size).toBeGreaterThan(0)
  })

  it('generates an image through the media tool and writes valid bytes', async () => {
    const result = await call('media', {
      action: 'generate',
      kind: 'image',
      prompt: 'a red door',
      output_path: 'assets/s01.png', confirm_cost: true,
    })
    const value = valueOf(result)
    expect(value.message).toContain('Generated image')
    const file = join(root, 'assets/s01.png')
    const info = await stat(file)
    expect(info.size).toBeGreaterThan(0)
    const bytes = await readFile(file)
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
  })

})

describe.runIf(FFMPEG)('assembly and delivery', () => {
  async function prepare(): Promise<{ projectPath: string }> {
    const project = valueOf(await call('video_project', { action: 'init', title: 'One Shot', budget_cny: 50 }))
    const projectPath = project.path as string
    const image = valueOf(await call('media', {
      action: 'generate', kind: 'image', prompt: 'a door', output_path: 'shots/s01.png', confirm_cost: true,
    }))
    expect(image.message).toContain('Generated image')
    const video = valueOf(await call('media', {
      action: 'generate', kind: 'video', prompt: 'a door moves', duration_sec: 1, output_path: 'shots/s01.mp4', confirm_cost: true,
    }))
    expect(video.message).toContain('Generated video')
    const speech = valueOf(await call('media', {
      action: 'generate', kind: 'speech', prompt: 'hello', duration_sec: 1, output_path: 'audio/voice.wav', confirm_cost: true,
    }))
    expect(speech.message).toContain('Generated speech')
    valueOf(await call('video_project', {
      action: 'upsert_shot',
      project_path: projectPath,
      shot: {
        id: 's01', index: 1, prompt: 'a door', duration_sec: 1, status: 'ready',
        keyframe_path: 'shots/s01.png', clip_path: 'shots/s01.mp4', cost_cny: 1.2,
      },
    }))
    return { projectPath }
  }

  it('assembles a clip with audio and registered subtitles', async () => {
    const { projectPath } = await prepare()
    const result = valueOf(await call('video_assemble', {
      edl: {
        version: 1,
        canvas: { width: 320, height: 568, fps: 30 },
        clips: [{ kind: 'video', source: 'shots/s01.mp4', outSec: 1 }],
        audio: [{ source: 'audio/voice.wav' }],
        output: 'out/ep01.mp4',
      },
    }))
    expect(result.output).toBe('out/ep01.mp4')
    expect(result.hasAudio).toBe(true)
    expect(Number(result.bytes)).toBeGreaterThan(0)
    const delivered = await call('video_deliver', {
      project_path: projectPath,
      files: [{ path: 'out/ep01.mp4', format: 'video' }],
    })
    const value = valueOf(delivered)
    expect(value.ok).toBe(true)
    expect(String(value.message)).toContain('all checks passed')
  })

  it('refuses delivery when a shot has no clip', async () => {
    const project = valueOf(await call('video_project', { action: 'init', title: 'Incomplete' }))
    const projectPath = project.path as string
    valueOf(await call('video_project', {
      action: 'upsert_shot',
      project_path: projectPath,
      shot: { id: 's01', index: 1, prompt: 'missing', duration_sec: 1, status: 'draft' },
    }))
    const result = await call('video_deliver', {
      project_path: projectPath,
      files: [{ path: 'out/none.mp4', format: 'video' }],
    })
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('without a selected clip')
  })
})
