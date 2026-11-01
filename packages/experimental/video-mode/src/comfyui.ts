/**
 * Local ComfyUI media provider. It submits an API-format workflow to a running
 * ComfyUI server, polls its history, and downloads the produced file. The
 * bundled workflows target Wan 2.2 TI2V-5B for video and Z-Image Turbo for
 * images; a deployment can point either kind at its own workflow file.
 *
 * ComfyUI runs on the operator's machine, so a task costs no provider money and
 * the estimate reports zero CNY. GPU time is the real cost.
 * @module @deepseek-ai/dsh-experimental-video-mode/comfyui
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { WAN22_TI2V_WORKFLOW, Z_IMAGE_WORKFLOW, type ComfyWorkflow, type ComfyWorkflowNode } from './comfyui-workflows.ts'
import { requestOfTask } from './store.ts'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaModel,
  type MediaProvider,
  type MediaRequest,
  type MediaTask,
  type MediaTaskRecord,
} from './types.ts'
import { isRecord } from '@deepseek-ai/dsh-value'

/** Registered provider id of the local ComfyUI backend. */
export const COMFYUI_PROVIDER_ID = 'comfyui'

/** Default video model id served by the bundled Wan 2.2 workflow. */
export const COMFYUI_VIDEO_MODEL = 'wan2.2-ti2v-5b'

/** Default image model id served by the bundled Z-Image workflow. */
export const COMFYUI_IMAGE_MODEL = 'z-image-turbo'

/** Video settings after defaults. */
export interface ComfyUiVideoSettings {
  /** Model id reported to consumers. */
  readonly model: string
  /** API-format workflow file; empty uses the bundled Wan 2.2 graph. */
  readonly workflowPath: string
  /** UNET file name under `models/diffusion_models`. */
  readonly checkpoint: string
  /** Text encoder file name under `models/text_encoders`. */
  readonly textEncoder: string
  /** VAE file name under `models/vae`. */
  readonly vae: string
  /** Short side requested from `480p`, `720p`, or another `<n>p` value. */
  readonly resolution: string
  /** Frame rate written by `CreateVideo`. */
  readonly fps: number
  /** Duration used when the request omits one. */
  readonly defaultDurationSec: number
  /** Longest accepted request duration. */
  readonly maxDurationSec: number
  /** Negative prompt used when the request omits one. */
  readonly negativePrompt: string
}

/** Image settings after defaults. */
export interface ComfyUiImageSettings {
  /** Model id reported to consumers. */
  readonly model: string
  /** API-format workflow file; empty uses the bundled Z-Image graph. */
  readonly workflowPath: string
  /** UNET file name under `models/diffusion_models`. */
  readonly checkpoint: string
  /** Text encoder file name under `models/text_encoders`. */
  readonly textEncoder: string
  /** VAE file name under `models/vae`. */
  readonly vae: string
  /** Long side of a generated image in pixels. */
  readonly size: number
}

/** Resolved settings of the local ComfyUI provider. */
export interface ComfyUiSettings {
  /** ComfyUI HTTP origin, for example `http://127.0.0.1:8188`. */
  readonly baseUrl: string
  /** Minimum gap between two history polls for one task. */
  readonly pollMs: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs: number
  /** Output subdirectory prefix the server writes into. */
  readonly outputPrefix: string
  /** Largest accepted artifact size in bytes. */
  readonly maxArtifactBytes: number
  /** Video configuration. */
  readonly video: ComfyUiVideoSettings
  /** Image configuration. */
  readonly image: ComfyUiImageSettings
}

/** Minimal fetch surface the provider needs; tests inject a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Values substituted into `{{name}}` placeholders of a workflow. */
export interface WorkflowValues {
  /** Positive prompt. */
  readonly prompt: string
  /** Negative prompt. */
  readonly negativePrompt: string
  /** Sampler seed. */
  readonly seed: number
  /** Canvas width in pixels. */
  readonly width: number
  /** Canvas height in pixels. */
  readonly height: number
  /** Video frame count; images ignore it. */
  readonly frames: number
  /** Video frame rate. */
  readonly fps: number
  /** Server-side output prefix. */
  readonly filenamePrefix: string
  /** UNET file name. */
  readonly checkpoint: string
  /** Text encoder file name. */
  readonly textEncoder: string
  /** VAE file name. */
  readonly vae: string
}

