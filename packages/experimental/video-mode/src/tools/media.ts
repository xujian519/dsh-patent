/**
 * The model-facing `media` tool: list models, estimate a request, submit a
 * generation, read its status, or cancel it. One tool with an action
 * discriminator keeps the fixed prompt cost to one schema while the actions
 * share kind, model, and output-path vocabulary.
 * @module @deepseek-ai/dsh-video-mode/tools/media
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type MediaRuntime from '../media.ts'
import { projectCost, readProject } from '../project.ts'
import {
  appendLedgerEntry,
  findTaskRecord,
  forgetTask,
  ledgerCost,
  readLedger,
  recordTask,
  taskRequestOf,
} from '../store.ts'
import { formatSrt } from '../subtitles.ts'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaRequest,
  type MediaTask,
  type MediaTaskRecord,
  type MediaTaskStatus,
} from '../types.ts'
import { derivedPath, hostPathOf, subtitlePathOf, workingDirectoryOf, writeArtifact } from './shared.ts'

/** Task states a journal record can be resumed from. */
const PENDING: ReadonlySet<MediaTaskStatus> = new Set(['queued', 'submitted', 'running'])

/**
 * Write every artifact of a settled task through the Session filesystem.
 * @param ctx - tool context.
 * @param artifacts - settled artifacts.
 * @param outputPath - declared output path.
 * @param cwd - Session working directory.
 * @param maxBytes - deployment artifact cap.
 * @param signal - caller cancellation.
 * @returns written artifacts and caption sidecar paths.
 */
async function writeArtifacts(
  ctx: Context,
  artifacts: readonly MediaArtifact[],
  outputPath: string,
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ artifacts: WrittenArtifact[]; captions: string[] }> {
  const written: WrittenArtifact[] = []
  const captions: string[] = []
  for (const [index, artifact] of artifacts.entries()) {
    const path = derivedPath(outputPath, index)
    const result = await writeArtifact(ctx, artifact, path, cwd, maxBytes, signal)
    const subtitlesPath = await writeCaptions(ctx, artifact, path, cwd, maxBytes, signal)
    if (subtitlesPath !== undefined) captions.push(subtitlesPath)
    written.push({ ...result, mediaType: artifact.mediaType, ...subtitlesPath === undefined ? {} : { subtitlesPath } })
  }
  return { artifacts: written, captions }
}

/**
 * Close one successful settlement: drop its journal record and append the
 * charge to the project ledger. Repeat calls are idempotent.
 * @param ctx - tool context.
 * @param projectPath - project file path, when the call named one.
 * @param task - settled task.
 * @param cwd - Session working directory.
 * @param signal - caller cancellation.
 */
async function settleTask(
  ctx: Context,
  projectPath: string | undefined,
  task: MediaTask,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  if (projectPath === undefined) return
  if (task.cost?.currency === 'CNY') {
    await appendLedgerEntry(ctx, projectPath, {
      taskId: task.id,
      kind: task.kind,
      model: task.model,
      costCny: task.cost.amountMinor / 100,
      at: new Date().toISOString(),
    }, cwd, signal)
  }
  // Keep the record when the charge failed, so a retry can settle again.
  await forgetTask(ctx, projectPath, task.id, cwd, signal)
}

/** One artifact the call wrote, including an optional caption sidecar. */
interface WrittenArtifact {
  readonly path: string
  readonly bytes: number
  readonly mediaType: string
  readonly subtitlesPath?: string
}

/** Model-visible result of one `media` call. */
interface MediaToolValue {
  readonly action: string
  readonly message: string
  readonly models?: {
    readonly id: string
    readonly kind: string
    readonly provider: string
    readonly price?: { readonly amountMinor: number; readonly currency: string; readonly unit: string }
  }[]
  readonly estimate?: {
    readonly confidence: string
    readonly cost?: { readonly amountMinor: number; readonly currency: string }
    readonly durationSec?: number
  }
  readonly task?: {
    readonly id: string
    readonly status: string
    readonly progress?: number
  }
  readonly artifacts?: WrittenArtifact[]
}

/**
 * Write the caption sidecar one speech artifact carries.
 * @param ctx - tool context.
 * @param artifact - settled artifact.
 * @param path - declared audio path, relative to `cwd`.
 * @param cwd - Session working directory.
 * @param maxBytes - deployment artifact cap.
 * @param signal - caller cancellation.
 * @returns the written SRT path, or undefined when the artifact has no captions.
 */
async function writeCaptions(
  ctx: Context,
  artifact: MediaArtifact,
  path: string,
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (artifact.subtitles === undefined || artifact.subtitles.length === 0) return undefined
  const sidecar: MediaArtifact = {
    id: `${artifact.id}-subtitles`,
    kind: 'speech',
    mediaType: 'application/x-subrip',
    bytes: new TextEncoder().encode(formatSrt(artifact.subtitles)),
  }
  const written = await writeArtifact(ctx, sidecar, subtitlePathOf(path), cwd, maxBytes, signal)
  return written.path
}

