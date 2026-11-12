/**
 * Cloud MiniMax video provider. It submits one MiniMax-H3 generation task,
 * polls its status, and downloads the settled MP4. The API accepts text,
 * image, video, and audio content; this provider sends text plus image
 * references (first frame, last frame, or reference images) as data URIs.
 *
 * MiniMax charges per generated second. Prices are the published CNY rates for
 * `MiniMax-H3`: 0.50 per second at 768P and 0.80 per second at 2K.
 * @module @deepseek-ai/dsh-video-mode/minimax
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { downloadVideo, failedTask as failed, submittedVideoTask, supportedImageMediaType, untrackedTask } from './cloud-common.ts'
import {
  KeyedMiniMaxProvider,
  failureCodeFor,
  isRecord,
  messageOf,
  minimaxJsonHeaders,
  parseJson,
  rejectionMessage,
  resolveMiniMaxKey,
  type MiniMaxFetchLike,
  type MiniMaxKeyResolver,
} from './minimax-common.ts'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaReference,
  type MediaRequest,
  type MediaTask,
  type MediaTaskRecord,
} from './types.ts'

export type { MiniMaxFetchLike } from './minimax-common.ts'

/** Registered provider id of the MiniMax cloud backend. */
export const MINIMAX_PROVIDER_ID = 'minimax'

/** Video model this provider submits. */
export const MINIMAX_VIDEO_MODEL = 'MiniMax-H3'

/** Aspect ratios MiniMax-H3 accepts for text-to-video. */
export const MINIMAX_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const

/** Resolution labels MiniMax-H3 accepts. */
export type MiniMaxResolution = '768P' | '2K'

/** Published MiniMax-H3 price in fen per generated second. */
const PRICE_PER_SECOND_MINOR: Readonly<Record<MiniMaxResolution, number>> = {
  '768P': 50,
  '2K': 80,
}

/** MiniMax-H3 accepts integer durations from four through fifteen seconds. */
const MIN_DURATION_SEC = 4
const MAX_DURATION_SEC = 15

/** Per-image and per-request limits from the MiniMax video API. */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGES = 9
const MAX_PROMPT_CHARS = 7000

/** Transport ceiling for one request body, including base64 image payloads. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

/** Upper bound on a best-effort cancellation request. */
const CANCEL_TIMEOUT_MS = 10_000

/** Video settings after defaults. */
export interface MiniMaxSettings {
  /** Direct bearer API key; empty when the deployment names a credential ref instead. */
  readonly apiKey: string
  /** Credential reference resolved per request through `ctx.credentials`. */
  readonly apiKeyEnv?: string
  /** API origin, for example `https://api.minimax.cn`. */
  readonly baseUrl: string
  /** Minimum gap between two status polls for one task. */
  readonly pollMs: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs: number
  /** Largest accepted artifact size in bytes, inherited from the media runtime. */
  readonly maxArtifactBytes: number
  /** Model id reported to consumers and submitted to the API. */
  readonly model: string
  /** Resolution used when a request omits one. */
  readonly resolution: MiniMaxResolution
  /** Duration used when a request omits one. */
  readonly defaultDurationSec: number
  /** Longest accepted request duration. */
  readonly maxDurationSec: number
  /** Aspect ratio used for text-to-video when the request omits one. */
  readonly aspectRatio: string
}

/** One content item in a MiniMax video request. */
type ContentItem =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image_url'
    readonly image_url: { readonly url: string }
    readonly role: 'first_frame' | 'last_frame' | 'reference_image'
  }

/** One MiniMax task tracked until it settles. */
interface PendingTask {
  /** Remote task id returned by the create endpoint. */
  readonly remoteId: string
  /** Submission time in epoch milliseconds. */
  readonly submittedAt: number
  /** Last status poll time in epoch milliseconds. */
  lastPollAt: number
  /** Requested output duration in seconds. */
  readonly durationSec: number
}

/**
 * MiniMax cloud provider. `submit` creates one asynchronous video task, `poll`
 * reads its status and downloads the MP4, and `cancel` deletes a queued task.
 */