/** Placeholder names accepted by {@link fillWorkflow}. */
const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g

/** Map a placeholder key to the value that replaces it. */
const VALUE_BY_KEY: Readonly<Record<string, keyof WorkflowValues | undefined>> = {
  prompt: 'prompt',
  negative_prompt: 'negativePrompt',
  seed: 'seed',
  width: 'width',
  height: 'height',
  frames: 'frames',
  fps: 'fps',
  filename_prefix: 'filenamePrefix',
  checkpoint: 'checkpoint',
  text_encoder: 'textEncoder',
  vae: 'vae',
}

/** Minimal API-format workflow validation used for operator-supplied files. */
const workflowFileSchema = z.record(
  z.string(),
  z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }),
)

/**
 * Replace `{{name}}` placeholders throughout a workflow. A string that is
 * exactly one placeholder keeps the replacement's type, so integer inputs stay
 * numbers and `length`/`seed`/`width` pass ComfyUI validation.
 * @param workflow - template graph.
 * @param values - substitution values.
 * @returns a new graph with every placeholder resolved.
 */
export function fillWorkflow(workflow: ComfyWorkflow, values: WorkflowValues): ComfyWorkflow {
  const filled: Record<string, ComfyWorkflowNode> = {}
  for (const [id, node] of Object.entries(workflow)) {
    filled[id] = { class_type: node.class_type, inputs: fillInputs(node.inputs, values) }
  }
  return filled
}

/**
 * Replace placeholders in one node's inputs.
 * @param inputs - template inputs.
 * @param values - substitution values.
 * @returns the replaced inputs.
 */
function fillInputs(inputs: Readonly<Record<string, unknown>>, values: WorkflowValues): Record<string, unknown> {
  const filled: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(inputs)) filled[key] = fillInput(value, values)
  return filled
}

/**
 * Recursively replace placeholders in one JSON value.
 * @param value - template fragment.
 * @param values - substitution values.
 * @returns the replaced fragment; an exact placeholder keeps the value's type.
 */
function fillInput(value: unknown, values: WorkflowValues): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{([a-z_]+)\}\}$/.exec(value)
    const exact = whole?.[1]
    if (exact !== undefined) {
      const key = VALUE_BY_KEY[exact]
      if (key !== undefined) return values[key]
    }
    return value.replace(PLACEHOLDER, (match, name: string) => {
      const key = VALUE_BY_KEY[name]
      return key === undefined ? match : String(values[key])
    })
  }
  if (Array.isArray(value)) return value.map(entry => fillInput(entry, values))
  if (typeof value === 'object' && value !== null) {
    const filled: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) filled[key] = fillInput(entry, values)
    return filled
  }
  return value
}

/**
 * Read a workflow file, or return the bundled template when the path is empty.
 * @param path - configured workflow path.
 * @param bundled - template used when `path` is empty.
 * @returns the parsed workflow.
 * @throws When the file is unreadable or is not an API-format graph.
 */
