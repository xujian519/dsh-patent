/**
 * The edit decision list and its ffmpeg realization. One EDL describes a
 * complete render: canvas, ordered visual clips, optional audio, optional
 * burned subtitles, and the output path. The assembler validates the document,
 * builds a filter graph, runs ffmpeg through the subprocess seam, and probes
 * the result so delivery checks can trust measured facts.
 * @module @deepseek-ai/dsh-experimental-video-mode/edl
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MediaFailure, type Edl } from './types.ts'

/** Default output canvas for vertical short video. */
export const DEFAULT_CANVAS = { width: 1080, height: 1920, fps: 30 } as const

/** One visual clip as stored in an EDL. */
const visualClipSchema = z.union([
  z.object({
    kind: z.literal('video'),
    source: z.string().min(1),
    inSec: z.number().nonnegative().optional(),
    outSec: z.number().positive(),
  }).strict(),
  z.object({
    kind: z.literal('image'),
    source: z.string().min(1),
    durationSec: z.number().positive().max(600),
  }).strict(),
  z.object({
    kind: z.literal('color'),
    color: z.string().regex(/^[0-9a-fA-F]{6}$/),
    durationSec: z.number().positive().max(600),
  }).strict(),
])

/** One audio clip as stored in an EDL. */
const audioClipSchema = z.object({
  source: z.string().min(1),
  inSec: z.number().nonnegative().optional(),
  outSec: z.number().positive().optional(),
  gainDb: z.number().min(-60).max(24).optional(),
}).strict()

/** The complete EDL schema. */
const edlSchema = z.object({
  version: z.literal(1),
  canvas: z.object({
    width: z.number().int().min(64).max(7680),
    height: z.number().int().min(64).max(7680),
    fps: z.number().int().min(1).max(120),
  }).strict(),
  clips: z.array(visualClipSchema).min(1).max(400),
  audio: z.array(audioClipSchema).max(32).optional(),
  subtitles: z.string().min(1).optional(),
  output: z.string().min(1),
}).strict()

/** Measured facts about one media file. */
export interface MediaProbe {
  /** Duration in seconds when the container reports one. */
  readonly durationSec?: number
  /** Encoded width of the first video stream. */
  readonly width?: number
  /** Encoded height of the first video stream. */
  readonly height?: number
  /** Whether at least one audio stream exists. */
  readonly hasAudio: boolean
  /** Container format name. */
  readonly format?: string
}

/** Result of one successful assembly. */
export interface AssemblyResult {
  /** Output path as declared in the EDL. */
  readonly output: string
  /** Written byte size. */
  readonly bytes: number
  /** Measured output facts. */
  readonly probe: MediaProbe
  /** Complete ffmpeg argv, recorded for reproducibility. */
  readonly command: readonly string[]
}

