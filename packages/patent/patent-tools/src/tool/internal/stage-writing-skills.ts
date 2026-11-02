/**
 * Optional bridge from the `writingPatterns` service onto `StageProvider`.
 *
 * The writing-patterns plugin is not a dependency of this package. The host
 * reads whatever object is registered under that name and copies a stage's
 * compiled skills into the atom prompt. A missing service or an undeclared
 * stage returns no text, so the prompt stays on the pattern index and the
 * query tool.
 */

/** The two methods this host reads from `writingPatterns`. */
export type StagePatternLookup = {
  /** Stage ids the deployment declared. */
  stageIds(): readonly string[]
  /** Compiled `<writing_skills>` block for one declared stage. */
  compiledForStage(stageId: string): string
}

/**
 * Narrow an optional service value to the stage-pattern lookup.
 * @param value - `ctx.get('writingPatterns')`, which is absent when the plugin is not mounted.
 * @returns the lookup, or undefined when the value does not expose both methods.
 */
export function readStagePatterns(value: unknown): StagePatternLookup | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('stageIds' in value) || typeof value.stageIds !== 'function') return undefined
  if (!('compiledForStage' in value) || typeof value.compiledForStage !== 'function') return undefined
  return value as StagePatternLookup
}

/**
 * Compiled writing skills for one workflow stage, or undefined when that stage
 * has no declared map.
 * @param service - the mounted lookup; undefined when the plugin is absent.
 * @param stageId - the workflow stage id used as the `stagePatterns` key.
 * @returns the compiled block, without surrounding whitespace.
 */
export function stageWritingSkills(
  service: StagePatternLookup | undefined,
  stageId: string,
): string | undefined {
  if (service === undefined) return undefined
  if (!service.stageIds().includes(stageId)) return undefined
  const block = service.compiledForStage(stageId).trim()
  return block.length === 0 ? undefined : block
}
