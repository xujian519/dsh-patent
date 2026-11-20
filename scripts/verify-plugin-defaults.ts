// Fail when one package declares the same default twice: once as a schema
// `.default(<literal>)` and once as a config fallback `<field> ?? <same literal>`.
// Two sources drift silently, because changing one leaves the other in place
// (F-PAT-024 recorded seven packages with 42 such pairs).

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GATE = 'verify-plugin-defaults'
const ROOT = resolve(import.meta.dirname, '..')
const REPORT_ONLY = process.argv.includes('--report')

/** A literal that can appear on either side of a duplicated default. */
const LITERAL = String.raw`(?:-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|true|false)`
const SCHEMA_DEFAULT = new RegExp(String.raw`(\w+)\s*:\s*[^,\n]*?\.default\(\s*(${LITERAL})\s*\)`, 'g')
const FALLBACK = new RegExp(String.raw`\.(\w+)\s*\?\?\s*(${LITERAL})\s*(?:[,;)\n]|$)`, 'g')

/** One source location that states a literal default for a field. */
export interface DefaultDeclaration {
  /** Repository-relative path with forward slashes. */
  path: string
  /** 1-based line number. */
  line: number
  /** Config field the literal belongs to. */
  field: string
  /** The literal exactly as written. */
  value: string
}

/** Source file content paired with its repository-relative path. */
export interface SourceInput {
  path: string
  source: string
}

/** Schema defaults and config fallbacks found in one source file. */
export interface SourceDeclarations {
  defaults: DefaultDeclaration[]
  fallbacks: DefaultDeclaration[]
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/** Extract schema defaults and config fallbacks from one source file. */
export function readDefaultDeclarations(input: SourceInput): SourceDeclarations {
  const defaults: DefaultDeclaration[] = []
  const fallbacks: DefaultDeclaration[] = []
  for (const match of input.source.matchAll(SCHEMA_DEFAULT)) {
    defaults.push({
      path: input.path,
      line: lineOf(input.source, match.index),
      field: match[1],
      value: match[2],
    })
  }
  for (const match of input.source.matchAll(FALLBACK)) {
    fallbacks.push({
      path: input.path,
      line: lineOf(input.source, match.index),
      field: match[1],
      value: match[2],
    })
  }
  return { defaults, fallbacks }
}

/** Workspace package directory owning a source path. */
function packageDirOf(path: string): string {
  const segments = path.split('/')
  return segments[0] === 'apps' ? segments.slice(0, 2).join('/') : segments.slice(0, 3).join('/')
}

/**
 * Report every field whose schema default is restated as a config fallback
 * with the same literal inside one package. Comparison is per package, so a
 * default declared in `config.ts` and re-stated in `index.ts` still counts.
 */
export function collectPluginDefaultViolations(files: readonly SourceInput[]): string[] {
  const defaults = new Map<string, DefaultDeclaration[]>()
  const fallbacks = new Map<string, DefaultDeclaration[]>()

  for (const file of files) {
    const declarations = readDefaultDeclarations(file)
    const dir = packageDirOf(file.path)
    if (declarations.defaults.length > 0) {
      const bucket = defaults.get(dir) ?? []
      bucket.push(...declarations.defaults)
      defaults.set(dir, bucket)
    }
    if (declarations.fallbacks.length > 0) {
      const bucket = fallbacks.get(dir) ?? []
      bucket.push(...declarations.fallbacks)
      fallbacks.set(dir, bucket)
    }
  }

  const violations: string[] = []
  for (const [dir, dirDefaults] of defaults) {
    for (const fallback of fallbacks.get(dir) ?? []) {
      const source = dirDefaults.find(
        declaration => declaration.field === fallback.field && declaration.value === fallback.value,
      )
      if (source === undefined) continue
      violations.push(
        `${fallback.path}:${fallback.line}: ${fallback.field} falls back to ${fallback.value},`
        + ` already declared at ${source.path}:${source.line}`,
      )
    }
  }
  return [...new Set(violations)].sort()
}

/** Read every `src/` TypeScript file the gate covers. */
function readWorkspaceSources(): SourceInput[] {
  const files: SourceInput[] = []
  for (const path of globSync(
    ['packages/*/*/src/**/*.ts', 'packages/*/*/src/**/*.tsx', 'apps/*/src/**/*.ts', 'apps/*/src/**/*.tsx'],
    { cwd: ROOT },
  ).sort()) {
    files.push({ path, source: readFileSync(resolve(ROOT, path), 'utf8') })
  }
  return files
}

function main(): void {
  const violations = collectPluginDefaultViolations(readWorkspaceSources())
  if (violations.length > 0) {
    const mode = REPORT_ONLY ? ' [REPORT]' : ''
    console.error(`${GATE}: ${violations.length} violation(s)${mode}`)
    for (const violation of violations) console.error(`  ${violation}`)
    if (!REPORT_ONLY) process.exitCode = 1
    return
  }
  console.log(`${GATE}: 0 violations - no config fallback restates a schema default`)
}

if (import.meta.main) main()
