/**
 * Cloud SiliconFlow video provider. It submits one Wan2.2 image-to-video job
 * through `/v1/video/submit`, polls `/v1/video/status`, and downloads the
 * settled MP4. Wan2.2-I2V-A14B requires exactly one first-frame image and
 * produces a fixed five-second clip; the API has no duration parameter.
 *
 * SiliconFlow bills per completed video: 2.00 CNY on the mainland site and
 * 0.29 USD on the international site. A deployment selects its site through
 * configuration because the price is not returned by the API.
 * @module @deepseek-ai/dsh-video-mode/siliconflow
 */

import {
  KeyedCloudProvider,
  cloudJsonHeaders,
  downloadVideo,
  failedTask,
  imageDataUri,
  isRecord,
  parseJson,
  rejectionMessage,
  resolveCloudKey,
  settledVideoTask,
  submitResponse,
  type CloudFetchLike,
  type CloudKeyResolver,
  type CloudProviderIdentity,
} from './cloud-common.ts'
import {
  MediaFailure,
  type MediaCurrency,
  type MediaEstimate,
  type MediaKind,
  type MediaRequest,
  type MediaTask,
  type MediaTaskRecord,
} from './types.ts'

/** Registered provider id of the SiliconFlow cloud backend. */
export const SILICONFLOW_PROVIDER_ID = 'siliconflow'

/** Image-to-video model this provider submits. */
export const SILICONFLOW_VIDEO_MODEL = 'Wan-AI/Wan2.2-I2V-A14B'

/** Aspect ratios the model accepts, mapped to the API's `image_size` values. */
export const SILICONFLOW_IMAGE_SIZES: Readonly<Record<string, string>> = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  '1:1': '960x960',
}

/** Wan2.2-I2V-A14B always produces a five-second clip. */
export const SILICONFLOW_DURATION_SEC = 5

/** Per-image limit used by the SiliconFlow image upload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Prompt ceiling shared with the other video providers. */
const MAX_PROMPT_CHARS = 7000

/** Provider names used in credential remedies. */
const SILICONFLOW_IDENTITY: CloudProviderIdentity = {
  label: 'SiliconFlow',
  envHint: 'SILICONFLOW_API_KEY',
  configPath: 'siliconflow',
}

/** Video settings after defaults. */
export interface SiliconFlowSettings {
  /** Direct bearer API key; empty when the deployment names a credential ref instead. */
  readonly apiKey: string
  /** Credential reference resolved per request through `ctx.credentials`. */
  readonly apiKeyEnv?: string
  /** API origin, for example `https://api.siliconflow.cn/v1`. */
  readonly baseUrl: string
  /** Minimum gap between two status polls for one task. */
  readonly pollMs: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs: number
  /** Largest accepted artifact size in bytes, inherited from the media runtime. */
  readonly maxArtifactBytes: number
  /** Model id reported to consumers and submitted to the API. */
  readonly model: string
  /** Aspect ratio used when a request omits one. */
  readonly aspectRatio: string
  /** Price per completed video in minor currency units. */
  readonly priceMinor: number
  /** Currency of {@link priceMinor}. */
  readonly currency: MediaCurrency
}

/** One SiliconFlow task tracked until it settles. */
interface PendingTask {
  /** Remote request id returned by the submit endpoint. */
  readonly remoteId: string
  /** Submission time in epoch milliseconds. */
  readonly submittedAt: number
  /** Last status poll time in epoch milliseconds. */
  lastPollAt: number
}

/**
 * SiliconFlow cloud provider. `submit` creates one asynchronous video job,
 * `poll` reads its status and downloads the MP4, and `cancel` stops local
 * polling because the public API exposes no cancellation endpoint.
 */
export class SiliconFlowMediaProvider extends KeyedCloudProvider {
  /** Registered provider id. */
  override readonly id = SILICONFLOW_PROVIDER_ID

  /** Capability this provider serves. */
  override readonly capabilities: readonly MediaKind[] = ['video']

  private readonly pending = new Map<string, PendingTask>()

  /**
   * @param settings - resolved provider settings.
   * @param fetchImpl - fetch implementation; tests inject a stub.
   * @param resolveApiKey - credential resolver for `apiKeyEnv`; omitted reads the process environment.
   */
  constructor(
    private readonly settings: SiliconFlowSettings,
    private readonly fetchImpl: CloudFetchLike = fetch,
    private readonly resolveApiKey?: CloudKeyResolver,
  ) {
    super(settings, [{
      id: settings.model,
      kind: 'video',
      provider: SILICONFLOW_PROVIDER_ID,
      maxDurationSec: SILICONFLOW_DURATION_SEC,
      aspectRatios: Object.keys(SILICONFLOW_IMAGE_SIZES),
      referenceModes: ['image', 'first-frame'],
      audio: false,
      price: {
        amountMinor: settings.priceMinor,
        currency: settings.currency,
        unit: 'video',
      },
    }], SILICONFLOW_IDENTITY)
  }