export class MiniMaxMediaProvider extends KeyedMiniMaxProvider {
  /** Registered provider id. */
  readonly id = MINIMAX_PROVIDER_ID

  /** Capability this provider serves. */
  readonly capabilities: readonly MediaKind[] = ['video']

  private readonly pending = new Map<string, PendingTask>()

  /**
   * @param settings - resolved provider settings.
   * @param fetchImpl - fetch implementation; tests inject a stub.
   * @param resolveApiKey - credential resolver for `apiKeyEnv`; omitted reads the process environment.
   */
  constructor(
    private readonly settings: MiniMaxSettings,
    private readonly fetchImpl: MiniMaxFetchLike = fetch,
    private readonly resolveApiKey?: MiniMaxKeyResolver,
  ) {
    super(settings, [{
      id: settings.model,
      kind: 'video',
      provider: MINIMAX_PROVIDER_ID,
      maxDurationSec: settings.maxDurationSec,
      aspectRatios: [...MINIMAX_ASPECT_RATIOS, 'adaptive'],
      referenceModes: ['image', 'first-frame', 'last-frame'],
      audio: true,
      price: {
        amountMinor: PRICE_PER_SECOND_MINOR[settings.resolution],
        currency: 'CNY',
        unit: 'video-second',
      },
    }])
  }

  /**
   * Estimate one MiniMax request from the published per-second rate.
   * @param request - requested generation.
   * @returns the priced duration, or unknown for non-video kinds.
   * @throws {@link MediaFailure} for an unsupported duration or resolution.
   */
  override estimate(request: MediaRequest): MediaEstimate {
    if (request.kind !== 'video') return { confidence: 'unknown' }
    const duration = this.durationOf(request)
    const resolution = this.resolutionOf(request)
    return {
      cost: { amountMinor: PRICE_PER_SECOND_MINOR[resolution] * duration, currency: 'CNY' },
      durationSec: duration,
      confidence: 'exact',
    }
  }

  /**
   * Create one MiniMax-H3 video task.
   * @param request - requested generation.
   * @param signal - caller cancellation.
   * @returns the submitted task.
   * @throws {@link MediaFailure} for an unknown model, invalid request, or rejected submission.
   */
  override async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    if (request.kind !== 'video') {
      throw new MediaFailure(`MiniMax serves video only, not ${request.kind}`, 'MEDIA_REQUEST_INVALID')
    }
    if ((request.model ?? this.settings.model) !== this.settings.model) {
      throw new MediaFailure(`MiniMax serves no video model ${JSON.stringify(request.model)}`, 'MEDIA_MODEL_UNKNOWN')
    }
    const duration = this.durationOf(request)
    const resolution = this.resolutionOf(request)
    const content = await this.contentOf(request)
    const hasFrame = content.some(item => item.type === 'image_url' && item.role !== 'reference_image')
    const body = {
      model: this.settings.model,
      content,
      duration,
      resolution,
      ratio: hasFrame ? 'adaptive' : this.aspectRatioOf(request.aspectRatio),
    }
    const response = await this.fetchImpl(`${this.settings.baseUrl}/v2/video_generation`, {
      method: 'POST',
      headers: minimaxJsonHeaders(await this.key()),
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new MediaFailure(
        `MiniMax rejected the video request: ${rejectionMessage(text, response.statusText)}`,
        failureCodeFor(response.status),
      )
    }
    const parsed = parseJson(text)
    const remoteId = isRecord(parsed) && typeof parsed.task_id === 'string' ? parsed.task_id : undefined
    if (remoteId === undefined) {
      throw new MediaFailure('MiniMax accepted the request without returning a task_id', 'MEDIA_TASK_FAILED')
    }
    const id = localIdOf(remoteId)
    this.pending.set(id, { remoteId, submittedAt: Date.now(), lastPollAt: 0, durationSec: duration })
    return submittedVideoTask(id, this.id, this.settings.model)
  }

