/**
 * Shared cloud-provider transport: credential resolution, JSON headers, error
 * classification, response parsing, image encoding, poll throttling, and video
 * downloads. The MiniMax and SiliconFlow providers share this code so a
 * key-rotation, failure-code, or empty-payload fix reaches both capabilities.
 * @module @deepseek-ai/dsh-video-mode/cloud-common
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaModel,
  type MediaProvider,
  type MediaReference,
  type MediaRequest,
  type MediaTask,
  type MediaTaskRecord,
} from './types.ts'
import { errorMessage, isRecord } from '@deepseek-ai/dsh-value'
export { isRecord }

/** Minimal fetch surface cloud providers need; tests inject a stub. */
export type CloudFetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Settings subset that names a cloud credential. */
export interface CloudCredentialSettings {
  /** Direct bearer API key; empty when the deployment names a credential ref instead. */
  readonly apiKey: string
  /** Credential reference resolved per request through `ctx.credentials`. */
  readonly apiKeyEnv?: string
}

/** Resolves one credential reference through the host service. */
export type CloudKeyResolver = (ref: string) => Promise<string | undefined>

/** Provider names used in credential remedies and download failures. */
export interface CloudProviderIdentity {
  /** Product name, for example `MiniMax`. */
  readonly label: string
  /** Environment variable a deployment normally exports. */
  readonly envHint: string
  /** Configuration block that accepts `apiKeyEnv`. */
  readonly configPath: string
}

/**
 * Resolve the bearer key for one operation. A configured credential reference
 * is read again every time so a rotated key reaches the next call without a
 * process restart.
 * @param settings - provider settings carrying the direct key or reference.
 * @param resolveApiKey - credential resolver; omitted reads the process environment.
 * @param identity - provider names used in the remedy.
 * @returns the non-empty key.
 * @throws {@link MediaFailure} `MEDIA_PROVIDER_UNAVAILABLE` when the reference is unset.
 */
export async function resolveCloudKey(
  settings: CloudCredentialSettings,
  resolveApiKey: CloudKeyResolver | undefined,
  identity: CloudProviderIdentity,
): Promise<string> {
  const ref = settings.apiKeyEnv
  if (ref !== undefined) {
    const value = resolveApiKey === undefined
      ? process.env[ref]
      : await resolveApiKey(ref)
    if (value !== undefined && value.length > 0) return value
    throw new MediaFailure(
      `${identity.label} credential ${ref} is not set; store it or export ${ref} before generating media`,
      'MEDIA_PROVIDER_UNAVAILABLE',
    )
  }
  if (settings.apiKey.length > 0) return settings.apiKey
  throw new MediaFailure(
    `${identity.label} has no API key; set ${identity.envHint} or configure ${identity.configPath}.apiKeyEnv`,
    'MEDIA_PROVIDER_UNAVAILABLE',
  )
}

/**
 * Build authorization and content headers for one JSON call.
 * @param apiKey - resolved bearer key.
 * @returns the request headers.
 */
export function cloudJsonHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
}

/**
 * Map an HTTP status to a stable media failure code.
 * @param status - HTTP status from a provider endpoint.
 * @returns the failure code.
 */
export function failureCodeFor(status: number): 'MEDIA_REQUEST_INVALID' | 'MEDIA_BUDGET_EXCEEDED' | 'MEDIA_TASK_FAILED' {
  if (status === 400 || status === 422) return 'MEDIA_REQUEST_INVALID'
  if (status === 402) return 'MEDIA_BUDGET_EXCEEDED'
  return 'MEDIA_TASK_FAILED'
}

/**
 * Wait before a retry.
 * @param ms - milliseconds to wait.
 * @returns a promise resolved after the wait.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry policy applied to a rate-limited provider response. */
export interface CloudRetryPolicy {
  /** Attempts after the first response; 0 disables retrying. */
  readonly retries: number
  /** Longest retry-after the provider may ask for; a longer wait fails instead. */
  readonly maxRetryAfterMs: number
  /** Waits between attempts; tests inject an immediate stub. */
  readonly sleep: (ms: number) => Promise<void>
}

/**
 * Read the wait a `Retry-After` header asks for, in either of its two forms.
 * @param response - rate-limited response.
 * @returns milliseconds to wait, or undefined when the header is absent or unparsable.
 */
