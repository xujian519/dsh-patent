/**
 * EDL validation, ffmpeg argument construction, path resolution through
 * `ctx.fs`, ffprobe projection, and the assembler's failure ladder.
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import {
  assemble,
  buildFfmpegArgs,
  clipDuration,
  edlDuration,
  parseProbe,
  probeMedia,
  validateEdl,
  type AssembleOptions,
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
let ctx: Context

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-edl-')))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  await ctx.plugin(LocalSubprocessRuntime).await()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** Options pointing at real or deliberately broken executables. */
function optionsOf(overrides: Partial<AssembleOptions> = {}): AssembleOptions {
  return {
    cwd: root,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    subtitleFont: '',
    signal: new AbortController().signal,
    ...overrides,
  }
}

/**
 * Offset of one top-level MP4 atom.
 * @param bytes - complete file.
 * @param name - four-character atom type.
 * @returns the byte offset, or the file length when the atom is absent.
 */
function topLevelAtom(bytes: Buffer, name: string): number {
  let offset = 0
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset)
    if (bytes.toString('ascii', offset + 4, offset + 8) === name) return offset
    if (size < 8) break
    offset += size
  }
  return bytes.length
}

/** A minimal valid EDL with one color clip. */
function colorEdl(output = 'out/render.mp4'): Edl {
  return {
    version: 1,
    canvas: { width: 64, height: 96, fps: 12 },
    clips: [{ kind: 'color', color: '336699', durationSec: 0.5 }],
    output,
  }
}

describe('EDL validation', () => {
  it('rejects a document that fails the schema', () => {
    expect(() => validateEdl({ version: 1 })).toThrow(/invalid EDL/)
    expect(() => validateEdl({})).toThrow(/invalid EDL/)
  })

  it('computes clip and timeline durations', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [
        { kind: 'video', source: 'a.mp4', inSec: 1, outSec: 4 },
        { kind: 'image', source: 'b.png', durationSec: 2 },
        { kind: 'color', color: '000000', durationSec: 3 },
      ],
      output: 'out.mp4',
    }
    expect(edl.clips.map(clipDuration)).toEqual([3, 2, 3])
    expect(edlDuration(edl)).toBe(8)
    expect(clipDuration({ kind: 'video', source: 'a.mp4', outSec: 4 })).toBe(4)
  })
})

describe('ffmpeg arguments', () => {
  it('escapes a subtitle path and applies the configured font', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 320, height: 568, fps: 30 },
      clips: [{ kind: 'color', color: '112233', durationSec: 1 }],
      audio: [
        { source: 'voice.wav', inSec: 1, outSec: 3, gainDb: -6 },
        { source: 'music.wav', gainDb: 2 },
      ],
      subtitles: 'out/a:b[1].srt',
      output: 'out/ep.mp4',
    }
    const args = buildFfmpegArgs(edl, { subtitleFont: 'PingFang SC' })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain('subtitles=filename=')
    expect(graph).toContain('\\:')
    expect(graph).toContain('FontName=PingFang SC')
    expect(graph).toContain('atrim=start=1:end=3')
    expect(graph).toContain('volume=-6dB')
    expect(graph).toContain('volume=2dB')
    expect(graph).toContain('amix=inputs=2')
    expect(args).toContain('[aout]')
  })

  it('burns subtitles without a configured font and trims audio with only an in-point', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'color', color: '000000', durationSec: 1 }],
      audio: [
        { source: 'voice.wav', inSec: 1 },
        { source: 'music.wav', outSec: 2 },
      ],
      subtitles: 'out/sub.srt',
      output: 'out/ep.mp4',
    }
    const args = buildFfmpegArgs(edl, { subtitleFont: '' })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain('subtitles=filename=')
    expect(graph).not.toContain('force_style')
    expect(graph).toContain('atrim=start=1,')
  })

  it('fits video and image clips into the canvas', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 320, height: 568, fps: 30 },
      clips: [
        { kind: 'video', source: 'a.mp4', inSec: 1, outSec: 4 },
        { kind: 'video', source: 'b.mp4', outSec: 2 },
        { kind: 'image', source: 'still.png', durationSec: 2 },
      ],
      output: 'out/ep.mp4',
    }
    const args = buildFfmpegArgs(edl, { subtitleFont: '' })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain('trim=start=1:end=4')
    expect(graph).toContain('trim=start=0:end=2')
    expect(args).toContain('-loop')
  })

  it('keeps an apostrophe in the subtitle filename and in the font name', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'color', color: '000000', durationSec: 1 }],
      subtitles: "it's a,b;c[1]:d.srt",
      output: 'out/ep.mp4',
    }
    const args = buildFfmpegArgs(edl, { subtitleFont: "Don't" })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain("filename='it'\\\\\\''s\\ a\\,b\\;c\\[1\\]\\:d.srt'")
    expect(graph).toContain("FontName=Don'\\''t,FontSize=20")
    expect(graph.endsWith('[vout]')).toBe(true)
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('out/ep.mp4')
  })

  it('rejects a control character in the subtitle path or the font name', () => {
    const edl: Edl = {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'color', color: '000000', durationSec: 1 }],
      subtitles: 'a\nb.srt',
      output: 'out/ep.mp4',
    }
    expect(() => buildFfmpegArgs(edl, { subtitleFont: '' })).toThrow(/subtitle path contains a control character/)
    expect(() => buildFfmpegArgs({ ...edl, subtitles: 'ok.srt' }, { subtitleFont: 'A\nB' })).toThrow(/subtitle font contains a control character/)
    const leading = buildFfmpegArgs({ ...edl, subtitles: "'clip.srt" }, { subtitleFont: '' })
    const graph = leading[leading.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain("filename=\\\\\\''clip.srt'[vout]")
  })

  it('mixes a silent track when the EDL has no audio', () => {
    const args = buildFfmpegArgs(colorEdl(), { subtitleFont: '' })
    const graph = args[args.indexOf('-filter_complex') + 1] as string
    expect(graph).not.toContain('subtitles=')
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
  })
})

