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
 * Assert a figure list carries positive, non-repeating figure numbers.
 *
 * Both figure-set tools accept the same per-figure entry, so the validation of
 * that entry lives here rather than in each tool's `execute`.
 * @param figures - the figure entries to check; only `figure_number` is read.
 * @param tool - the registered tool name carried in the error context.
 * @throws PatentToolError('invalid_tool_input') when a number is not a positive integer or repeats.
 */
export function assertUniqueFigureNumbers(figures: readonly { figure_number: number }[], tool: string): void {
  const seen = new Set<number>()
  for (const figure of figures) {
    if (!Number.isInteger(figure.figure_number) || figure.figure_number < 1) {
      throw new PatentToolError('invalid_tool_input', `figure_number 必须是正整数：${String(figure.figure_number)}`, { tool })
    }
    if (seen.has(figure.figure_number)) {
      throw new PatentToolError('invalid_tool_input', `figure_number 重复：${String(figure.figure_number)}——每张附图只能出现一次`, { tool })
    }
    seen.add(figure.figure_number)
  }
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
