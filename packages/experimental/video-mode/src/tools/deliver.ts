/**
 * The model-facing `video_deliver` tool: declare final files and receive the
 * machine checks that stand beside the model's own quality claim. Blocking
 * findings refuse the registration; warnings are recorded because a reviewer
 * may accept them. The tool never writes or converts bytes.
 * @module @deepseek-ai/dsh-video-mode/tools/deliver
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { probeMedia, type MediaProbe } from '../edl.ts'
import { missingShotClips, projectCost, readProject } from '../project.ts'
import { ledgerCost, readLedger } from '../store.ts'
import type MediaRuntime from '../media.ts'
import { MediaFailure } from '../types.ts'
import { workingDirectoryOf } from './shared.ts'

/** One finding produced by a delivery check. */
interface DeliveryFinding {
  readonly check: string
  readonly level: 'block' | 'warn'
  readonly detail: string
}

/** Model-visible result of one `video_deliver` call. */
interface DeliverToolValue {
  readonly message: string
  readonly ok: boolean
  readonly findings: DeliveryFinding[]
  readonly probe?: MediaProbe
}

/**
 * Create the `video_deliver` tool.
 * @param ctx - plugin context.
 * @param media - media runtime, which owns the configured executable paths.
 * @returns the registry-ready tool.
 */
export function createDeliverTool(ctx: Context, media: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'video_deliver',
    description: 'Register the finished files of a video production and check them mechanically. '
      + 'Declare the final MP4 as `video`, its subtitle file as `subtitles`, its cover image as `poster`, and a JSON manifest as `manifest`. '
      + 'The tool reads the project, refuses a video whose shots are incomplete or whose reported cost exceeds the budget, '
      + 'and probes the video for duration, resolution, and audio. '
      + 'Blocking findings refuse the registration; warnings are recorded so the user can decide. '
      + 'This is a declaration, not a converter: the bytes must already exist in the Session workspace.',
    parameters: {
      files: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Existing file path relative to the Session working directory.' },
            format: { type: 'string', required: true, enum: ['video', 'subtitles', 'poster', 'manifest', 'other'] },
          },
        },
      },
      project_path: { type: 'string', required: true, description: 'Project file path.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          findings: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                check: { type: 'string', required: true },
                level: { type: 'string', required: true, enum: ['block', 'warn'] },
                detail: { type: 'string', required: true },
              },
            },
          },
          probe: {
            type: 'object', additionalProperties: false,
            properties: {
              durationSec: { type: 'number' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              hasAudio: { type: 'boolean', required: true },
              format: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec): Promise<DeliverToolValue> {
      const cwd = await workingDirectoryOf(ctx, exec)
      const project = await readProject(ctx, args.project_path, cwd, exec.signal)
      const findings: DeliveryFinding[] = []
      const missing = missingShotClips(project)
      if (project.shots.length === 0) {
        findings.push({ check: 'completeness', level: 'block', detail: 'the project has no shots' })
      } else if (missing.length > 0) {
        findings.push({ check: 'completeness', level: 'block', detail: `shots without a selected clip: ${missing.join(', ')}` })
      }
      const planned = project.shots.reduce((sum, shot) => sum + shot.durationSec, 0)
      if (planned > project.targetSeconds * 1.25) {
        findings.push({ check: 'duration_plan', level: 'warn', detail: `shots total ${planned.toFixed(1)}s against a ${project.targetSeconds}s target` })
      }
      const ledger = await readLedger(ctx, args.project_path, cwd, exec.signal)
      const cost = Math.max(projectCost(project), ledgerCost(ledger))
      if (cost > project.budgetCny) {
        findings.push({ check: 'budget', level: 'block', detail: `reported cost ${cost.toFixed(2)} CNY exceeds the ${project.budgetCny.toFixed(2)} CNY budget` })
      }

      // A successful delivery always probes at least one video; the block below
      // refuses the call before this placeholder can reach the result.
      let probe: MediaProbe = { hasAudio: false }
      let videoCount = 0
      for (const file of args.files) {
        const target = await ctx.fs.resolve(file.path, { cwd })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined || info.type !== 'file') {
          findings.push({ check: 'file', level: 'block', detail: `${file.path} is missing` })
          continue
        }
        if (info.size === 0) {
          findings.push({ check: 'file', level: 'block', detail: `${file.path} is empty` })
          continue
        }
        if (file.format === 'video') {
          videoCount += 1
          probe = await probeMedia(ctx, file.path, {
            cwd,
            ffmpegPath: media.settings.ffmpegPath,
            ffprobePath: media.settings.ffprobePath,
            subtitleFont: media.settings.subtitleFont,
            signal: exec.signal,
          })
          if (probe.width === undefined || probe.height === undefined) {
            findings.push({ check: 'video_stream', level: 'block', detail: `${file.path} has no readable video stream` })
          }
          if (!probe.hasAudio) {
            findings.push({ check: 'audio_stream', level: 'warn', detail: `${file.path} has no audio stream` })
          }
          if (probe.durationSec !== undefined && planned > 0) {
            const delta = Math.abs(probe.durationSec - planned) / planned
            if (delta > 0.15) {
              findings.push({
                check: 'duration',
                level: 'warn',
                detail: `${file.path} is ${probe.durationSec.toFixed(2)}s against a ${planned.toFixed(2)}s shot plan`,
              })
            }
          }
        }
      }
      if (videoCount === 0) {
        findings.push({ check: 'file', level: 'block', detail: 'no file was declared with format `video`' })
      }
      const blocking = findings.filter(finding => finding.level === 'block')
      const message = findings.length === 0
        ? `Delivered ${args.files.length} file(s) for ${project.id}; all checks passed.`
        : [
          `Delivery checks for ${project.id}: ${blocking.length} blocking, ${findings.length - blocking.length} warning(s).`,
          ...findings.map(finding => `${finding.level.toUpperCase()} ${finding.check}: ${finding.detail}`),
        ].join('\n')
      if (blocking.length > 0) {
        throw new MediaFailure(message, 'MEDIA_DELIVERY_BLOCKED')
      }
      return { message, ok: true, findings, probe }
    },
  })
}