describe('probe projection', () => {
  it('projects a complete ffprobe document', () => {
    expect(parseProbe({
      format: { duration: '12.5', format_name: 'mov,mp4,m4a' },
      streams: [
        { codec_type: 'audio' },
        { codec_type: 'video', width: 1080, height: 1920 },
      ],
    })).toEqual({ durationSec: 12.5, width: 1080, height: 1920, hasAudio: true, format: 'mov,mp4,m4a' })
  })

  it('omits absent and invalid fields', () => {
    expect(parseProbe(null)).toEqual({ hasAudio: false })
    expect(parseProbe({ format: { duration: 'not-a-number' }, streams: 'bad' })).toEqual({ hasAudio: false })
    expect(parseProbe({ format: {}, streams: [{ codec_type: 'video' }] })).toEqual({ hasAudio: false })
  })
})

describe('probe and assembly failures', () => {
  it('reports a missing executable, a non-zero probe, and unreadable JSON', async () => {
    await writeFile(join(root, 'empty.bin'), '')
    await expect(probeMedia(ctx, 'empty.bin', optionsOf({ ffprobePath: 'dsh-no-such-ffprobe' })))
      .rejects.toMatchObject({ code: 'MEDIA_FFMPEG_MISSING' })
    await expect(probeMedia(ctx, 'empty.bin', optionsOf({ ffprobePath: 'false' })))
      .rejects.toMatchObject({ code: 'MEDIA_ASSEMBLY_FAILED' })
    await expect(probeMedia(ctx, 'empty.bin', optionsOf({ ffprobePath: 'echo' })))
      .rejects.toThrow(/unreadable JSON/)
  })

  it('reports the ffmpeg diagnostic tail when the render fails', async () => {
    const withAudio: Edl = {
      ...colorEdl(),
      audio: [{ source: 'voice.wav' }],
      subtitles: 'out/sub.srt',
    }
    await expect(assemble(ctx, withAudio, optionsOf({ ffmpegPath: 'false' })))
      .rejects.toThrow(/ffmpeg failed for out\/render.mp4: exit 1/)
    await expect(assemble(ctx, colorEdl(), optionsOf({ ffmpegPath: 'false' })))
      .rejects.toThrow(/ffmpeg failed for out\/render.mp4: exit 1/)
    await expect(assemble(ctx, colorEdl(), optionsOf({ ffmpegPath: 'dsh-no-such-ffmpeg' })))
      .rejects.toMatchObject({ code: 'MEDIA_FFMPEG_MISSING' })
  })

  it('reports success without an output file', async () => {
    const script = join(root, 'fake-ffmpeg.sh')
    await writeFile(script, '#!/bin/sh\nfor last; do :; done\nrm -f "$last"\nexit 0\n')
    await chmod(script, 0o755)
    await expect(assemble(ctx, colorEdl(), optionsOf({ ffmpegPath: script })))
      .rejects.toThrow(/is absent/)
  })
})