export function loadWorkflow(path: string, bundled: ComfyWorkflow): ComfyWorkflow {
  if (path.length === 0) return bundled
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`video mode: cannot read the ComfyUI workflow ${path}: ${messageOf(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`video mode: the ComfyUI workflow ${path} is not JSON: ${messageOf(error)}`, { cause: error })
  }
  const result = workflowFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`video mode: the ComfyUI workflow ${path} is not an API-format workflow: ${result.error.message}`)
  }
  return result.data
}

/**
 * Compute a canvas for an aspect ratio at a given short side, rounded to the
 * model's required pixel multiple.
 * @param aspectRatio - `9:16`, `16:9`, or `1:1`.
 * @param shortSide - requested short side in pixels.
 * @param multiple - pixel multiple required by the model.
 * @returns width and height.
 * @throws {@link MediaFailure} `MEDIA_REQUEST_INVALID` for an unsupported ratio.
 */
export function canvasFor(aspectRatio: string, shortSide: number, multiple: number): { readonly width: number; readonly height: number } {
  const round = (value: number): number => Math.max(multiple, Math.round(value / multiple) * multiple)
  switch (aspectRatio) {
    case '9:16': return { width: round(shortSide), height: round(shortSide * 16 / 9) }
    case '16:9': return { width: round(shortSide * 16 / 9), height: round(shortSide) }
    case '1:1': return { width: round(shortSide), height: round(shortSide) }
    default:
      throw new MediaFailure(`Unsupported aspect ratio ${JSON.stringify(aspectRatio)}; use 9:16, 16:9, or 1:1`, 'MEDIA_REQUEST_INVALID')
  }
}

/**
 * Add a `LoadImage` node and wire it to the Wan latent node's `start_image`.
 * @param workflow - filled workflow.
 * @param image - uploaded input name.
 * @returns a new workflow whose first frame is the uploaded image.
 * @throws {@link MediaFailure} when the workflow has no Wan latent node.
 */
export function attachStartImage(workflow: ComfyWorkflow, image: string): ComfyWorkflow {
  const latentId = Object.keys(workflow).find(id => workflow[id]?.class_type === 'Wan22ImageToVideoLatent')
  const latent = latentId === undefined ? undefined : workflow[latentId]
  if (latentId === undefined || latent === undefined) {
    throw new MediaFailure(
      'the configured video workflow has no Wan22ImageToVideoLatent node to receive a first frame',
      'MEDIA_REQUEST_INVALID',
    )
  }
  const nodeIds = Object.keys(workflow).map(Number).filter(Number.isFinite)
  const imageId = String((nodeIds.length === 0 ? 0 : Math.max(...nodeIds)) + 1)
  return {
    ...workflow,
    [imageId]: { class_type: 'LoadImage', inputs: { image } },
    [latentId]: {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: { ...latent.inputs, start_image: [imageId, 0] },
    },
  }
}

/**
 * Image canvas for an aspect ratio at a given long side, rounded to 16 pixels.
 * @param aspectRatio - `9:16`, `16:9`, or `1:1`.
 * @param longSide - requested long side in pixels.
 * @returns width and height.
 * @throws {@link MediaFailure} `MEDIA_REQUEST_INVALID` for an unsupported ratio.
 */
function imageCanvasFor(aspectRatio: string, longSide: number): { readonly width: number; readonly height: number } {
  const round = (value: number): number => Math.max(256, Math.round(value / 16) * 16)
  switch (aspectRatio) {
    case '9:16': return { width: round(longSide * 9 / 16), height: round(longSide) }
    case '16:9': return { width: round(longSide), height: round(longSide * 9 / 16) }
    case '1:1': return { width: round(longSide), height: round(longSide) }
    default:
      throw new MediaFailure(`Unsupported aspect ratio ${JSON.stringify(aspectRatio)}; use 9:16, 16:9, or 1:1`, 'MEDIA_REQUEST_INVALID')
  }
}

/**
 * Frame count that satisfies Wan's `length % 4 == 1` lattice.
 * @param durationSec - requested duration.
 * @param fps - frame rate.
 * @returns the frame count, at least one.
 */
export function frameCountFor(durationSec: number, fps: number): number {
  return 1 + 4 * Math.max(0, Math.round((durationSec * fps - 1) / 4))
}

/**
 * Parse the short side from a resolution label.
 * @param resolution - label such as `480p`.
 * @returns the pixel count.
 * @throws {@link MediaFailure} `MEDIA_REQUEST_INVALID` for an unsupported label.
 */
export function shortSideOf(resolution: string): number {
  const match = /^(\d+)p$/.exec(resolution)
  const value = match === null ? Number.NaN : Number(match[1])
  if (!Number.isInteger(value) || value < 240 || value > 1080) {
    throw new MediaFailure(`Unsupported resolution ${JSON.stringify(resolution)}; use a label from 240p to 1080p`, 'MEDIA_REQUEST_INVALID')
  }
  return value
}

/** Upper bound on one best-effort cancellation request. */
const CANCEL_TIMEOUT_MS = 10_000

/** One ComfyUI prompt tracked until it settles. */
interface PendingTask {
  /** ComfyUI prompt id. */
  readonly promptId: string
  /** Requested capability. */
  readonly kind: 'image' | 'video'
  /** Submission time in epoch milliseconds. */
  readonly submittedAt: number
  /** Last history poll time in epoch milliseconds. */
  lastPollAt: number
  /** Requested canvas width. */
  readonly width: number
  /** Requested canvas height. */
  readonly height: number
  /** Requested video duration. */
  readonly durationSec?: number
}

/** One file reference returned in a ComfyUI history entry. */
interface SavedFile {
  /** File name inside the output directory. */
  readonly filename: string
  /** Subdirectory relative to the output directory. */
  readonly subfolder: string
  /** ComfyUI folder type, normally `output`. */
  readonly type: string
}

/**
 * ComfyUI provider. `submit` queues one prompt, `poll` reads history and
 * downloads the file, and `cancel` removes it from the queue or interrupts it.
 */
export class ComfyUiMediaProvider implements MediaProvider {
  /** Registered provider id. */
  readonly id = COMFYUI_PROVIDER_ID

  /** Capabilities the configured workflows serve. */
  readonly capabilities: readonly MediaKind[] = ['image', 'video']

  private readonly modelsById: readonly MediaModel[]
  private readonly videoWorkflow: ComfyWorkflow
  private readonly imageWorkflow: ComfyWorkflow
  private readonly pending = new Map<string, PendingTask>()

  /**
   * @param settings - resolved provider settings.
   * @param fetchImpl - fetch implementation; tests inject a stub.
   * @throws When a configured workflow file is unreadable or malformed.
   */
  constructor(
    private readonly settings: ComfyUiSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.videoWorkflow = loadWorkflow(settings.video.workflowPath, WAN22_TI2V_WORKFLOW)
    this.imageWorkflow = loadWorkflow(settings.image.workflowPath, Z_IMAGE_WORKFLOW)
    this.modelsById = [
      {
        id: settings.video.model,
        kind: 'video',
        provider: COMFYUI_PROVIDER_ID,
        maxDurationSec: settings.video.maxDurationSec,
        aspectRatios: ['9:16', '16:9', '1:1'],
        referenceModes: ['image', 'first-frame'],
        audio: false,
        price: { amountMinor: 0, currency: 'CNY', unit: 'video-second' },
      },
      {
        id: settings.image.model,
        kind: 'image',
        provider: COMFYUI_PROVIDER_ID,
        aspectRatios: ['9:16', '16:9', '1:1'],
        price: { amountMinor: 0, currency: 'CNY', unit: 'image' },
      },
    ]
  }

  /** Models the configured workflows serve. */
  models(): readonly MediaModel[] {
    return this.modelsById
  }

  /** The provider is configured; reachability is proven by the first submission. */
  available(): boolean {
    return true
  }

  /**
   * Estimate one local request. Local generation has no per-call charge.
   * @param request - requested generation.
   * @returns zero CNY and the requested duration.
   */
  estimate(request: MediaRequest): MediaEstimate {
    const cost = { amountMinor: 0, currency: 'CNY' as const }
    if (request.kind === 'video') {
      return { cost, durationSec: Math.min(request.durationSec ?? this.settings.video.defaultDurationSec, this.settings.video.maxDurationSec), confidence: 'exact' }
    }
    return request.kind === 'image' ? { cost, confidence: 'exact' } : { confidence: 'unknown' }
  }

  /**
   * Queue one workflow on ComfyUI.
   * @param request - requested generation.
   * @param signal - caller cancellation.
   * @returns the submitted task.
   * @throws {@link MediaFailure} for an unknown model, invalid request, or rejected workflow.
   */
  async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    const kind = request.kind
    if (kind === 'speech') {
      throw new MediaFailure('ComfyUI does not serve speech', 'MEDIA_PROVIDER_UNAVAILABLE')
    }
    const defaultModel = kind === 'video' ? this.settings.video.model : this.settings.image.model
    const model = this.modelsById.find(entry => entry.id === (request.model ?? defaultModel) && entry.kind === kind)
    if (model === undefined) {
      throw new MediaFailure(`ComfyUI serves no ${kind} model ${JSON.stringify(request.model)}`, 'MEDIA_MODEL_UNKNOWN')
    }
    const seed = request.seed ?? Math.floor(Math.random() * 0x7fffffff)
    const prepared = this.prepare({ ...request, kind }, seed)
    const firstFrames = request.references?.filter(reference =>
      reference.kind === 'image' && (reference.role === undefined || reference.role === 'first-frame')) ?? []
    let workflow = prepared.workflow
    if (firstFrames.length > 1) {
      throw new MediaFailure('ComfyUI accepts one first-frame reference per request', 'MEDIA_REQUEST_INVALID')
    }
    const firstFrame = firstFrames[0]
    if (firstFrame !== undefined) {
      if (request.kind !== 'video') {
        throw new MediaFailure('ComfyUI attaches references to video requests only', 'MEDIA_REQUEST_INVALID')
      }
      const uploaded = await this.uploadReference(firstFrame.path, signal)
      workflow = attachStartImage(workflow, uploaded)
    }
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'dsh-video-mode' }),
      signal,
    })
    const body = parseJson(await response.text())
    if (!response.ok) {
      throw new MediaFailure(
        `ComfyUI rejected the ${request.kind} workflow: ${rejectionMessage(body)}`,
        'MEDIA_REQUEST_INVALID',
      )
    }
    const promptId = isRecord(body) && typeof body.prompt_id === 'string' ? body.prompt_id : undefined
    if (promptId === undefined) {
      throw new MediaFailure('ComfyUI accepted the request without returning a prompt id', 'MEDIA_TASK_FAILED')
    }
    this.pending.set(promptId, {
      promptId,
      kind,
      submittedAt: Date.now(),
      lastPollAt: 0,
      width: prepared.width,
      height: prepared.height,
      ...prepared.durationSec === undefined ? {} : { durationSec: prepared.durationSec },
    })
    return {
      id: taskIdOf(promptId),
      provider: this.id,
      model: model.id,
      kind: request.kind,
      status: 'submitted',
    }
  }

  /**
   * Read the ComfyUI queue and history for one task.
   * @param task - current task.
   * @param signal - caller cancellation.
   * @returns the latest task.
   * @throws {@link MediaFailure} for transport failures.
   */
  async poll(task: MediaTask, signal: AbortSignal): Promise<MediaTask> {
    const promptId = promptIdOf(task.id)
    const pending = this.pending.get(promptId)
    if (pending === undefined) {
      return this.failed(task, 'MEDIA_TASK_FAILED', `task ${task.id} is not tracked; the provider process restarted`)
    }
    const now = Date.now()
    if (now - pending.submittedAt > this.settings.timeoutMs) {
      await this.cancel(task)
      return this.failed(task, 'MEDIA_TASK_TIMEOUT', `task ${task.id} did not settle within ${this.settings.timeoutMs} ms`)
    }
    if (now - pending.lastPollAt < this.settings.pollMs) return task
    pending.lastPollAt = now

    const history = await this.getJson(`/history/${encodeURIComponent(promptId)}`, signal)
    const entry = isRecord(history) ? history[promptId] : undefined
    if (entry !== undefined) return this.settle(task, pending, entry, signal)

    const queue = await this.getJson('/queue', signal)
    const state = queueState(queue, promptId)
    if (state === undefined) {
      this.pending.delete(promptId)
      return this.failed(task, 'MEDIA_TASK_FAILED', `ComfyUI no longer reports task ${promptId}; it may have restarted`)
    }
    return { ...task, status: state }
  }

  /**
   * Rebuild in-flight state from a journal record so history polling can
   * continue after the runtime restarted.
   * @param record - persisted task snapshot and request.
   * @returns the resumed task, or undefined when the record belongs to another provider.
   */
  resume(record: MediaTaskRecord): MediaTask | undefined {
    if (record.task.provider !== this.id || record.task.kind === 'speech') return undefined
    const promptId = promptIdOf(record.task.id)
    if (promptId === record.task.id || promptId.length === 0) return undefined
    const prepared = this.prepare({ ...requestOfTask(record.request), kind: record.task.kind }, 0)
    this.pending.set(promptId, {
      promptId,
      kind: record.task.kind,
      submittedAt: record.submittedAt,
      lastPollAt: 0,
      width: prepared.width,
      height: prepared.height,
      ...prepared.durationSec === undefined ? {} : { durationSec: prepared.durationSec },
    })
    return record.task
  }

  /**
   * Remove a queued prompt or interrupt a running one.
   * @param task - task to cancel.
   */
  async cancel(task: MediaTask): Promise<void> {
    const promptId = promptIdOf(task.id)
    await this.postQuietly('/queue', { delete: [promptId] })
    await this.postQuietly('/interrupt', { prompt_id: promptId })
    this.pending.delete(promptId)
  }

  /**
   * Build the workflow and canvas for one request.
   * @param request - requested generation.
   * @param seed - resolved sampler seed.
   * @returns the filled workflow and the canvas it renders.
   * @throws {@link MediaFailure} for an invalid option.
   */
  private prepare(request: MediaRequest & { readonly kind: 'image' | 'video' }, seed: number): {
    readonly workflow: ComfyWorkflow
    readonly width: number
    readonly height: number
    readonly durationSec?: number
  } {
    const prefix = `${this.settings.outputPrefix}/${request.kind}`
    if (request.kind === 'video') {
      const durationSec = Math.min(request.durationSec ?? this.settings.video.defaultDurationSec, this.settings.video.maxDurationSec)
      if (!(durationSec > 0)) throw new MediaFailure('video duration must be positive', 'MEDIA_REQUEST_INVALID')
      const canvas = canvasFor(request.aspectRatio ?? '9:16', shortSideOf(request.resolution ?? this.settings.video.resolution), 32)
      const { video } = this.settings
      return {
        workflow: fillWorkflow(this.videoWorkflow, {
          prompt: request.prompt,
          negativePrompt: request.negativePrompt ?? video.negativePrompt,
          seed,
          width: canvas.width,
          height: canvas.height,
          frames: frameCountFor(durationSec, video.fps),
          fps: video.fps,
          filenamePrefix: prefix,
          checkpoint: video.checkpoint,
          textEncoder: video.textEncoder,
          vae: video.vae,
        }),
        width: canvas.width,
        height: canvas.height,
        durationSec,
      }
    }
    const canvas = imageCanvasFor(request.aspectRatio ?? '1:1', this.settings.image.size)
    const { image } = this.settings
    return {
      workflow: fillWorkflow(this.imageWorkflow, {
        prompt: request.prompt,
        negativePrompt: request.negativePrompt ?? '',
        seed,
        width: canvas.width,
        height: canvas.height,
        frames: 1,
        fps: this.settings.video.fps,
        filenamePrefix: prefix,
        checkpoint: image.checkpoint,
        textEncoder: image.textEncoder,
        vae: image.vae,
      }),
      width: canvas.width,
      height: canvas.height,
    }
  }

  /**
   * Upload one local image as a ComfyUI input.
   * @param path - host path of the image.
   * @param signal - caller cancellation.
   * @returns the input name, including its subfolder, for `LoadImage`.
   * @throws {@link MediaFailure} when the file is unreadable or the upload is rejected.
   */
  private async uploadReference(path: string, signal: AbortSignal): Promise<string> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new MediaFailure(`cannot read the first-frame image ${path}: ${messageOf(error)}`, 'MEDIA_REQUEST_INVALID', { cause: error })
    }
    const form = new FormData()
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    form.append('image', new Blob([buffer]), basename(path))
    form.append('overwrite', 'true')
    const response = await this.request('/upload/image', { method: 'POST', body: form, signal })
    const body = parseJson(await response.text())
    if (!response.ok) {
      throw new MediaFailure(`ComfyUI rejected the first-frame upload with HTTP ${response.status}`, 'MEDIA_REQUEST_INVALID')
    }
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : undefined
    if (name === undefined) {
      throw new MediaFailure('ComfyUI accepted the upload without returning a file name', 'MEDIA_REQUEST_INVALID')
    }
    const subfolder = isRecord(body) && typeof body.subfolder === 'string' ? body.subfolder : ''
    return subfolder.length === 0 ? name : `${subfolder}/${name}`
  }

  /**
   * Turn a completed history entry into a settled task with downloaded bytes.
   * @param task - current task.
   * @param pending - tracked submission.
   * @param entry - history entry.
   * @param signal - caller cancellation.
   * @returns the settled task.
   */
  private async settle(task: MediaTask, pending: PendingTask, entry: unknown, signal: AbortSignal): Promise<MediaTask> {
    if (!isRecord(entry)) {
      this.pending.delete(pending.promptId)
      return this.failed(task, 'MEDIA_TASK_FAILED', 'ComfyUI returned a malformed history entry')
    }
    const status = isRecord(entry.status) ? entry.status : undefined
    if (status?.status_str === 'error') {
      this.pending.delete(pending.promptId)
      return this.failed(task, 'MEDIA_TASK_FAILED', executionError(status) ?? 'ComfyUI reported a workflow error')
    }
    if (status?.completed !== true) {
      return { ...task, status: 'running' }
    }
    const files = savedFiles(entry.outputs)
    const file = files.find(candidate => isPreferred(candidate.filename, pending.kind))
    if (file === undefined) {
      this.pending.delete(pending.promptId)
      return this.failed(task, 'MEDIA_ARTIFACT_INVALID', `ComfyUI finished ${pending.promptId} without a ${pending.kind} file`)
    }
    let artifact: MediaArtifact
    try {
      artifact = await this.download(file, pending, signal)
    } catch (error) {
      this.pending.delete(pending.promptId)
      if (error instanceof MediaFailure) return this.failed(task, error.code, error.message)
      return this.failed(task, 'MEDIA_TASK_FAILED', messageOf(error))
    }
    this.pending.delete(pending.promptId)
    return {
      ...task,
      status: 'succeeded',
      artifacts: [artifact],
      cost: { amountMinor: 0, currency: 'CNY' },
    }
  }

  /**
   * Download one produced file and validate its size.
   * @param file - file reference from history.
   * @param pending - tracked submission.
   * @param signal - caller cancellation.
   * @returns the artifact with inline bytes.
   * @throws {@link MediaFailure} for oversized or unreadable output.
   */
  private async download(file: SavedFile, pending: PendingTask, signal: AbortSignal): Promise<MediaArtifact> {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const response = await this.request(`/view?${query.toString()}`, { signal })
    if (!response.ok) {
      throw new MediaFailure(`ComfyUI could not serve ${file.filename}: HTTP ${response.status}`, 'MEDIA_ARTIFACT_INVALID')
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > this.settings.maxArtifactBytes) {
      throw new MediaFailure(
        `ComfyUI produced ${declared} bytes, above the configured ${this.settings.maxArtifactBytes}-byte cap`,
        'MEDIA_ARTIFACT_TOO_LARGE',
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > this.settings.maxArtifactBytes) {
      throw new MediaFailure(
        `ComfyUI produced ${bytes.length} bytes, above the configured ${this.settings.maxArtifactBytes}-byte cap`,
        'MEDIA_ARTIFACT_TOO_LARGE',
      )
    }
    return {
      id: file.filename,
      kind: pending.kind,
      mediaType: mediaTypeOf(file.filename, pending.kind),
      bytes,
      width: pending.width,
      height: pending.height,
      ...pending.durationSec === undefined ? {} : { durationSec: pending.durationSec },
    }
  }

  /**
   * Perform one HTTP request against the configured origin.
   * @param path - path and query.
   * @param init - fetch options.
   * @returns the response.
   * @throws {@link MediaFailure} `MEDIA_PROVIDER_UNAVAILABLE` for transport failures.
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.settings.baseUrl}${path}`, init)
    } catch (error) {
      throw new MediaFailure(`cannot reach ComfyUI at ${this.settings.baseUrl}: ${messageOf(error)}`, 'MEDIA_PROVIDER_UNAVAILABLE', { cause: error })
    }
  }

  /**
   * Read one JSON response.
   * @param path - path and query.
   * @param signal - caller cancellation.
   * @returns the parsed body.
   * @throws {@link MediaFailure} for a non-success status or invalid JSON.
   */
  private async getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(path, { signal })
    if (!response.ok) {
      throw new MediaFailure(`ComfyUI ${path} returned HTTP ${response.status}`, 'MEDIA_PROVIDER_UNAVAILABLE')
    }
    try {
      return await response.json()
    } catch (error) {
      throw new MediaFailure(`ComfyUI ${path} returned invalid JSON: ${messageOf(error)}`, 'MEDIA_PROVIDER_UNAVAILABLE', { cause: error })
    }
  }

  /**
   * Send one JSON body and ignore failures; used by idempotent cancellation.
   * @param path - endpoint path.
   * @param body - JSON body.
   */
  private async postQuietly(path: string, body: unknown): Promise<void> {
    try {
      const response = await this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      })
      await response.arrayBuffer()
    } catch (error) {
      // Cancellation is best-effort: the task is reported cancelled even when
      // the server already dropped it or is unreachable.
      void error
    }
  }

  /**
   * Build a failed task snapshot.
   * @param task - current task.
   * @param code - failure code.
   * @param message - explanation.
   * @returns the failed task.
   */
  private failed(task: MediaTask, code: MediaFailure['code'], message: string): MediaTask {
    return { ...task, status: 'failed', error: { code, message } }
  }
}