/** Runtime options the tools pass into the assembler. */
export interface AssembleOptions {
  /** Session working directory; relative EDL paths resolve against it. */
  readonly cwd: string
  /** ffmpeg executable name or path. */
  readonly ffmpegPath: string
  /** ffprobe executable name or path. */
  readonly ffprobePath: string
  /** Subtitle font family; empty leaves ffmpeg's default. */
  readonly subtitleFont: string
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/** A process result bounded to the assembler's diagnostics. */
interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/**
 * Validate an EDL, converting schema failures into the stable EDL code.
 * @param value - untrusted document.
 * @returns the validated EDL.
 * @throws {@link MediaFailure} `MEDIA_EDL_INVALID`.
 */
export function validateEdl(value: unknown): Edl {
  const parsed = edlSchema.safeParse(value)
  if (!parsed.success) {
    throw new MediaFailure(`invalid EDL: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 'MEDIA_EDL_INVALID')
  }
  for (const [index, clip] of parsed.data.clips.entries()) {
    if (clip.kind === 'video' && clip.inSec !== undefined && clip.outSec <= clip.inSec) {
      throw new MediaFailure(`EDL clip ${index}: outSec must be greater than inSec`, 'MEDIA_EDL_INVALID')
    }
  }
  return parsed.data as Edl
}

/**
 * Duration one visual clip contributes to the timeline.
 * @param clip - validated visual clip.
 * @returns seconds.
 */
export function clipDuration(clip: Edl['clips'][number]): number {
  switch (clip.kind) {
    case 'video': return clip.outSec - (clip.inSec ?? 0)
    case 'image': return clip.durationSec
    case 'color': return clip.durationSec
  }
}

/**
 * Total timeline duration.
 * @param edl - validated EDL.
 * @returns seconds.
 */
export function edlDuration(edl: Edl): number {
  return edl.clips.reduce((sum, clip) => sum + clipDuration(clip), 0)
}

/**
 * Escape one value for an ffmpeg filter argument.
 * @param value - raw path or style value.
 * @returns the escaped value.
 */
function escapeFilter(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;')
}

/**
 * Build the ffmpeg argument vector for one EDL.
 * @param edl - validated EDL.
 * @param options - runtime options.
 * @returns argv without the executable.
 */
export function buildFfmpegArgs(edl: Edl, options: Pick<AssembleOptions, 'subtitleFont'>): string[] {
  const { width, height, fps } = edl.canvas
  const args: string[] = ['-y']
  const filters: string[] = []
  const visualLabels: string[] = []
  let inputIndex = 0
  const fitted = `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

  for (const clip of edl.clips) {
    switch (clip.kind) {
      case 'video':
        args.push('-i', clip.source)
        filters.push(
          `[${inputIndex}:v]trim=start=${clip.inSec ?? 0}:end=${clip.outSec},setpts=PTS-STARTPTS,${fitted}[v${inputIndex}]`,
        )
        break
      case 'image':
        args.push('-loop', '1', '-t', String(clip.durationSec), '-i', clip.source)
        filters.push(`[${inputIndex}:v]${fitted}[v${inputIndex}]`)
        break
      case 'color':
        args.push('-f', 'lavfi', '-t', String(clip.durationSec), '-i', `color=c=0x${clip.color}:s=${width}x${height}:r=${fps}`)
        filters.push(`[${inputIndex}:v]format=yuv420p[v${inputIndex}]`)
        break
    }
    visualLabels.push(`[v${inputIndex}]`)
    inputIndex += 1
  }

  filters.push(`${visualLabels.join('')}concat=n=${visualLabels.length}:v=1:a=0[vcat]`)

  if (edl.subtitles !== undefined) {
    const style = options.subtitleFont.length > 0
      ? `:force_style='FontName=${escapeFilter(options.subtitleFont)},FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=48,Alignment=2'`
      : ''
    filters.push(`[vcat]subtitles=filename='${escapeFilter(edl.subtitles)}'${style}[vout]`)
  } else {
    filters.push('[vcat]null[vout]')
  }

  const total = edlDuration(edl)
  const audioInputs: number[] = []
  if (edl.audio !== undefined && edl.audio.length > 0) {
    for (const clip of edl.audio) {
      args.push('-i', clip.source)
      audioInputs.push(inputIndex)
      inputIndex += 1
    }
    const audioLabels: string[] = []
    for (const [position, clip] of edl.audio.entries()) {
      const index = audioInputs[position] as number
      const trim = clip.inSec !== undefined || clip.outSec !== undefined
        ? `atrim=start=${clip.inSec ?? 0}${clip.outSec === undefined ? '' : `:end=${clip.outSec}`},asetpts=PTS-STARTPTS,`
        : ''
      filters.push(`[${index}:a]${trim}volume=${clip.gainDb ?? 0}dB[a${index}]`)
      audioLabels.push(`[a${index}]`)
    }
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`)
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]')
  } else {
    args.push('-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    const silentIndex = inputIndex
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `${silentIndex}:a`)
  }

  args.push(
    '-t', String(total),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    edl.output,
  )
  return args
}

/**
 * Run one child process through the subprocess seam and collect bounded output.
 * @param ctx - context providing `ctx.subprocess`.
 * @param executable - configured executable name or path.
 * @param args - arguments.
 * @param cwd - working directory.
 * @param signal - caller cancellation.
 * @param missingCode - failure code when the executable is absent.
 * @returns exit facts and collected output.
 */
async function runProcess(
  ctx: Context,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  missingCode: 'MEDIA_FFMPEG_MISSING',
): Promise<ProcessResult> {
  let resolved: string
  try {
    resolved = await ctx.subprocess.resolveExecutable(executable)
  } catch (error) {
    throw new MediaFailure(`${executable} was not found; install ffmpeg and set the executable path in the video mode config`, missingCode, { cause: error })
  }
  const handle = ctx.subprocess.spawn({
    argv: [resolved, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 5000,
    signal,
  })
  const outcome = await handle.done
  return {
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    exitCode: outcome.exitCode,
  }
}

/**
 * Probe one media file with ffprobe.
 * @param ctx - context providing `ctx.subprocess` and `ctx.fs`.
 * @param path - file path, resolved against `cwd`.
 * @param options - runtime options.
 * @returns measured container facts.
 * @throws {@link MediaFailure} when ffprobe is absent or cannot read the file.
 */
export async function probeMedia(
  ctx: Context,
  path: string,
  options: AssembleOptions,
): Promise<MediaProbe> {
  const target = await ctx.fs.resolve(path, { cwd: options.cwd })
  const absolute = ctx.fs.processPath(target)
  const result = await runProcess(
    ctx,
    options.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolute],
    options.cwd,
    options.signal,
    'MEDIA_FFMPEG_MISSING',
  )
  if (result.exitCode !== 0) {
    throw new MediaFailure(`ffprobe failed for ${path}: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`, 'MEDIA_ASSEMBLY_FAILED')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new MediaFailure(`ffprobe returned unreadable JSON for ${path}`, 'MEDIA_ASSEMBLY_FAILED', { cause: error })
  }
  return parseProbe(parsed)
}

/**
 * Project the ffprobe JSON document onto {@link MediaProbe}.
 * @param value - parsed ffprobe output.
 * @returns measured facts, omitting absent fields.
 */
export function parseProbe(value: unknown): MediaProbe {
  if (typeof value !== 'object' || value === null) return { hasAudio: false }
  const record = value as { format?: unknown; streams?: unknown }
  const format = typeof record.format === 'object' && record.format !== null
    ? record.format as { duration?: unknown; format_name?: unknown }
    : undefined
  const streams = Array.isArray(record.streams) ? record.streams : []
  const video = streams.find(stream => typeof stream === 'object' && stream !== null && (stream as { codec_type?: unknown }).codec_type === 'video') as
    | { width?: unknown; height?: unknown }
    | undefined
  const hasAudio = streams.some(stream => typeof stream === 'object' && stream !== null && (stream as { codec_type?: unknown }).codec_type === 'audio')
  const duration = typeof format?.duration === 'string' ? Number(format.duration) : undefined
  const width = typeof video?.width === 'number' ? video.width : undefined
  const height = typeof video?.height === 'number' ? video.height : undefined
  return {
    ...duration !== undefined && Number.isFinite(duration) ? { durationSec: duration } : {},
    ...width === undefined ? {} : { width },
    ...height === undefined ? {} : { height },
    hasAudio,
    ...typeof format?.format_name === 'string' ? { format: format.format_name } : {},
  }
}

/**
 * Resolve every path the render reads or writes through the Session
 * filesystem, so ffmpeg receives process paths the policy already approved.
 * @param ctx - context providing `ctx.fs`.
 * @param edl - validated EDL.
 * @param cwd - Session working directory.
 * @returns the EDL with process paths.
 */
async function resolveEdlPaths(ctx: Context, edl: Edl, cwd: string): Promise<Edl> {
  const resolve = async (path: string): Promise<string> =>
    ctx.fs.processPath(await ctx.fs.resolve(path, { cwd }))
  const clips = await Promise.all(edl.clips.map(async (clip) => {
    if (clip.kind === 'color') return clip
    return { ...clip, source: await resolve(clip.source) }
  }))
  const audio = edl.audio === undefined
    ? undefined
    : await Promise.all(edl.audio.map(async clip => ({ ...clip, source: await resolve(clip.source) })))
  return {
    ...edl,
    clips,
    ...audio === undefined ? {} : { audio },
    ...edl.subtitles === undefined ? {} : { subtitles: await resolve(edl.subtitles) },
    output: await resolve(edl.output),
  }
}

/**
 * Assemble one EDL into the declared output file. Every input and the output
 * resolve through `ctx.fs` before ffmpeg runs.
 * @param ctx - context providing `ctx.subprocess` and `ctx.fs`.
 * @param value - untrusted EDL.
 * @param options - runtime options.
 * @returns the assembly result with measured facts and the command.
 * @throws {@link MediaFailure} for invalid input, a missing ffmpeg, or a failed render.
 */
export async function assemble(ctx: Context, value: unknown, options: AssembleOptions): Promise<AssemblyResult> {
  const edl = validateEdl(value)
  const resolved = await resolveEdlPaths(ctx, edl, options.cwd)
  const args = buildFfmpegArgs(resolved, options)
  // ffmpeg creates the file but not its parent directories. Publish an empty
  // placeholder through the filesystem seam first, so the write stays under the
  // same policy and sandbox as every other artifact and the directory exists.
  const target = await ctx.fs.resolve(edl.output, { cwd: options.cwd })
  if (await ctx.fs.stat(target, options.signal) === undefined) {
    await ctx.fs.writeBytes(target, new Uint8Array(0), undefined, options.signal)
  }
  const result = await runProcess(ctx, options.ffmpegPath, args, options.cwd, options.signal, 'MEDIA_FFMPEG_MISSING')
  if (result.exitCode !== 0) {
    const diagnostics = result.stderr.trim().split('\n').slice(-12).join('\n')
    throw new MediaFailure(`ffmpeg failed for ${edl.output}: ${diagnostics || `exit ${String(result.exitCode)}`}`, 'MEDIA_ASSEMBLY_FAILED')
  }
  const info = await ctx.fs.stat(target, options.signal)
  if (info === undefined || info.type !== 'file') {
    throw new MediaFailure(`ffmpeg reported success but ${edl.output} is absent`, 'MEDIA_ASSEMBLY_FAILED')
  }
  const probe = await probeMedia(ctx, edl.output, options)
  return {
    output: edl.output,
    bytes: info.size ?? 0,
    probe,
    command: [options.ffmpegPath, ...args],
  }
}