describe.runIf(FFMPEG)('assembly with real ffmpeg', () => {
  it('resolves every input and the output through ctx.fs', async () => {
    await mkdir(join(root, 'assets'), { recursive: true })
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96:d=1', '-frames:v', '1', join(root, 'assets', 'still.png')], { stdio: 'ignore' })
    const result = await assemble(ctx, {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'image', source: 'assets/still.png', durationSec: 1 }],
      output: 'out/image.mp4',
    }, optionsOf())
    expect(result.output).toBe('out/image.mp4')
    expect(result.command).toContain(join(root, 'assets', 'still.png'))
    expect(result.command).toContain(join(root, 'out', 'image.mp4'))
    expect((await stat(join(root, 'out', 'image.mp4'))).size).toBeGreaterThan(0)
  })

  it('burns a subtitle whose name contains an apostrophe and writes moov before mdat', async () => {
    await writeFile(join(root, "a b's.srt"), '1\n00:00:00,000 --> 00:00:00,200\nhi\n')
    const result = await assemble(ctx, {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'color', color: '112233', durationSec: 0.2 }],
      subtitles: "a b's.srt",
      output: 'out/titled.mp4',
    }, optionsOf({ subtitleFont: "Don't" }))
    expect(result.bytes).toBeGreaterThan(0)
    const bytes = await readFile(join(root, 'out/titled.mp4'))
    expect(topLevelAtom(bytes, 'moov')).toBeLessThan(topLevelAtom(bytes, 'mdat'))
  })

  it('keeps an existing output placeholder instead of rewriting it', async () => {
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'existing.mp4'), 'placeholder')
    const result = await assemble(ctx, colorEdl('out/existing.mp4'), optionsOf())
    expect(result.bytes).toBeGreaterThan(0)
  })
})

describe('path resolution without real media tools', () => {
  it('resolves an image clip source and reports the complete probe', async () => {
    const ffmpeg = join(root, 'fake-ffmpeg-image.sh')
    await writeFile(ffmpeg, '#!/bin/sh\nfor last; do :; done\necho rendered > "$last"\nexit 0\n')
    await chmod(ffmpeg, 0o755)
    const probe = join(root, 'fake-ffprobe-complete.sh')
    await writeFile(probe, '#!/bin/sh\necho \'{"format":{"duration":"1"},"streams":[{"codec_type":"video","width":64,"height":96},{"codec_type":"audio"}]}\'\nexit 0\n')
    await chmod(probe, 0o755)
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets', 'still.png'), 'png')

    const result = await assemble(ctx, {
      version: 1,
      canvas: { width: 64, height: 96, fps: 12 },
      clips: [{ kind: 'image', source: 'assets/still.png', durationSec: 1 }],
      output: 'out/image.mp4',
    }, optionsOf({ ffmpegPath: ffmpeg, ffprobePath: probe }))

    expect(result.command).toContain(join(root, 'assets', 'still.png'))
    expect(result.probe).toEqual({ durationSec: 1, width: 64, height: 96, hasAudio: true, format: undefined })
  })
})

describe('probe and assembly without optional runtime facts', () => {
  it('reads empty collected output when the handle reports none', async () => {
    await writeFile(join(root, 'empty.bin'), '')
    const original = ctx.subprocess.spawn.bind(ctx.subprocess)
    Object.defineProperty(ctx.subprocess, 'spawn', {
      configurable: true,
      value: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }),
    })
    try {
      await expect(probeMedia(ctx, 'empty.bin', optionsOf({ ffprobePath: 'echo' })))
        .rejects.toThrow(/unreadable JSON/)
    } finally {
      Object.defineProperty(ctx.subprocess, 'spawn', { configurable: true, value: original })
    }
  })

  it('reports zero bytes when the filesystem omits the size', async () => {
    const script = join(root, 'empty-probe.sh')
    await writeFile(script, '#!/bin/sh\necho \'{"streams":[]}\'\nexit 0\n')
    await chmod(script, 0o755)
    const original = ctx.fs.stat.bind(ctx.fs)
    Object.defineProperty(ctx.fs, 'stat', {
      configurable: true,
      value: async (...args: Parameters<typeof original>) => {
        const info = await original(...args)
        return info === undefined ? undefined : { type: info.type }
      },
    })
    try {
      const result = await assemble(ctx, colorEdl(), optionsOf({ ffmpegPath: 'true', ffprobePath: script }))
      expect(result.bytes).toBe(0)
    } finally {
      Object.defineProperty(ctx.fs, 'stat', { configurable: true, value: original })
    }
  })
})
