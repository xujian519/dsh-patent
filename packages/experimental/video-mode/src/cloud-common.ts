/**
 * Shared cloud-provider transport: credential resolution, JSON headers, error
 * classification, response parsing, and video downloads. The MiniMax and
 * SiliconFlow providers share this code so a key-rotation or failure-code fix
 * reaches both capabilities.
 * @module @deepseek-ai/dsh-experimental-video-mode/cloud-common
 */

import { extname } from 'node:path'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaModel,
  type MediaProvider,
  type MediaRequest,
  type MediaTask,
} from './types.ts'
import { isRecord } from '@deepseek-ai/dsh-value'
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
 * Read an error message from an unknown thrown value.
 * @param error - caught value.
 * @returns a diagnostic string.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fields one video download needs. */
export interface DownloadVideoOptions {
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

/**
 * Interface boilerplate shared by the keyed cloud providers: the model table,
 * the local readiness check, and the missing-credential remedy.
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

  /** Estimate one request from the provider's published rate. */
  abstract estimate(request: MediaRequest): MediaEstimate

  /** Start one task. */
  abstract submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask>

  /** Read the latest state of one task. */
  abstract poll(task: MediaTask, signal: AbortSignal): Promise<MediaTask>

  /** Request cancellation. Idempotent. */
  abstract cancel(task: MediaTask): Promise<void>
}
