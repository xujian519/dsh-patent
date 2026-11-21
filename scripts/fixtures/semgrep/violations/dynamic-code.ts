/** Fixture: `dsh-no-dynamic-code` must report the call below. */

/**
 * Evaluate caller-supplied JavaScript source text.
 * @param expression - source text to evaluate.
 * @returns the evaluated value.
 */
export function evaluateExpression(expression: string): unknown {
  return eval(expression)
}

/**
 * Compile caller-supplied source text into a function.
 * @param body - function body source text.
 * @returns the compiled function.
 */
export function compileBody(body: string): unknown {
  return new Function(body)
}