  /**
   * Estimate one SiliconFlow request from the configured per-video price.
   * @param request - requested generation.
   * @returns the fixed price and duration, or unknown for non-video kinds.
   */
  override estimate(request: MediaRequest): MediaEstimate {
    if (request.kind !== 'video') return { confidence: 'unknown' }
    return {
      cost: { amountMinor: this.settings.priceMinor, currency: this.settings.currency },
      durationSec: SILICONFLOW_DURATION_SEC,
      confidence: 'exact',
    }
  }

  /**
   * Create one Wan2.2 image-to-video job.
   * @param request - requested generation; exactly one first-frame image is required.
   * @param signal - caller cancellation.
   * @returns the submitted task.
   * @throws {@link MediaFailure} for an unknown model, invalid request, or rejected submission.
   */
  override async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    if (request.kind !== 'video') {
      throw new MediaFailure(`SiliconFlow serves video only, not ${request.kind}`, 'MEDIA_REQUEST_INVALID')
    }
    if ((request.model ?? this.settings.model) !== this.settings.model) {
      throw new MediaFailure(`SiliconFlow serves no video model ${JSON.stringify(request.model)}`, 'MEDIA_MODEL_UNKNOWN')
    }
    this.durationOf(request)
    const image = await this.imageOf(request)
    const negativePrompt = request.negativePrompt?.trim() ?? ''
    const body = {
      model: this.settings.model,
      prompt: promptOf(request),
      image_size: imageSizeOf(request.aspectRatio ?? this.settings.aspectRatio),
      image,
      ...negativePrompt.length === 0 ? {} : { negative_prompt: negativePrompt },
      ...request.seed === undefined ? {} : { seed: request.seed },
    }
    const response = await this.fetchImpl(`${this.settings.baseUrl}/video/submit`, {
      method: 'POST',
      headers: cloudJsonHeaders(await this.key()),
      body: JSON.stringify(body),
      signal,
    })
    const text = await submitResponse(response, 'SiliconFlow')
    const parsed = parseJson(text)
    const remoteId = isRecord(parsed) && typeof parsed.requestId === 'string' ? parsed.requestId : undefined
    if (remoteId === undefined || remoteId.length === 0) {
      throw new MediaFailure('SiliconFlow accepted the request without returning a requestId', 'MEDIA_TASK_FAILED')
    }
    return this.trackSubmission(this.pending, remoteId, submittedAt => ({
      remoteId, submittedAt, lastPollAt: 0,
    }), this.settings.model)
  }

  /**
   * Read one SiliconFlow job and download its settled video.
   * @param task - current task.
   * @param signal - caller cancellation.
   * @returns the latest task.
   */
  override async poll(task: MediaTask, signal: AbortSignal): Promise<MediaTask> {
    const pending = await this.beginPoll(this.pending, task, this.settings)
    if ('status' in pending) return pending

    const response = await this.fetchImpl(`${this.settings.baseUrl}/video/status`, {
      method: 'POST',
      headers: cloudJsonHeaders(await this.key()),
      body: JSON.stringify({ requestId: pending.remoteId }),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      this.pending.delete(task.id)
      return failedTask(task, `SiliconFlow status query failed: ${rejectionMessage(text, response.statusText)}`)
    }
    const parsed = parseJson(text)
    if (!isRecord(parsed) || typeof parsed.status !== 'string') {
      this.pending.delete(task.id)
      return failedTask(task, 'SiliconFlow status response has no status')
    }
    switch (parsed.status) {
      case 'InQueue':
        return { ...task, status: 'queued' }
      case 'InProgress':
        return { ...task, status: 'running' }
      case 'Failed': {
        this.pending.delete(task.id)
        const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
        if (reason.length > 0) return failedTask(task, reason)
        const detail = JSON.stringify(parsed).slice(0, 500)
        return failedTask(
          task,
          `SiliconFlow reported a failed task without a reason: ${detail}. `
          + 'Check that the first frame is a non-blank image and that the prompt describes motion.',
        )
      }
      case 'Succeed': {
        const url = videoUrlOf(parsed)
        if (url === undefined) {
          this.pending.delete(task.id)
          return failedTask(task, 'SiliconFlow succeeded without a video URL')
        }
        return settledVideoTask(
          task,
          () => downloadVideo(this.fetchImpl, url, {
            label: 'SiliconFlow',
            durationSec: SILICONFLOW_DURATION_SEC,
            maxBytes: this.settings.maxArtifactBytes,
            signal,
          }),
          () => this.pending.delete(task.id),
        )
      }
      default:
        this.pending.delete(task.id)
        return failedTask(task, `SiliconFlow returned unknown status ${JSON.stringify(parsed.status)}`)
    }
  }

  /**
   * Rebuild in-flight state from a journal record so polling can continue
   * after the runtime restarted.
   * @param record - persisted task snapshot and request.
   * @returns the resumed task, or undefined when the record belongs to another provider.
   */
  resume(record: MediaTaskRecord): MediaTask | undefined {
    const remoteId = this.resumedRemoteId(record)
    if (remoteId === undefined) return undefined
    this.pending.set(record.task.id, { remoteId, submittedAt: record.submittedAt, lastPollAt: 0 })
    return record.task
  }

  /**
   * Stop local polling. SiliconFlow publishes no cancellation endpoint, so a
   * remote job may still finish and bill the account.
   * @param task - task to cancel.
   */
  override cancel(task: MediaTask): Promise<void> {
    this.pending.delete(task.id)
    return Promise.resolve()
  }

  /**
   * Resolve the bearer key for one operation through the shared cloud
   * credential path.
   * @returns the non-empty key.
   * @throws {@link MediaFailure} `MEDIA_PROVIDER_UNAVAILABLE` when the reference is unset.
   */
  private async key(): Promise<string> {
    return resolveCloudKey(this.settings, this.resolveApiKey, SILICONFLOW_IDENTITY)
  }

  /**
   * Resolve the fixed output duration. The API has no duration field, so a
   * request that asks for another length is rejected rather than silently
   * shortened.
   * @param request - requested generation.
   * @returns the fixed duration.
   * @throws {@link MediaFailure} for any other duration.
   */
  private durationOf(request: MediaRequest): number {
    if (request.durationSec === undefined || request.durationSec === SILICONFLOW_DURATION_SEC) {
      return SILICONFLOW_DURATION_SEC
    }
    throw new MediaFailure(
      `Wan2.2-I2V-A14B produces a fixed ${SILICONFLOW_DURATION_SEC}-second clip; omit duration_sec or set ${SILICONFLOW_DURATION_SEC}`,
      'MEDIA_REQUEST_INVALID',
    )
  }

  /**
   * Read the first-frame image and encode it as a data URI.
   * @param request - requested generation.
   * @returns a `data:` URI the submit endpoint accepts.
   * @throws {@link MediaFailure} for a missing, non-image, mislabeled, or oversized reference.
   */
  private async imageOf(request: MediaRequest): Promise<string> {
    const [reference, ...extra] = request.references ?? []
    if (reference === undefined || extra.length > 0) {
      throw new MediaFailure(
        'Wan2.2-I2V-A14B needs exactly one first-frame image; generate a keyframe and pass first_frame_path',
        'MEDIA_REQUEST_INVALID',
      )
    }
    if (reference.kind !== 'image') {
      throw new MediaFailure(`SiliconFlow image references must be images, not ${reference.kind}`, 'MEDIA_REQUEST_INVALID')
    }
    if (reference.role !== undefined && reference.role !== 'first-frame') {
      throw new MediaFailure(
        `Wan2.2-I2V-A14B accepts a first-frame image, not a ${reference.role} reference`,
        'MEDIA_REQUEST_INVALID',
      )
    }
    return imageDataUri(reference, { label: 'SiliconFlow', maxBytes: MAX_IMAGE_BYTES })
  }
}

