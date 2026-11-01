/**
 * Field readers for model-supplied JSON at a tool boundary. A missing or
 * mistyped field becomes an `invalid_tool_input` error naming the tool and the
 * offending path instead of a bare TypeScript error.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/tool-input
 */

import { PatentToolError } from '../../error.ts'

/** Field readers bound to one tool name. */
interface ToolInputReader {
  /**
   * Build a field-level input error.
   * @param message - the model-facing message naming the field and expectation.
   * @returns the error to throw.
   */
  invalid: (message: string) => PatentToolError
  /**
   * Read a required string field.
   * @param raw - the JSON value.
   * @param field - field path used in the error.
   * @returns the string value.
   */
  requireString: (raw: unknown, field: string) => string
  /**
   * Read a required boolean field.
   * @param raw - the JSON value.
   * @param field - field path used in the error.
   * @returns the boolean value.
   */
  requireBoolean: (raw: unknown, field: string) => boolean
}

/**
 * Reject blank text at a tool entry.
 *
 * A zero-byte call must not stand in for a completed check, so the tool fails
 * instead of evaluating an empty draft.
 * @param text - the caller-supplied text.
 * @param tool - the registered tool name carried in the error context.
 * @param message - model-facing reason naming the text the tool needs.
 * @throws PatentToolError('invalid_tool_input') when the text is empty or whitespace.
 */
export function requireNonBlankText(text: string, tool: string, message: string): void {
  if (text.trim().length === 0) throw new PatentToolError('invalid_tool_input', message, { tool })
}

/**
 * Create field readers whose errors name one tool.
 * @param tool - the registered tool name carried in the error context.
 * @returns the field readers.
 */
export function createToolInputReader(tool: string): ToolInputReader {
  const invalid = (message: string): PatentToolError => new PatentToolError('invalid_tool_input', message, { tool })
  return {
    invalid,
    requireString: (raw, field) => {
      if (typeof raw !== 'string') throw invalid(`${field} 必须是字符串`)
      return raw
    },
    requireBoolean: (raw, field) => {
      if (typeof raw !== 'boolean') throw invalid(`${field} 必须是布尔值`)
      return raw
    },
  }
}