/** One estimate rendered for the model. */
function renderEstimate(estimate: MediaEstimate): NonNullable<MediaToolValue['estimate']> {
  return {
    confidence: estimate.confidence,
    ...estimate.cost === undefined ? {} : { cost: { amountMinor: estimate.cost.amountMinor, currency: estimate.cost.currency } },
    ...estimate.durationSec === undefined ? {} : { durationSec: estimate.durationSec },
  }
}

/** One task identity rendered for the model. */
function renderTask(task: MediaTask): NonNullable<MediaToolValue['task']> {
  return {
    id: task.id,
    status: task.status,
    ...task.progress === undefined ? {} : { progress: task.progress },
  }
}

/**
 * Build the normalized request from model arguments.
 * @param args - validated tool arguments.
 * @returns the media request.
 */
function requestFrom(args: {
  kind?: MediaKind
  model?: string
  prompt?: string
  negative_prompt?: string
  duration_sec?: number
  aspect_ratio?: string
  resolution?: string
  seed?: number
  voice?: string
  subtitles?: boolean
}): MediaRequest {
  if (args.kind === undefined) throw new MediaFailure('media requires `kind` for this action', 'MEDIA_REQUEST_INVALID')
  if (args.prompt === undefined || args.prompt.trim().length === 0) {
    throw new MediaFailure('media requires a non-empty `prompt` for this action', 'MEDIA_REQUEST_INVALID')
  }
  if (args.subtitles === true && args.kind !== 'speech') {
    throw new MediaFailure('media accepts `subtitles` for speech only', 'MEDIA_REQUEST_INVALID')
  }
  return {
    kind: args.kind,
    prompt: args.prompt,
    ...args.model === undefined ? {} : { model: args.model },
    ...args.negative_prompt === undefined ? {} : { negativePrompt: args.negative_prompt },
    ...args.duration_sec === undefined ? {} : { durationSec: args.duration_sec },
    ...args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio },
    ...args.resolution === undefined ? {} : { resolution: args.resolution },
    ...args.seed === undefined ? {} : { seed: args.seed },
    ...args.voice === undefined ? {} : { voice: args.voice },
    ...args.subtitles === undefined ? {} : { subtitles: args.subtitles },
  }
}

/**
 * Create the `media` tool.
 * @param ctx - plugin context.
 * @param media - media runtime.
 * @returns the registry-ready tool.
 */