/**
 * Validate the prompt length. The submit endpoint carries the negative prompt
 * in its own field, so only the positive prompt counts against this ceiling.
 * @param request - requested generation.
 * @returns the prompt submitted to the API.
 * @throws {@link MediaFailure} when the prompt is too long.
 */
function promptOf(request: MediaRequest): string {
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new MediaFailure(`SiliconFlow prompts accept at most ${MAX_PROMPT_CHARS} characters`, 'MEDIA_REQUEST_INVALID')
  }
  return request.prompt
}

/**
 * Resolve an accepted aspect ratio to the API's `image_size` value.
 * @param ratio - requested or configured ratio.
 * @returns the `image_size` string.
 * @throws {@link MediaFailure} for a ratio the model cannot produce.
 */
function imageSizeOf(ratio: string): string {
  const size = SILICONFLOW_IMAGE_SIZES[ratio]
  if (size === undefined) {
    throw new MediaFailure(
      `Wan2.2-I2V-A14B accepts ${Object.keys(SILICONFLOW_IMAGE_SIZES).join(', ')}, not ${JSON.stringify(ratio)}`,
      'MEDIA_REQUEST_INVALID',
    )
  }
  return size
}

/**
 * Read the first video URL from a settled status response.
 * @param value - parsed status response.
 * @returns the URL, or undefined when the response carries none.
 */
function videoUrlOf(value: Record<string, unknown>): string | undefined {
  if (!isRecord(value.results) || !Array.isArray(value.results.videos)) return undefined
  const videos: readonly unknown[] = value.results.videos
  const first = videos[0]
  if (!isRecord(first) || typeof first.url !== 'string' || first.url.length === 0) return undefined
  return first.url
}
