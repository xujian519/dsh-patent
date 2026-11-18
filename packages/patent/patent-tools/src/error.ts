/**
 * Patent tool error, ported from Sati's `SatiToolRuntimeError` (renamed per dsh
 * conventions). A `HarnessError` subclass carrying a stable code so callers can
 * route failures without matching on prose and the code reaches `tool/result`
 * and the trajectory. The code set mirrors the Sati tool protocol so ported
 * tools keep their failure taxonomy.
 * @module @deepseek-ai/dsh-patent-tools/error
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable error codes the patent tools raise, matching Sati's tool protocol. */
export type PatentToolErrorCode =
  | 'tool_not_found'
  | 'invalid_tool_input'
  | 'permission_denied'
  | 'permission_cancelled'
  | 'permission_required'
  | 'tool_execution_failed'
  | 'tool_aborted'
  | 'tool_timeout'
  | 'tool_output_schema_mismatch'
  | 'result_too_large'
  | 'path_not_allowed'
  | 'file_not_found'
  | 'file_not_observed'
  | 'file_stale_version'
  | 'file_conflict'
  | 'unsupported_tool'
  | 'model_cannot_accept_image'
  | 'setup_required'
  | 'plan_mode_violation'
  | 'ask_mode_violation'

/**
 * A patent tool failure. The message is stable, model-visible prose; the code is
 * the stable programmatic discriminator and `details` carries structured
 * context (tool name, patent number, error code from an upstream source, etc.).
 */
export class PatentToolError extends HarnessError {
  /** Stable programmatic error code (Sati tool-protocol taxonomy). */
  declare readonly code: PatentToolErrorCode
  /** Structured error context (tool name, patent number, upstream code, etc.). */
  readonly details: Record<string, unknown> | undefined

  /**
   * @param code - stable programmatic error code.
   * @param message - stable, model-visible prose.
   * @param details - structured error context.
   */
  constructor(code: PatentToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message, code)
    this.details = details
  }
}
