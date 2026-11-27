/**
 * Statement/rubric contamination guard (C2).
 *
 * A benchmark case pairs a public `statement` with a private `rubric`. The
 * optimizer must see only the public surface — never the scoring standard, or
 * it could "solve" a case by aiming at its rubric instead of its task.
 * {@link publicBenchmarkView} derives exactly that surface, and
 * {@link assertNoPrivateLeak} refuses to build an optimizer context that
 * carries any private field, halting the loop instead of optimizing on
 * contaminated evidence (matching penguin-harness' pollute-and-stop rule).
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark/contamination
 */

import type { BenchmarkId, CaseId } from './brand.ts'
import type { BoundBenchmark } from './types.ts'

/** Field names that must never appear in an optimizer context. */
export const PRIVATE_FIELD_NAMES = ['rubric', 'rubrics', 'gold', 'goldAnswer', 'expectedAnswer'] as const

/** Thrown when private scoring material would reach an optimizer context. */
export class ContaminationError extends Error {
  constructor(label: string, field: string) {
    super(`contamination guard: "${label}" exposes private field "${field}"`)
    this.name = 'ContaminationError'
  }
}

/**
 * The optimizer-facing projection of a benchmark: identity and public case
 * text only. Benchmark metadata the engine reads before optimizing (such as
 * `optimizable`) is not part of the surface handed to proposal and
 * optimization prompts.
 */
export type PublicBenchmarkView = {
  /** Benchmark identifier. */
  id: BenchmarkId
  /** Human-readable title. */
  title: string
  /** Cases with their public statement only. */
  cases: { caseId: CaseId; statement: string }[]
}

/**
 * The public face of a benchmark: case ids and statements only, with every
 * private field dropped. This is the value handed to proposal and optimization
 * prompts.
 *
 * @param benchmark Loaded benchmark.
 * @returns A copy with every private field dropped.
 */
export function publicBenchmarkView(benchmark: BoundBenchmark): PublicBenchmarkView {
  return {
    id: benchmark.id,
    title: benchmark.title,
    cases: benchmark.cases.map(({ caseId, statement }) => ({ caseId, statement })),
  }
}

/**
 * Assert that a value carries no private field at any depth. Throws a
 * {@link ContaminationError} naming the offending field; a passing call
 * returns undefined. Recursion walks plain objects and arrays and stops at
 * `null`.
 *
 * @param value Value to scan.
 * @param label Context label for the error message.
 */
export function assertNoPrivateLeak(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateLeak(item, label)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((PRIVATE_FIELD_NAMES as readonly string[]).includes(key)) throw new ContaminationError(label, key)
    assertNoPrivateLeak(child, label)
  }
}