export function createMediaTool(ctx: Context, media: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'media',
    description: 'Generate or inspect images, video clips, and speech through the configured media providers. '
      + 'Actions: `models` lists available models and prices; `estimate` previews cost and duration without generating; '
      + '`generate` submits one generation and writes the artifact to `output_path`; `status` polls one task once and writes a settled artifact when `output_path` is given; '
      + '`cancel` stops one. `status` with `project_path` recovers a task journaled before a runtime restart. '
      + 'Prefer `estimate` before a paid generation. '
      + 'Speech accepts `subtitles` and then writes an `.srt` sidecar beside the audio. '
      + 'The synthetic provider is for demos and tests; configure a real provider for production. '
      + 'Generated files land under the Session workspace; keep each shot in its own directory.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['models', 'estimate', 'generate', 'status', 'cancel'],
        description: 'Operation to run.',
      },
      kind: {
        type: 'string', enum: ['image', 'video', 'speech'],
        description: 'Capability to generate. Required for estimate and generate.',
      },
      model: { type: 'string', description: 'Model id from `models`; omitted uses the configured default.' },
      prompt: { type: 'string', description: 'Positive generation prompt. Required for estimate and generate.' },
      negative_prompt: { type: 'string', description: 'Content the model should avoid.' },
      duration_sec: { type: 'number', description: 'Requested video or speech duration in seconds.' },
      aspect_ratio: { type: 'string', description: 'Requested aspect ratio, for example `9:16`.' },
      resolution: { type: 'string', description: 'Requested resolution, for example `720p`.' },
      seed: { type: 'integer', description: 'Deterministic seed when the provider accepts one.' },
      first_frame_path: {
        type: 'string',
        description: 'Image that starts the video clip, relative to the Session working directory. Sent as the provider first-frame reference; video only.',
      },
      voice: { type: 'string', description: 'Speech voice id.' },
      subtitles: {
        type: 'boolean',
        description: 'Request timed captions with speech. Generate writes an `.srt` sidecar beside the audio.',
      },
      output_path: { type: 'string', description: 'Artifact path relative to the Session working directory. Required for generate.' },
      wait: {
        type: 'boolean',
        description: 'Wait for settlement before returning. Defaults to true; a false value submits and returns the task id immediately.',
      },
      task_id: { type: 'string', description: 'Task id for status and cancel.' },
      project_path: {
        type: 'string',
        description: 'Project file used to enforce the remaining budget and to journal in-flight tasks. Pass it on generate and status so a restart can resume the task.',
      },
      confirm_cost: {
        type: 'boolean',
        description: 'Confirm a generation whose estimated cost is above the configured approval threshold. Ask the user first.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
          models: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                price: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    amountMinor: { type: 'integer', required: true },
                    currency: { type: 'string', required: true },
                    unit: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          estimate: {
            type: 'object', additionalProperties: false,
            properties: {
              confidence: { type: 'string', required: true },
              cost: {
                type: 'object', additionalProperties: false,
                properties: {
                  amountMinor: { type: 'integer', required: true },
                  currency: { type: 'string', required: true },
                },
              },
              durationSec: { type: 'number' },
            },
          },
          task: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              status: { type: 'string', required: true },
              progress: { type: 'number' },
            },
          },
          artifacts: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                mediaType: { type: 'string', required: true },
                subtitlesPath: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec): Promise<MediaToolValue> {
      switch (args.action) {
        case 'models': {
          const models = media.models(args.kind)
          return {
            action: 'models',
            message: models.length === 0
              ? `No media models serve ${args.kind ?? 'any capability'}. Mount a provider or enable the synthetic provider.`
              : models.map(model => `${model.provider}/${model.id} [${model.kind}]${model.price === undefined ? '' : ` ${model.price.amountMinor} ${model.price.currency} minor units per ${model.price.unit}`}`).join('\n'),
            models: models.map((model) => {
              const price = model.price === undefined
                ? undefined
                : {
                  amountMinor: model.price.amountMinor,
                  currency: model.price.currency,
                  unit: model.price.unit,
                }
              return {
                id: model.id,
                kind: model.kind,
                provider: model.provider,
                ...price === undefined ? {} : { price },
              }
            }),
          }
        }
        case 'estimate': {
          const estimate = media.estimate(requestFrom(args))
          return {
            action: 'estimate',
            message: `Estimated ${estimate.cost === undefined ? 'an unknown cost' : `${estimate.cost.amountMinor} ${estimate.cost.currency} minor units`} with ${estimate.confidence} confidence.`,
            estimate: renderEstimate(estimate),
          }
        }
        case 'generate': {
          const cwd = await workingDirectoryOf(ctx, exec)
          if (args.output_path === undefined || args.output_path.trim().length === 0) {
            throw new MediaFailure('media generate requires `output_path`', 'MEDIA_REQUEST_INVALID')
          }
          const request = requestFrom(args)
          const firstFramePath = args.first_frame_path
          const framed: MediaRequest = firstFramePath === undefined
            ? request
            : {
              ...request,
              references: [{ kind: 'image', role: 'first-frame', path: await hostPathOf(ctx, firstFramePath, cwd) }],
            }
          if (args.project_path !== undefined) {
            const project = await readProject(ctx, args.project_path, cwd, exec.signal)
            const ledger = await readLedger(ctx, args.project_path, cwd, exec.signal)
            const spent = Math.max(projectCost(project), ledgerCost(ledger))
            const remaining = project.budgetCny - spent
            const estimate = media.estimate(framed)
            const costCny = estimate.cost?.currency === 'CNY' ? estimate.cost.amountMinor / 100 : undefined
            if (costCny !== undefined && costCny > remaining) {
              throw new MediaFailure(
                `estimated ${costCny.toFixed(2)} CNY exceeds the ${remaining.toFixed(2)} CNY remaining in the project budget; `
                + 'raise the budget or use a cheaper model',
                'MEDIA_BUDGET_EXCEEDED',
              )
            }
            if (estimate.cost !== undefined && costCny === undefined && args.confirm_cost !== true) {
              throw new MediaFailure(
                'the estimate is not in CNY and cannot be compared with the project budget; ask the user, then retry with confirm_cost',
                'MEDIA_BUDGET_EXCEEDED',
              )
            }
            if (costCny !== undefined && costCny > media.settings.approvalThresholdCny && args.confirm_cost !== true) {
              throw new MediaFailure(
                `estimated ${costCny.toFixed(2)} CNY is above the ${media.settings.approvalThresholdCny.toFixed(2)} CNY confirmation threshold; `
                + 'ask the user, then retry with confirm_cost: true',
                'MEDIA_BUDGET_EXCEEDED',
              )
            }
          }
          const submitted = await media.submit(framed, exec.signal)
          if (args.project_path !== undefined && PENDING.has(submitted.status)) {
            await recordTask(ctx, args.project_path, {
              task: {
                id: submitted.id,
                provider: submitted.provider,
                model: submitted.model,
                kind: submitted.kind,
                status: submitted.status,
              },
              submittedAt: Date.now(),
              request: taskRequestOf(framed, submitted.model),
              outputPath: args.output_path,
            }, cwd, exec.signal)
          }
          const task = args.wait === false ? submitted : await media.wait(submitted, exec.signal)
          if (task.status === 'failed') {
            if (args.project_path !== undefined) await forgetTask(ctx, args.project_path, task.id, cwd, exec.signal)
            throw new MediaFailure(`media task ${task.id} failed: ${task.error?.message ?? 'provider reported failure'}`, 'MEDIA_TASK_FAILED')
          }
          if (task.status === 'cancelled') {
            if (args.project_path !== undefined) await forgetTask(ctx, args.project_path, task.id, cwd, exec.signal)
            throw new MediaFailure(`media task ${task.id} was cancelled`, 'MEDIA_TASK_FAILED')
          }
          if (task.status !== 'succeeded') {
            return {
              action: 'generate',
              message: `Submitted ${task.kind} task ${task.id} (${task.status}). Read it with media status and the same output_path, then write its artifact.`,
              task: renderTask(task),
            }
          }
          const written = await writeArtifacts(
            ctx, task.artifacts ?? [], args.output_path, cwd, media.settings.maxArtifactBytes, exec.signal,
          )
          if (written.artifacts.length === 0) {
            throw new MediaFailure(`media task ${task.id} succeeded without artifacts`, 'MEDIA_ARTIFACT_INVALID')
          }
          await settleTask(ctx, args.project_path, task, cwd, exec.signal)
          return {
            action: 'generate',
            message: `Generated ${task.kind} with ${task.provider}/${task.model}. Wrote ${written.artifacts.map(entry => entry.path).join(', ')}.`
              + (written.captions.length === 0 ? '' : ` Captions: ${written.captions.join(', ')}.`)
              + (task.cost === undefined ? '' : ` Cost ${task.cost.amountMinor} ${task.cost.currency} minor units.`),
            task: renderTask(task),
            artifacts: written.artifacts,
          }
        }
        case 'status': {
          if (args.task_id === undefined) throw new MediaFailure('media status requires `task_id`', 'MEDIA_REQUEST_INVALID')
          const cwd = await workingDirectoryOf(ctx, exec)
          let recovered: MediaTaskRecord | undefined
          let task: MediaTask
          try {
            task = await media.refresh(args.task_id, exec.signal)
          } catch (error) {
            if (!(error instanceof MediaFailure) || error.code !== 'MEDIA_TASK_NOT_FOUND' || args.project_path === undefined) throw error
            recovered = await findTaskRecord(ctx, args.project_path, args.task_id, cwd, exec.signal)
            if (recovered === undefined) throw error
            media.resume(recovered)
            task = await media.refresh(args.task_id, exec.signal)
          }
          const outputPath = args.output_path ?? recovered?.outputPath
          const written: { artifacts: WrittenArtifact[]; captions: string[] } =
            task.status === 'succeeded' && task.artifacts !== undefined && outputPath !== undefined
              ? await writeArtifacts(ctx, task.artifacts, outputPath, cwd, media.settings.maxArtifactBytes, exec.signal)
              : { artifacts: [], captions: [] }
          if (task.status === 'succeeded' && task.artifacts !== undefined && outputPath !== undefined) {
            await settleTask(ctx, args.project_path, task, cwd, exec.signal)
          }
          if (task.status === 'failed' || task.status === 'cancelled') {
            if (args.project_path !== undefined) await forgetTask(ctx, args.project_path, task.id, cwd, exec.signal)
          }
          return {
            action: 'status',
            message: `Task ${task.id} is ${task.status}${task.error === undefined ? '' : `: ${task.error.message}`}.`
              + (written.artifacts.length === 0 ? '' : ` Wrote ${written.artifacts.map(entry => entry.path).join(', ')}.`)
              + (written.captions.length === 0 ? '' : ` Captions: ${written.captions.join(', ')}.`),
            task: renderTask(task),
            ...written.artifacts.length === 0 ? {} : { artifacts: written.artifacts },
          }
        }
        case 'cancel': {
          if (args.task_id === undefined) throw new MediaFailure('media cancel requires `task_id`', 'MEDIA_REQUEST_INVALID')
          const task = await media.cancel(args.task_id)
          if (args.project_path !== undefined) {
            await forgetTask(ctx, args.project_path, task.id, await workingDirectoryOf(ctx, exec), exec.signal)
          }
          return { action: 'cancel', message: `Task ${task.id} is ${task.status}.`, task: renderTask(task) }
        }
      }
    },
  })
}
