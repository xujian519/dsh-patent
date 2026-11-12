/**
 * The model-facing `video_assemble` tool: validate an EDL, render it with
 * ffmpeg, and return measured output facts. The EDL is the reproducible
 * contract; re-running it produces the same cut without replaying the chat.
 * @module @deepseek-ai/dsh-video-mode/tools/assemble
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assemble } from '../edl.ts'
import type MediaRuntime from '../media.ts'
import { workingDirectoryOf } from './shared.ts'

/** Model-visible result of one `video_assemble` call. */
interface AssembleToolValue {
  readonly message: string
  readonly output: string
  readonly bytes: number
  readonly durationSec?: number
  readonly width?: number
  readonly height?: number
  readonly hasAudio: boolean
  readonly command: string[]
}

/**
 * Create the `video_assemble` tool.
 * @param ctx - plugin context.
 * @param media - media runtime, which owns the configured executable paths.
 * @returns the registry-ready tool.
 */
export function createAssembleTool(ctx: Context, media: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'video_assemble',
    description: 'Render one edit decision list (EDL) into an MP4 with ffmpeg. '
      + 'The EDL names the canvas, ordered visual clips (`video` with `inSec`/`outSec`, `image` with `durationSec`, or `color` with `durationSec`), '
      + 'optional audio clips, an optional subtitle file to burn in, and the output path. '
      + 'All paths are relative to the Session working directory. '
      + 'Returns the measured duration, resolution, and audio presence. '
      + 'Write the EDL to a JSON file first when it is long, then pass the same object here.',
    parameters: {
      edl: {
        type: 'object', additionalProperties: true, required: true,
        description: 'Complete EDL object. See the tool description for its fields.',
      },
      output: { type: 'string', description: 'Override `edl.output`.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          output: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          durationSec: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          hasAudio: { type: 'boolean', required: true },
          command: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 15 * 60 * 1000,
    async execute(args, exec): Promise<AssembleToolValue> {
      const cwd = await workingDirectoryOf(ctx, exec)
      const value = args.output === undefined ? args.edl : { ...args.edl, output: args.output }
      const result = await assemble(ctx, value, {
        cwd,
        ffmpegPath: media.settings.ffmpegPath,
        ffprobePath: media.settings.ffprobePath,
        subtitleFont: media.settings.subtitleFont,
        signal: exec.signal,
      })
      const { probe } = result
      return {
        message: `Assembled ${result.output} (${result.bytes} bytes, `
          + `${probe.durationSec === undefined ? 'unknown duration' : `${probe.durationSec.toFixed(2)}s`}, `
          + `${probe.width ?? '?'}x${probe.height ?? '?'}, ${probe.hasAudio ? 'with audio' : 'silent'}).`,
        output: result.output,
        bytes: result.bytes,
        ...probe.durationSec === undefined ? {} : { durationSec: probe.durationSec },
        ...probe.width === undefined ? {} : { width: probe.width },
        ...probe.height === undefined ? {} : { height: probe.height },
        hasAudio: probe.hasAudio,
        command: [...result.command],
      }
    },
  })
}