/** Task id for one ComfyUI prompt. */
function taskIdOf(promptId: string): string {
  return `comfyui-${promptId}`
}

/** Recover the prompt id from a task id. */
function promptIdOf(taskId: string): string {
  return taskId.startsWith('comfyui-') ? taskId.slice('comfyui-'.length) : taskId
}

/** Narrow a parsed JSON value to an object. */
/** Read the history status of one prompt. */
function queueState(queue: unknown, promptId: string): 'running' | 'queued' | undefined {
  if (!isRecord(queue)) return undefined
  const running = Array.isArray(queue.queue_running) ? queue.queue_running : []
  if (running.some(item => Array.isArray(item) && item[1] === promptId)) return 'running'
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : []
  if (pending.some(item => Array.isArray(item) && item[1] === promptId)) return 'queued'
  return undefined
}

/** Collect saved files from every node output. */
function savedFiles(outputs: unknown): SavedFile[] {
  if (!isRecord(outputs)) return []
  const files: SavedFile[] = []
  for (const node of Object.values(outputs)) {
    if (!isRecord(node)) continue
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== 'string') continue
        files.push({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : 'output',
        })
      }
    }
  }
  return files
}

/** Whether one output file matches the requested capability. */
function isPreferred(filename: string, kind: 'image' | 'video'): boolean {
  const lower = filename.toLowerCase()
  if (kind === 'video') return lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mkv')
  return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')
}

