/**
 * Source-launch anchors for the campaign's agent arms.
 *
 * An arm runs the harness entry from source while its working directory is the
 * task checkout, not the harness repository. Both things tsx resolves relative
 * to the working directory therefore break: the `tsx/esm` hook itself, and the
 * tsconfig whose `paths` map the `@deepseek-ai/*` workspace packages (they are
 * absent from `node_modules`). An arm would exit non-zero before the profile
 * boots, which the runner would score as a failed verdict.
 *
 * This module anchors both at the harness repository instead, so the entry
 * boots from any working directory.
 *
 * @module @deepseek-ai/dsh-self-evolve-eval/campaign/source-launch
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/** The tsconfig carrying the workspace `paths` the source plane resolves through. */
const WORKSPACE_TSCONFIG = 'tsconfig.base.json'

/** Why the anchors could not be derived, or the anchors themselves. */
interface SourceLaunchAnchors {
  /** Absolute path to the tsx ESM hook, importable from any working directory. */
  tsxImport: string
  /** Absolute path to the tsconfig whose `paths` the harness sources resolve through. */
  tsconfigPath: string
}

/** Caller-supplied anchors that replace the ones this module would resolve. */
interface SourceLaunchOverrides {
  /**
   * Absolute path to the tsx ESM hook. Supply it when tsx is not installed in
   * the harness workspace, or when the entry sits outside it (`--tsx-import`).
   */
  tsxImport?: string
}

/**
 * Derive the tsx hook and tsconfig paths from the harness entry.
 *
 * @param dshEntry - absolute path to the harness entry module.
 * @param overrides - anchors to use verbatim instead of resolving.
 * @returns the anchors to pass to an arm launch.
 * @throws when an anchor is missing and no override supplies it.
 */
export function resolveSourceLaunchAnchors(
  dshEntry: string,
  overrides: SourceLaunchOverrides = {},
): SourceLaunchAnchors {
  let tsxImport = overrides.tsxImport
  if (tsxImport === undefined) {
    try {
      tsxImport = createRequire(dshEntry).resolve('tsx/esm')
    } catch (cause) {
      throw new Error(
        `self-evolve-eval: cannot resolve the tsx ESM hook from ${dshEntry}; ` +
        'install tsx in the harness workspace or pass --tsx-import <absolute path>',
        { cause },
      )
    }
  }

  let directory = dirname(dshEntry)
  for (;;) {
    const candidate = join(directory, WORKSPACE_TSCONFIG)
    if (existsSync(candidate)) return { tsxImport, tsconfigPath: candidate }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(
    `self-evolve-eval: no ${WORKSPACE_TSCONFIG} above ${dshEntry}; ` +
    'the harness source plane resolves @deepseek-ai/* through its paths',
  )
}
