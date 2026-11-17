/**
 * Literature tool error, ported from Sati's `SatiToolRuntimeError` (renamed per dsh
 * conventions). A `HarnessError` subclass carrying a stable code so callers can route
 * failures without matching on prose and the code reaches `tool/result`.
 * @module @deepseek-ai/dsh-tool-literature/error
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable error codes the literature tools raise. */
export type LiteratureToolErrorCode =
  | 'invalid_tool_input'
  | 'tool_execution_failed'

/**
 * A literature tool failure. The message is stable, model-visible prose; the code is the
 * stable programmatic discriminator.
 */
export class LiteratureToolError extends HarnessError {
  /** Stable programmatic error code. */
  declare readonly code: LiteratureToolErrorCode
  /** Structured error context. */
  readonly details?: Record<string, unknown>

  /**
   * @param code - stable programmatic error code.
   * @param message - model-visible prose.
   * @param details - structured error context.
   */
  constructor(code: LiteratureToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message, code)
    this.details = details
  }
}