/** Media type from a preferred image or video file extension. */
function mediaTypeOf(filename: string, kind: 'image' | 'video'): string {
  const lower = filename.toLowerCase()
  if (kind === 'video') {
    if (lower.endsWith('.mp4')) return 'video/mp4'
    if (lower.endsWith('.webm')) return 'video/webm'
    return 'video/x-matroska'
  }
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'image/webp'
}

/** Read the first execution error message from a history status. */
function executionError(status: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(status.messages) ? status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue
    const data: unknown = message[1]
    if (!isRecord(data)) continue
    const text = typeof data.exception_message === 'string' ? data.exception_message.trim() : ''
    if (text.length > 0) return text
  }
  return undefined
}

/** Describe a rejected `/prompt` response. */
function rejectionMessage(body: unknown): string {
  if (!isRecord(body)) return 'no diagnostic returned'
  const parts: string[] = []
  if (isRecord(body.error) && typeof body.error.message === 'string') parts.push(body.error.message)
  if (isRecord(body.node_errors)) {
    for (const [node, value] of Object.entries(body.node_errors)) {
      if (!isRecord(value) || !Array.isArray(value.errors)) continue
      for (const error of value.errors) {
        if (isRecord(error) && typeof error.message === 'string') parts.push(`node ${node}: ${error.message}`)
      }
    }
  }
  return parts.length === 0 ? 'no diagnostic returned' : parts.join('; ')
}

/** Read a thrown value's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse a JSON body, returning `undefined` for an empty or non-JSON body. */
function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // A non-JSON body carries no diagnostic; the caller reports the HTTP status.
    return undefined
  }
}
