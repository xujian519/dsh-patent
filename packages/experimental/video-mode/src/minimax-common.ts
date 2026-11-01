/**
 * Shared MiniMax transport helpers. Credential resolution, JSON parsing, error
 * classification, and the keyed-provider boilerplate live in `cloud-common.ts`
 * because the SiliconFlow provider uses the same code; this module keeps the
 * MiniMax names and its credential remedy.
 * @module @deepseek-ai/dsh-experimental-video-mode/minimax-common
 */

import {
  KeyedCloudProvider,
  cloudJsonHeaders,
  resolveCloudKey,
  type CloudCredentialSettings,
  type CloudFetchLike,
  type CloudKeyResolver,
  type CloudProviderIdentity,
} from './cloud-common.ts'
import {
  type MediaKind,
  type MediaModel,
} from './types.ts'

export { failureCodeFor, isRecord, messageOf, parseJson, rejectionMessage } from './cloud-common.ts'

/** Minimal fetch surface both MiniMax providers need; tests inject a stub. */
export type MiniMaxFetchLike = CloudFetchLike

/** Settings subset that names a MiniMax credential. */
type MiniMaxCredentialSettings = CloudCredentialSettings

/** Resolves one credential reference through the host service. */
export type MiniMaxKeyResolver = CloudKeyResolver

/** Provider names used in MiniMax remedies. */
const MINIMAX_IDENTITY: CloudProviderIdentity = {
  label: 'MiniMax',
  envHint: 'MINIMAX_API_KEY',
  configPath: 'minimax',
}

/**
 * Resolve the bearer key for one operation through the shared cloud credential
 * path.
 * @param settings - provider settings carrying the direct key or reference.
 * @param resolveApiKey - credential resolver; omitted reads the process environment.
 * @returns the non-empty key.
 * @throws {@link MediaFailure} `MEDIA_PROVIDER_UNAVAILABLE` when the reference is unset.
 */
export async function resolveMiniMaxKey(
  settings: MiniMaxCredentialSettings,
  resolveApiKey?: MiniMaxKeyResolver,
): Promise<string> {
  return resolveCloudKey(settings, resolveApiKey, MINIMAX_IDENTITY)
}

/**
 * Build authorization and content headers for one MiniMax call.
 * @param apiKey - resolved bearer key.
 * @returns the request headers.
 */
export const minimaxJsonHeaders = cloudJsonHeaders

/**
 * Interface boilerplate shared by the keyed MiniMax providers: the model table,
 * the local readiness check, and the missing-credential remedy.
 */
export abstract class KeyedMiniMaxProvider extends KeyedCloudProvider {
  /** Registered provider id. */
  abstract override readonly id: string

  /** Capability this provider serves. */
  abstract override readonly capabilities: readonly MediaKind[]

  /**
   * @param credential - configured key or credential reference.
   * @param modelsById - models this provider serves.
   */
  protected constructor(
    credential: MiniMaxCredentialSettings,
    modelsById: readonly MediaModel[],
  ) {
    super(credential, modelsById, MINIMAX_IDENTITY)
  }
}