  /* jscpd:ignore-start -- sibling cloud providers share the poll throttle and timeout preamble */
  /**
   * Read one MiniMax task and download its settled video.
   * @param task - current task.
   * @param signal - caller cancellation.
   * @returns the latest task.
   * @throws {@link MediaFailure} for transport failures.
   */
  override async poll(task: MediaTask, signal: AbortSignal): Promise<MediaTask> {
    const pending = this.pending.get(task.id)
    if (pending === undefined) {
      return untrackedTask(task)
    }
    const now = Date.now()
    if (now - pending.submittedAt > this.settings.timeoutMs) {
      await this.cancel(task)
      return failed(task, `task did not settle within ${this.settings.timeoutMs} ms`, 'MEDIA_TASK_TIMEOUT')
    }
    if (now - pending.lastPollAt < this.settings.pollMs) return task
    /* jscpd:ignore-end */
    pending.lastPollAt = now

    const response = await this.fetchImpl(
      `${this.settings.baseUrl}/v2/query/video_generation/${encodeURIComponent(pending.remoteId)}`,
      { headers: minimaxJsonHeaders(await this.key()), signal },
    )
    const text = await response.text()
    if (!response.ok) {
      this.pending.delete(task.id)
      return failed(task, `MiniMax status query failed: ${rejectionMessage(text, response.statusText)}`)
    }
    const parsed = parseJson(text)
    const remote = isRecord(parsed) && isRecord(parsed.task) ? parsed.task : undefined
    if (remote === undefined || typeof remote.status !== 'string') {
      this.pending.delete(task.id)
      return failed(task, 'MiniMax status response has no task status')
    }
    switch (remote.status) {
      case 'queued':
        return { ...task, status: 'queued' }
      case 'running':
        return { ...task, status: 'running' }
      case 'cancelled':
        this.pending.delete(task.id)
        return { ...task, status: 'cancelled' }
      case 'failed': {
        this.pending.delete(task.id)
        return failed(task, errorMessageOf(remote.error) ?? 'MiniMax reported a failed task')
      }
      case 'succeeded': {
        const url = isRecord(remote.content) && typeof remote.content.url === 'string' ? remote.content.url : undefined
        if (url === undefined) {
          this.pending.delete(task.id)
          return failed(task, 'MiniMax succeeded without a download URL')
        }
        try {
          const artifact = await this.download(url, pending.durationSec, signal)
          this.pending.delete(task.id)
          return { ...task, status: 'succeeded', progress: 1, artifacts: [artifact] }
        } catch (error) {
          this.pending.delete(task.id)
          if (error instanceof MediaFailure) return failed(task, error.message, error.code)
          return failed(task, messageOf(error))
        }
      }
      default:
        this.pending.delete(task.id)
        return failed(task, `MiniMax returned unknown task status ${JSON.stringify(remote.status)}`)
    }
  }

  /**
   * Rebuild in-flight state from a journal record so polling can continue
   * after the runtime restarted.
   * @param record - persisted task snapshot and request.
   * @returns the resumed task, or undefined when the record belongs to another provider.
   */
  resume(record: MediaTaskRecord): MediaTask | undefined {
    if (record.task.provider !== this.id || record.task.kind !== 'video') return undefined
    if (!record.task.id.startsWith(`${MINIMAX_PROVIDER_ID}-`)) return undefined
    const remoteId = remoteIdOf(record.task.id)
    if (remoteId.length === 0 || remoteId === record.task.id) return undefined
    const durationSec = this.durationOf({
      kind: 'video',
      prompt: record.request.prompt,
      ...record.request.durationSec === undefined ? {} : { durationSec: record.request.durationSec },
    })
    this.pending.set(record.task.id, { remoteId, submittedAt: record.submittedAt, lastPollAt: 0, durationSec })
    return record.task
  }

