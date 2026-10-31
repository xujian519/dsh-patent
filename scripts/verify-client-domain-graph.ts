/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts` / `locales.ts` /
 * `pages.ts`) may import across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts, pages.ts  assembly point, provider composition, locale table
 *
 * Image and font imports name a resource, not a domain edge: the bundler
 * resolves them and no sibling implementation is reachable through the path.
 *
 * Existing violations live in `scripts/client-domain-graph.baseline.json`
 * with a reason per entry. The gate rejects every violation the baseline does
 * not record and every entry the tree no longer produces, so the file can only
 * shrink. Rewrite it with `--prune` after fixing a domain.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts
 */

import { existsSync, globSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')
const BASELINE_PATH = 'scripts/client-domain-graph.baseline.json'

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx', 'locales.ts', 'pages.ts'])
/** Resource imports resolved by the bundler; they name no implementation module. */
const RESOURCE_EXTENSIONS = /\.(?:avif|gif|ico|jpe?g|png|svg|webp|woff2?)$/iu

/** One cross-domain import in a client package. */
export interface DomainViolation {
  /** Repository-relative importing file. */
  file: string
  /** Relative specifier written in the source. */
  imported: string
  /** Why the edge breaks the layering model. */
  reason: string
}

/** One accepted violation, with the reason the tree still carries it. */
export interface BaselineEntry {
  /** Repository-relative importing file. */
  file: string
  /** Relative specifier written in the source. */
  imported: string
  /** Number of occurrences recorded for this file and specifier. */
  count: number
  /** Decision and removal target for accepting the edge. */
  reason: string
}

/** The recorded debt file. */
export interface DomainGraphBaseline {
  entries: BaselineEntry[]
}

/** What the current tree produces relative to the recorded baseline. */
export interface BaselineComparison {
  /** Violations absent from the baseline, or above its recorded count. */
  unexpected: DomainViolation[]
  /** Baseline entries that no longer match the tree, or whose count dropped. */
  stale: BaselineEntry[]
}

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve one relative import to a client-directory-relative path.
 * @param file - Importing file relative to `src/client`.
 * @param specifier - Relative module specifier from that file.
 * @returns Normalized path, preserving leading `..` segments outside `src/client`.
 */
export function resolveClientImport(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

/**
 * Whether a specifier imports a static resource rather than a source module.
 * @param specifier - Relative module specifier from the source.
 * @returns true for image and font paths, including bundler query suffixes.
 */
export function isResourceImport(specifier: string): boolean {
  return RESOURCE_EXTENSIONS.test(specifier.split(/[?#]/u, 1)[0] ?? '')
}

/**
 * Collect cross-domain imports in one client package.
 * @param pkgName - repository-relative package directory under `packages/client`.
 * @param clientDir - absolute path to that package's `src/client`.
 * @returns every import that breaks the layering model.
 */
export function packageViolations(pkgName: string, clientDir: string): DomainViolation[] {
  const violations: DomainViolation[] = []
  const files = listSources(clientDir)
  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec === undefined || isResourceImport(spec)) continue
      const target = resolveClientImport(rel, spec)
      if (target === '..' || target.startsWith('../')) continue // package-level rules govern
      const toDomain = domainOf(target)
      if (toDomain === '' || CONTRACT_DIRS.has(toDomain)) continue // top-level shared file or contract layer
      if (fromDomain === toDomain) continue // inside one domain
      violations.push({
        file: `${pkgName}/src/client/${rel}`,
        imported: spec,
        reason: fromDomain === ''
          ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
          : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
      })
    }
  }
  return violations
}

/**
 * Scan every client package that has a browser half.
 * @param clientDir - absolute path to `packages/client`.
 * @returns every cross-domain import in the tree.
 */
export function collectViolations(clientDir: string): DomainViolation[] {
  const violations: DomainViolation[] = []
  for (const pkg of readdirSync(clientDir)) {
    const packageClientDir = join(clientDir, pkg, 'src/client')
    try {
      if (!statSync(packageClientDir).isDirectory()) continue
    } catch {
      // No client half in this package — nothing to layer-check.
      continue
    }
    violations.push(...packageViolations(`packages/client/${pkg}`, packageClientDir))
  }
  return violations
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClientSource(file: unknown): file is string {
  return typeof file === 'string'
    && file.startsWith('packages/client/')
    && file.includes('/src/client/')
    && !file.includes('\\')
    && !file.split('/').includes('..')
}

/**
 * Parse the recorded debt file.
 * @param value - parsed JSON value.
 * @returns validated baseline entries.
 * @throws when the document, entry, or reason is malformed.
 */
export function parseBaseline(value: unknown): DomainGraphBaseline {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error('verify-client-domain-graph: baseline must be {"entries": [...]}')
  }
  const seen = new Set<string>()
  const entries: BaselineEntry[] = value.entries.map((raw, index) => {
    if (!isRecord(raw)
      || !isClientSource(raw.file)
      || typeof raw.imported !== 'string'
      || (!raw.imported.startsWith('./') && !raw.imported.startsWith('../'))
      || typeof raw.count !== 'number'
      || !Number.isSafeInteger(raw.count)
      || raw.count <= 0
      || typeof raw.reason !== 'string'
      || raw.reason.trim() === '') {
      throw new Error(`verify-client-domain-graph: invalid baseline entry ${index}`)
    }
    const key = `${raw.file}\0${raw.imported}`
    if (seen.has(key)) throw new Error(`verify-client-domain-graph: duplicate baseline entry ${raw.file} -> ${raw.imported}`)
    seen.add(key)
    return { file: raw.file, imported: raw.imported, count: raw.count, reason: raw.reason }
  })
  return { entries }
}

/**
 * Compare the tree with the recorded baseline.
 * @param violations - current cross-domain imports.
 * @param baseline - accepted imports with reasons.
 * @returns new violations and entries that no longer describe the tree.
 */
export function compareBaseline(
  violations: readonly DomainViolation[],
  baseline: DomainGraphBaseline,
): BaselineComparison {
  const actual = new Map<string, DomainViolation[]>()
  for (const violation of violations) {
    const key = `${violation.file}\0${violation.imported}`
    const bucket = actual.get(key)
    if (bucket === undefined) actual.set(key, [violation])
    else bucket.push(violation)
  }
  const recorded = new Map(baseline.entries.map(entry => [`${entry.file}\0${entry.imported}`, entry]))
  const unexpected: DomainViolation[] = []
  for (const [key, bucket] of actual) {
    const entry = recorded.get(key)
    const accepted = entry?.count ?? 0
    if (bucket.length > accepted) unexpected.push(...bucket.slice(accepted))
  }
  const stale: BaselineEntry[] = []
  for (const entry of baseline.entries) {
    const count = actual.get(`${entry.file}\0${entry.imported}`)?.length ?? 0
    if (count < entry.count) stale.push(entry)
  }
  return { unexpected, stale }
}

function readBaseline(): DomainGraphBaseline {
  const path = resolve(root, BASELINE_PATH)
  if (!existsSync(path)) return { entries: [] }
  return parseBaseline(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

/**
 * Rewrite the baseline from current violations, preserving recorded reasons.
 * Entries whose count dropped are removed; new violations keep the gate red.
 * @param violations - current cross-domain imports.
 * @param baseline - previous entries.
 * @returns the entries that remain accepted.
 */
export function prunedBaseline(
  violations: readonly DomainViolation[],
  baseline: DomainGraphBaseline,
): DomainGraphBaseline {
  const actual = new Map<string, number>()
  for (const violation of violations) {
    const key = `${violation.file}\0${violation.imported}`
    actual.set(key, (actual.get(key) ?? 0) + 1)
  }
  return {
    entries: baseline.entries
      .filter(entry => (actual.get(`${entry.file}\0${entry.imported}`) ?? 0) >= entry.count)
      .map(entry => ({ ...entry, count: Math.min(entry.count, actual.get(`${entry.file}\0${entry.imported}`) ?? 0) }))
      .sort((left, right) => left.file.localeCompare(right.file) || left.imported.localeCompare(right.imported)),
  }
}

function main(): void {
  const prune = process.argv.includes('--prune')
  const violations = collectViolations(CLIENT_DIR)
  const baseline = readBaseline()
  const comparison = compareBaseline(violations, baseline)

  if (comparison.unexpected.length > 0) {
    console.error(`verify-client-domain-graph: ${comparison.unexpected.length} new violation(s):`)
    for (const violation of comparison.unexpected) {
      console.error(`  ${violation.file} -> ${violation.imported}\n    ${violation.reason}`)
    }
    console.error(`Accept a violation only by adding it with a reason to ${BASELINE_PATH}.`)
  }
  if (comparison.stale.length > 0) {
    console.error(`verify-client-domain-graph: ${comparison.stale.length} stale baseline entr(y/ies); run with --prune:`)
    for (const entry of comparison.stale) {
      console.error(`  ${entry.file} -> ${entry.imported} (recorded ${entry.count})`)
    }
  }
  if (prune) {
    if (comparison.unexpected.length > 0) {
      console.error('verify-client-domain-graph: refusing to prune while new violations are present.')
      process.exitCode = 1
      return
    }
    const pruned = prunedBaseline(violations, baseline)
    writeFileSync(resolve(root, BASELINE_PATH), `${JSON.stringify(pruned, null, 2)}\n`)
    console.log(`verify-client-domain-graph: baseline pruned to ${pruned.entries.length} entr(y/ies).`)
    return
  }
  if (comparison.unexpected.length > 0 || comparison.stale.length > 0) {
    process.exitCode = 1
    return
  }
  console.log(`verify-client-domain-graph: ${baseline.entries.length} accepted violation(s), no new edges.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