export function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/**
 * Send one request, retrying a `429` whose `Retry-After` fits the policy.
 * @param fetchImpl - fetch implementation.
 * @param url - request URL.
 * @param init - request options.
 * @param policy - retry budget, wait ceiling, and sleep implementation.
 * @returns the last response; a `429` the policy declines to retry is returned as is.
 */
export async function fetchWithRetry(
  fetchImpl: CloudFetchLike,
  url: string,
  init: RequestInit | undefined,
  policy: CloudRetryPolicy,
): Promise<Response> {
  let response = await fetchImpl(url, init)
  for (let attempt = 0; attempt < policy.retries; attempt += 1) {
    if (response.status !== 429) return response
    const wait = retryAfterOf(response)
    if (wait === undefined || wait > policy.maxRetryAfterMs) return response
    try {
      await response.body?.cancel()
    } catch (cancelled) {
      // A body that already failed leaves no buffered data to release.
      void cancelled
    }
    await policy.sleep(wait)
    response = await fetchImpl(url, init)
  }
  return response
}

/**
 * Read the provider's error message from an OpenAI-style or legacy body.
 * @param text - response text.
 * @param fallback - message used when the body carries none.
 * @returns a human-readable rejection reason.
 */
export function rejectionMessage(text: string, fallback: string): string {
  const body = parseJson(text)
  if (isRecord(body)) {
    if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message
    if (typeof body.message === 'string') return body.message
    if (isRecord(body.base_resp) && typeof body.base_resp.status_msg === 'string') return body.base_resp.status_msg
  }
  return text.trim().length === 0 ? fallback : text.trim()
}

/**
 * Parse JSON without throwing on a non-JSON body.
 * @param text - response text.
 * @returns the parsed value, or undefined when the body is not JSON.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Read one submission response and reject it when the provider refused the
 * request.
 * @param response - submission response.
 * @param label - provider name used in the rejection message.
 * @returns the response text of an accepted submission.
 * @throws {@link MediaFailure} for a refused submission, classified by status.
 */
export async function submitResponse(response: Response, label: string): Promise<string> {
  const text = await response.text()
  if (!response.ok) {
    throw new MediaFailure(
      `${label} rejected the video request: ${rejectionMessage(text, response.statusText)}`,
      failureCodeFor(response.status),
    )
  }
  return text
}

/** Fields one video download needs. */
interface DownloadVideoOptions {
  /** Provider name used in failure messages. */
  readonly label: string
  /** Output duration recorded on the artifact. */
  readonly durationSec: number
  /** Largest accepted artifact size in bytes. */
  readonly maxBytes: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/**
 * Download a settled video and verify its size cap.
 * @param fetchImpl - fetch implementation.
 * @param url - provider download URL.
 * @param options - labels, duration, cap, and cancellation.
 * @returns the downloaded artifact.
 * @throws {@link MediaFailure} for a failed download, an empty body, or an oversized body.
 */
export async function downloadVideo(
  fetchImpl: CloudFetchLike,
  url: string,
  options: DownloadVideoOptions,
): Promise<MediaArtifact> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new MediaFailure(`${options.label} download URL is not absolute`, 'MEDIA_ARTIFACT_INVALID', { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MediaFailure(`${options.label} download URL must use http or https`, 'MEDIA_ARTIFACT_INVALID')
  }
  const response = await fetchImpl(url, { signal: options.signal })
  if (!response.ok) {
    throw new MediaFailure(`${options.label} video download failed with HTTP ${response.status}`, 'MEDIA_TASK_FAILED')
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new MediaFailure(
      `${options.label} video is ${declared} bytes, above the configured ${options.maxBytes}-byte cap`,
      'MEDIA_ARTIFACT_TOO_LARGE',
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0) throw new MediaFailure(`${options.label} returned an empty video`, 'MEDIA_ARTIFACT_INVALID')
  if (bytes.length > options.maxBytes) {
    throw new MediaFailure(
      `${options.label} video is ${bytes.length} bytes, above the configured ${options.maxBytes}-byte cap`,
      'MEDIA_ARTIFACT_TOO_LARGE',
    )
  }
  return {
    id: 'video',
    kind: 'video',
    mediaType: 'video/mp4',
    bytes,
    durationSec: options.durationSec,
  }
}

/**
 * Record a settled failure while preserving the task identity.
 * @param task - current task.
 * @param message - failure description.
 * @param code - stable failure class.
 * @returns the failed task snapshot.
 */
export function failedTask(
  task: MediaTask,
  message: string,
  code: MediaFailure['code'] = 'MEDIA_TASK_FAILED',
): MediaTask {
  return { ...task, status: 'failed', error: { code, message } }
}

/**
 * Snapshot returned by a cloud video provider once the API accepted a job.
 * @param id - local task id.
 * @param provider - provider id.
 * @param model - submitted model id.
 * @returns the submitted task.
 */
export function submittedVideoTask(id: string, provider: string, model: string): MediaTask {
  return { id, provider, model, kind: 'video', status: 'submitted' }
}

/**
 * Download one settled artifact and return the settled task snapshot.
 *
 * The provider releases its pending entry either way, so polling a settled
 * task again reports it as untracked instead of downloading a second time.
 * @param task - task being settled.
 * @param fetchArtifact - download to attempt.
 * @param forget - releases the provider's pending entry.
 * @returns the succeeded task, or the failed snapshot when the download fails.
 */
export async function settledVideoTask(
  task: MediaTask,
  fetchArtifact: () => Promise<MediaArtifact>,
  forget: () => void,
): Promise<MediaTask> {
  try {
    const artifact = await fetchArtifact()
    return { ...task, status: 'succeeded', progress: 1, artifacts: [artifact] }
  } catch (error) {
    if (error instanceof MediaFailure) return failedTask(task, error.message, error.code)
    return failedTask(task, errorMessage(error))
  } finally {
    forget()
  }
}

/**
 * Fail a task whose provider no longer holds its pending state, as after a
 * process restart.
 * @param task - current task.
 * @returns the failed task snapshot.
 */
export function untrackedTask(task: MediaTask): MediaTask {
  return failedTask(task, 'task is not tracked; the provider process restarted')
}

/**
 * Map an accepted image extension to the media type of a data URI.
 * @param path - image path.
 * @returns the MIME type, or undefined for an extension no provider accepts.
 */
export function supportedImageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.heic': return 'image/heic'
    case '.heif': return 'image/heif'
    default: return undefined
  }
}