  /**
   * Cancel or delete one queued task. Cancellation is best-effort because a
   * running task cannot be stopped and a settled record may already be gone.
   * @param task - task to cancel.
   */
  override async cancel(task: MediaTask): Promise<void> {
    const pending = this.pending.get(task.id)
    this.pending.delete(task.id)
    const remoteId = pending?.remoteId ?? remoteIdOf(task.id)
    try {
      await this.fetchImpl(
        `${this.settings.baseUrl}/v2/video_generation/${encodeURIComponent(remoteId)}`,
        { method: 'DELETE', headers: minimaxJsonHeaders(await this.key()), signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) },
      )
    } catch (error) {
      // The task may already be running or deleted; the runtime marks it cancelled regardless.
      void error
    }
  }

  /**
   * Resolve the bearer key for one operation through the shared MiniMax
   * credential path.
   * @returns the non-empty key.
   * @throws {@link MediaFailure} `MEDIA_PROVIDER_UNAVAILABLE` when the reference is unset.
   */
  private async key(): Promise<string> {
    return resolveMiniMaxKey(this.settings, this.resolveApiKey)
  }

  /**
   * Build the multimodal content array, attaching image files as data URIs.
   * @param request - requested generation.
   * @returns the text item followed by image references.
   * @throws {@link MediaFailure} for unsupported references, oversized images, or an overlong prompt.
   */
  private async contentOf(request: MediaRequest): Promise<readonly ContentItem[]> {
    const prompt = request.negativePrompt === undefined || request.negativePrompt.trim().length === 0
      ? request.prompt
      : `${request.prompt}\n\nAvoid: ${request.negativePrompt}`
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new MediaFailure(`MiniMax prompts accept at most ${MAX_PROMPT_CHARS} characters`, 'MEDIA_REQUEST_INVALID')
    }
    const references = request.references ?? []
    if (references.length > MAX_IMAGES) {
      throw new MediaFailure(`MiniMax accepts at most ${MAX_IMAGES} reference images`, 'MEDIA_REQUEST_INVALID')
    }
    const firstFrames = references.filter(reference => roleOf(reference) === 'first_frame').length
    const lastFrames = references.filter(reference => roleOf(reference) === 'last_frame').length
    if (firstFrames > 1 || lastFrames > 1) {
      throw new MediaFailure('MiniMax accepts at most one first frame and one last frame', 'MEDIA_REQUEST_INVALID')
    }
    if (firstFrames + lastFrames > 0 && references.some(reference => roleOf(reference) === 'reference_image')) {
      throw new MediaFailure('MiniMax cannot mix first/last frames with reference images in one request', 'MEDIA_REQUEST_INVALID')
    }
    const content: ContentItem[] = [{ type: 'text', text: prompt }]
    let bytes = Buffer.byteLength(prompt, 'utf8')
    for (const reference of references) {
      if (reference.kind !== 'image') {
        throw new MediaFailure(`MiniMax image references must be images, not ${reference.kind}`, 'MEDIA_REQUEST_INVALID')
      }
      const url = await imageDataUri(reference)
      bytes += Buffer.byteLength(url, 'utf8')
      if (bytes > MAX_REQUEST_BYTES) {
        throw new MediaFailure(
          `MiniMax requests are capped at ${MAX_REQUEST_BYTES} bytes including base64 images; split the request`,
          'MEDIA_REQUEST_INVALID',
        )
      }
      content.push({ type: 'image_url', image_url: { url }, role: roleOf(reference) })
    }
    return content
  }

  /**
   * Resolve the integer output duration.
   * @param request - requested generation.
   * @returns the requested or configured duration.
   * @throws {@link MediaFailure} for a non-integer, too short, or too long duration.
   */
  private durationOf(request: MediaRequest): number {
    const duration = request.durationSec ?? this.settings.defaultDurationSec
    const maximum = Math.min(this.settings.maxDurationSec, MAX_DURATION_SEC)
    if (!Number.isInteger(duration)) {
      throw new MediaFailure('MiniMax accepts whole-second durations only', 'MEDIA_REQUEST_INVALID')
    }
    if (duration < MIN_DURATION_SEC || duration > maximum) {
      throw new MediaFailure(
        `MiniMax accepts durations from ${MIN_DURATION_SEC} to ${maximum} seconds, not ${duration}`,
        'MEDIA_REQUEST_INVALID',
      )
    }
    return duration
  }

  /**
   * Resolve a supported resolution label.
   * @param request - requested generation.
   * @returns the normalized label.
   * @throws {@link MediaFailure} for a label MiniMax-H3 cannot produce.
   */
  private resolutionOf(request: MediaRequest): MiniMaxResolution {
    const requested = request.resolution ?? this.settings.resolution
    const label = requested.toUpperCase()
    if (label === '768P' || label === '2K') return label
    throw new MediaFailure(`MiniMax-H3 accepts 768P or 2K, not ${JSON.stringify(requested)}`, 'MEDIA_REQUEST_INVALID')
  }

  /**
   * Resolve an aspect ratio for text or reference-to-video.
   * @param requested - requested ratio, if any.
   * @returns the configured or requested ratio.
   * @throws {@link MediaFailure} for an unsupported ratio.
   */
  private aspectRatioOf(requested: string | undefined): string {
    const ratio = requested ?? this.settings.aspectRatio
    if (!(MINIMAX_ASPECT_RATIOS as readonly string[]).includes(ratio)) {
      throw new MediaFailure(
        `MiniMax text-to-video accepts ${MINIMAX_ASPECT_RATIOS.join(', ')}, not ${JSON.stringify(ratio)}`,
        'MEDIA_REQUEST_INVALID',
      )
    }
    return ratio
  }

  /**
   * Download a settled video and verify its size cap.
   * @param url - provider download URL.
   * @param durationSec - requested output duration.
   * @param signal - caller cancellation.
   * @returns the downloaded artifact.
   * @throws {@link MediaFailure} for a failed download, an empty body, or an oversized body.
   */
  private async download(url: string, durationSec: number, signal: AbortSignal): Promise<MediaArtifact> {
    return downloadVideo(this.fetchImpl, url, {
      label: 'MiniMax',
      durationSec,
      maxBytes: this.settings.maxArtifactBytes,
      signal,
    })
  }
}

