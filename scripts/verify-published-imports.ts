/**
 * Verify that every bare package a published Host entry imports is declared as
 * a runtime dependency.
 *
 * The check reads built entries, not sources. tsdown inlines every import it
 * does not find in `dependencies`/`peerDependencies`/`optionalDependencies`, so
 * a source-level reading cannot distinguish "bundled, therefore fine" from
 * "left external, therefore unresolvable": only the emitted entry shows which
 * imports survived. Client packages are out of scope — their browser inputs
 * belong in `devDependencies` by policy.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { collectRuntimeSourcePackageUses } from './source-parse-uses.ts'

const GATE = 'verify-published-imports'

/** One entry that imports a package its manifest does not declare. */
export interface PublishedImportViolation {
  /** The importing package's manifest name, or its path when unnamed. */
  readonly packageName: string
  /** The undeclared bare package the entry imports. */
  readonly dependency: string
  /** Repository-relative path of the built entry. */
  readonly entry: string
}

/** Result of one audit over the workspace. */
export interface PublishedImportAudit {
  /** Packages whose built entry was inspected. */
  readonly checked: number
  /** Every undeclared import, plus every publishable package whose entry is missing. */
  readonly violations: readonly PublishedImportViolation[]
}

/** Package groups whose browser bundles keep their imports in `devDependencies`. */
const CLIENT_GROUP = 'client'

/**
 * Entries whose bare requires resolve through their own module loader instead
 * of node_modules. The webworker runtime mounts a virtual filesystem image and
 * reads `@deepseek-ai/dsh-app-boot`, `dsh-launch-environment`, and `dsh-cmdline`
 * through `loader.requireFrom(root)`, so they ship inside the image rather than
 * as installed dependencies.
 */
const LOADER_RESOLVED_DEPENDENCIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['@deepseek-ai/dsh-experimental-webworker-runtime', new Set([
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-cmdline',
  ])],
])

const BUILTINS = new Set(builtinModules)

/** Runtime sections a published entry may rely on. */
function declaredRuntimeDependencies(manifest: {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
}

/**
 * Audit every publishable Host package's built entry.
 * @param root - repository root holding `packages/`.
 * @returns the inspected package count and every violation, in path order.
 */
export function auditPublishedImports(root: string): PublishedImportAudit {
  const violations: PublishedImportViolation[] = []
  let checked = 0
  for (const group of readdirSync(join(root, 'packages')).sort()) {
    if (group === CLIENT_GROUP) continue
    const groupDir = join(root, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, name)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string
        main?: unknown
        private?: boolean
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      if (manifest.private === true || typeof manifest.main !== 'string') continue
      const packageName = manifest.name ?? relative(root, dir)
      const entry = join(dir, manifest.main)
      if (!existsSync(entry)) {
        violations.push({
          packageName,
          dependency: '(missing built entry)',
          entry: relative(root, entry),
        })
        continue
      }
      checked += 1
      const declared = declaredRuntimeDependencies(manifest)
      const loaderResolved = LOADER_RESOLVED_DEPENDENCIES.get(packageName) ?? new Set<string>()
      for (const dependency of collectRuntimeSourcePackageUses(entry, readFileSync(entry, 'utf8'))) {
        if (dependency === manifest.name
          || declared.has(dependency)
          || loaderResolved.has(dependency)
          || dependency.startsWith('node:')
          || BUILTINS.has(dependency)) continue
        violations.push({ packageName, dependency, entry: relative(root, entry) })
      }
    }
  }
  return { checked, violations }
}

/**
 * Report every violation and set the process exit code when any exists.
 * @returns the audit, for callers that assert on it.
 */
export function runPublishedImportsGate(): PublishedImportAudit {
  const root = join(import.meta.dirname, '..')
  const audit = auditPublishedImports(root)
  if (audit.checked === 0) {
    console.error(`${GATE}: no built entries found; run \`pnpm run build:artifacts\` first.`)
    process.exitCode = 1
    return audit
  }
  if (audit.violations.length > 0) {
    console.error(`${GATE}: ${String(audit.violations.length)} undeclared published import(s):`)
    for (const violation of audit.violations) {
      console.error(`  ${violation.packageName} (${violation.entry}) imports ${violation.dependency}`)
    }
    process.exitCode = 1
    return audit
  }
  console.log(`${GATE}: ${String(audit.checked)} published Host entr(ies) import only declared runtime dependencies.`)
  return audit
}

if (import.meta.main) runPublishedImportsGate()