/** Limits one provider applies to a reference image it inlines as a data URI. */
export interface ImageDataUriOptions {
  /** Provider name used in failure messages. */
  readonly label: string
  /** Largest accepted image in bytes. */
  readonly maxBytes: number
}

/**
 * Read one reference image and encode it as a `data:` URI.
 *
 * Every cloud provider rejects an empty file: an empty `data:` URI makes the
 * provider bill a request it can only fail on the supplied content.
 * @param reference - image reference from the request.
 * @param options - provider name and size cap.
 * @returns the `data:` URI the provider accepts.
 * @throws {@link MediaFailure} for an unreadable, unsupported, empty, or oversized image.
 */
export async function imageDataUri(reference: MediaReference, options: ImageDataUriOptions): Promise<string> {
  const mediaType = supportedImageMediaType(reference.path)
  if (mediaType === undefined) {
    throw new MediaFailure(
      `${options.label} accepts png, jpeg, webp, heic, and heif images, not ${JSON.stringify(extname(reference.path))}`,
      'MEDIA_REQUEST_INVALID',
    )
  }
  let bytes: Buffer
  try {
    bytes = await readFile(reference.path)
  } catch (error) {
    throw new MediaFailure(
      `cannot read the ${options.label} reference image ${reference.path}: ${errorMessage(error)}`,
      'MEDIA_REQUEST_INVALID',
      { cause: error },
    )
  }
  if (bytes.byteLength === 0) {
    throw new MediaFailure(`the ${options.label} reference image ${reference.path} is empty`, 'MEDIA_REQUEST_INVALID')
  }
  if (bytes.byteLength > options.maxBytes) {
    throw new MediaFailure(
      `${options.label} reference images are capped at ${options.maxBytes} bytes; ${reference.path} is ${bytes.byteLength}`,
      'MEDIA_REQUEST_INVALID',
    )
  }
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/** Poll state the shared throttle reads from one tracked cloud task. */
export interface PendingPoll {
  /** Submission time in epoch milliseconds. */
  readonly submittedAt: number
  /** Last status poll time in epoch milliseconds. */
  lastPollAt: number
}

/** Poll cadence and failure deadline of one cloud provider. */
export interface PollSchedule {
  /** Minimum gap between two status polls for one task. */
  readonly pollMs: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs: number
}

/**
 * Interface boilerplate shared by the keyed cloud providers: the model table,
 * the local readiness check, the missing-credential remedy, and the status-poll
 * throttle.
 */
export abstract class KeyedCloudProvider implements MediaProvider {
  /** Registered provider id. */
  abstract readonly id: string

  /** Capability this provider serves. */
  abstract readonly capabilities: readonly MediaKind[]

  /**
   * @param credential - configured key or credential reference.
   * @param modelsById - models this provider serves.
   * @param identity - provider names used in the missing-credential remedy.
   */
  protected constructor(
    private readonly credential: CloudCredentialSettings,
    private readonly modelsById: readonly MediaModel[],
    private readonly identity: CloudProviderIdentity,
  ) {}

  /** Models the configured cloud key serves. */
  models(): readonly MediaModel[] {
    return this.modelsById
  }

  /** A key or credential reference was configured; reachability is proven by the first submission. */
  available(): boolean {
    return this.credential.apiKey.length > 0 || this.credential.apiKeyEnv !== undefined
  }

  /** Explain the missing credential so selection can report a remedy. */
  unavailableReason(): string | undefined {
    if (this.available()) return undefined
    return `set ${this.identity.envHint} in the environment or name it through ${this.identity.configPath}.apiKeyEnv`
  }

  /**
   * Resolve the pending record for one poll and apply the shared poll cadence.
   *
   * A record the provider no longer holds, a task past its deadline, and a
   * task polled too recently all resolve to the task state to return now. A
   * timed-out task is cancelled before the failure is reported.
   * @param pending - provider pending map keyed by local task id.
   * @param task - task being polled.
   * @param schedule - poll cadence and failure deadline.
   * @returns the pending record to query, or the task state to return now.
   */
  protected async beginPoll<P extends PendingPoll>(
    pending: Map<string, P>,
    task: MediaTask,
    schedule: PollSchedule,
  ): Promise<P | MediaTask> {
    const entry = pending.get(task.id)
    if (entry === undefined) return untrackedTask(task)
    const now = Date.now()
    if (now - entry.submittedAt > schedule.timeoutMs) {
      await this.cancel(task)
      return failedTask(task, `task did not settle within ${schedule.timeoutMs} ms`, 'MEDIA_TASK_TIMEOUT')
    }
    if (now - entry.lastPollAt < schedule.pollMs) return task
    entry.lastPollAt = now
    return entry
  }

  /**
   * Track one accepted submission and report the task consumers see.
   *
   * A runtime id is `<provider id>-<remote id>`, which is what `resume` and
   * `cancel` read back. The base stamps the submission time so every provider
   * measures its failure deadline from the same instant.
   * @param pending - provider pending map keyed by local task id.
   * @param remoteId - provider task id from the submission response.
   * @param buildEntry - builds the provider record from the submission time.
   * @param model - submitted model id.
   * @returns the submitted task.
   */
  protected trackSubmission<P extends PendingPoll>(
    pending: Map<string, P>,
    remoteId: string,
    buildEntry: (submittedAt: number) => P,
    model: string,
  ): MediaTask {
    const id = `${this.id}-${remoteId}`
    pending.set(id, buildEntry(Date.now()))
    return submittedVideoTask(id, this.id, model)
  }

  /**
   * Recover the remote id of a record this provider can resume.
   *
   * A runtime id is `<provider id>-<remote id>`, so a record from another
   * provider or kind, or one that carries no remote id, cannot be polled.
   * @param record - persisted task snapshot and request.
   * @returns the remote id, or undefined when this provider cannot poll the record.
   */
  protected resumedRemoteId(record: MediaTaskRecord): string | undefined {
    if (record.task.provider !== this.id || record.task.kind !== 'video') return undefined
    const prefix = `${this.id}-`
    if (!record.task.id.startsWith(prefix)) return undefined
    const remoteId = record.task.id.slice(prefix.length)
    return remoteId.length === 0 ? undefined : remoteId
  }

  /** Estimate one request from the provider's published rate. */
  abstract estimate(request: MediaRequest): MediaEstimate

  /** Start one task. */
  abstract submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask>

  /** Read the latest state of one task. */
  abstract poll(task: MediaTask, signal: AbortSignal): Promise<MediaTask>

  /** Request cancellation. Idempotent. */
  abstract cancel(task: MediaTask): Promise<void>
}