/**
 * Prefix a remote task id for the runtime's task table.
 * @param remoteId - id returned by the create endpoint.
 * @returns the runtime task id.
 */
function localIdOf(remoteId: string): string {
  return `${MINIMAX_PROVIDER_ID}-${remoteId}`
}

/**
 * Recover a remote task id from a runtime task id.
 * @param id - runtime task id.
 * @returns the remote id, or the input when it has no provider prefix.
 */
function remoteIdOf(id: string): string {
  const prefix = `${MINIMAX_PROVIDER_ID}-`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/**
 * Map a reference role to a MiniMax content role. An unlabeled image starts the
 * video, matching the local provider's first-frame default.
 * @param reference - request reference.
 * @returns the MiniMax role.
 */
function roleOf(reference: MediaReference): 'first_frame' | 'last_frame' | 'reference_image' {
  if (reference.role === 'last-frame') return 'last_frame'
  if (reference.role === 'style' || reference.role === 'character') return 'reference_image'
  return 'first_frame'
}

/**
 * Read one image file and encode it as a data URI.
 * @param reference - request reference.
 * @returns a `data:` URI MiniMax accepts in `image_url.url`.
 * @throws {@link MediaFailure} for an unreadable, unsupported, or oversized image.
 */
async function imageDataUri(reference: MediaReference): Promise<string> {
  const mediaType = imageMediaTypeOf(reference.path)
  let bytes: Buffer
  try {
    bytes = await readFile(reference.path)
  } catch (error) {
    throw new MediaFailure(`cannot read the MiniMax reference image ${reference.path}: ${messageOf(error)}`, 'MEDIA_REQUEST_INVALID', { cause: error })
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new MediaFailure(
      `MiniMax reference images are capped at ${MAX_IMAGE_BYTES} bytes; ${reference.path} is ${bytes.byteLength}`,
      'MEDIA_REQUEST_INVALID',
    )
  }
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/**
 * Pick the MIME type from an image file extension.
 * @param path - image path.
 * @returns the MIME type.
 * @throws {@link MediaFailure} for an extension MiniMax does not accept.
 */
function imageMediaTypeOf(path: string): string {
  const mediaType = supportedImageMediaType(path)
  if (mediaType === undefined) {
    throw new MediaFailure(
      `MiniMax accepts png, jpeg, webp, heic, and heif images, not ${JSON.stringify(extname(path))}`,
      'MEDIA_REQUEST_INVALID',
    )
  }
  return mediaType
}

/**
 * Read a task error message.
 * @param value - `task.error` from a status response.
 * @returns the message, or undefined.
 */
function errorMessageOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message === 'string') return value.message
  return undefined
}
