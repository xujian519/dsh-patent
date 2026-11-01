/**
 * Managed install pipeline: preview against the npm registry, snapshot the
 * profile manifest before an add, roll back on failure, and persist durable
 * receipts keying uninstall. The package manager is the profile's own pnpm
 * (injectable for tests); every install that changes the profile goes through
 * this seam so a failed add never leaves the profile half-installed.
 * @module @deepseek-ai/dsh-host-plugin-market/install
 */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallPreview, InstallReceipt, ReceiptId } from './types.ts'
import { restrictedFetchJson, type RestrictedFetchOptions } from './restricted-fetch.ts'

/** The lifecycle script names a preview reports. */
export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** npm package name (scoped or unscoped), matching the catalog schema's constraint. */
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** A parsed `name@version` reference. */
interface PackageRef {
  name: string
  version: string
}

/** The outcome of one package-manager invocation. */
interface PnpmResult {
  /** Process exit status; non-zero means the invocation failed. */
  status: number
  /** Captured stderr tail for diagnostics. */
  stderr: string
}

/** Options for preview and install operations. */
export interface InstallOptions {
  /** npm registry base URL (default the public registry). */
  registry?: string
  /** Directory holding installation receipts (default `<profileDir>/.dsh-plugin-market/receipts`). */
  receiptDir?: string
  /** Package-manager runner (default spawns `pnpm` in the profile). */
  runPnpm?: (cwd: string, args: readonly string[]) => PnpmResult
  /** Fetch bounds for registry requests. */
  fetch?: RestrictedFetchOptions
}

/** Default npm registry. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** The receipts directory name under the profile. */
const RECEIPTS_DIR = '.dsh-plugin-market/receipts'

/**
 * Parse a `name@version` reference; scoped names keep their leading `@`.
 * @param ref - the reference to parse.
 * @returns the package name and version.
 * @throws {Error} on a malformed reference.
 */
export function parseRef(ref: string): PackageRef {
  const at = ref.lastIndexOf('@')
  if (at <= 0) throw new Error(`invalid package reference ${JSON.stringify(ref)}; expected name@version`)
  const name = ref.slice(0, at)
  const version = ref.slice(at + 1)
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`invalid package name ${JSON.stringify(name)}`)
  if (version.length === 0 || version.length > 64) throw new Error(`invalid version ${JSON.stringify(version)}`)
  return { name, version }
}

/**
 * Minimal Node-engine satisfiability for the comparators pnpm-style manifests
 * use (`x`, `x.y`, `>=x.y.z`, `^x.y.z`, `~x.y.z`, `*`). Full semver ranges
 * are the package manager's job; this is a preview heuristic that never
 * blocks an install (the manager enforces engines when configured).
 * @param enginesNode - the manifest's `engines.node` value.
 * @param version - the running Node version (default `process.versions.node`).
 * @returns whether the first comparator accepts the version.
 */
export function nodeSatisfies(enginesNode: string, version: string = process.versions.node): boolean {
  const trimmed = enginesNode.trim()
  if (trimmed === '' || trimmed === '*') return true
  const branches = trimmed.split(/\s*\|\|\s*/).map(branch => branch.trim())
  return branches.some(branch => satisfiesSingle(branch, version))
}

/** Whether one comparator (no OR) accepts the running Node version. */
function satisfiesSingle(comparator: string, version: string): boolean {
  const match = /^(>=|<=|>|<|\^|~|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(comparator)
  if (match === null) return true // an unparseable comparator is not a gate
  const [, op, majorS, minorS, patchS] = match
  const current = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version)
  if (current === null) return true
  /* v8 ignore next 3 -- the version regex always captures the major group. */
  const major = Number(current[1] ?? 0)
  const minor = Number(current[2] ?? 0)
  const patch = Number(current[3] ?? 0)
  const targetMajor = Number(majorS)
  const targetMinor = minorS === undefined ? 0 : Number(minorS)
  const targetPatch = patchS === undefined ? 0 : Number(patchS)
  const cmp = (): number => {
    if (major !== targetMajor) return major - targetMajor
    if (minor !== targetMinor) return minor - targetMinor
    return patch - targetPatch
  }
  switch (op) {
    case '>=': return cmp() >= 0
    case '<=': return cmp() <= 0
    case '>': return cmp() > 0
    case '<': return cmp() < 0
    case '^': return major === targetMajor && cmp() >= 0
    case '~': return major === targetMajor && minor === targetMinor && cmp() >= 0
    case '=': return cmp() === 0
    default: return major === targetMajor && cmp() >= 0 // bare `x` / `x.y`
  }
}

/**
 * Preview a package reference against the npm registry: existence, deprecation,
 * lifecycle scripts, and a Node-engine compatibility hint. The profile is not
 * touched.
 * @param ref - `name@version`.
 * @param options - registry and fetch bounds.
 * @returns the verification result.
 */
export async function previewInstall(ref: string, options: InstallOptions = {}): Promise<InstallPreview> {
  const { name, version } = parseRef(ref)
  const registry = options.registry ?? DEFAULT_REGISTRY
  const url = `${registry.replace(/\/$/, '')}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  let payload: unknown
  try {
    payload = await restrictedFetchJson(url, options.fetch)
  } catch {
    return { package: name, version, verified: false, reasons: ['package not found or registry unreachable'], lifecycleScripts: [], compatible: true }
  }
  const manifest = payload as Record<string, unknown>
  const deprecated = manifest.deprecated
  const dist = manifest.dist as Record<string, unknown> | undefined
  const scripts = manifest.scripts as Record<string, unknown> | undefined
  const lifecycleScripts = LIFECYCLE_SCRIPTS.filter(script => typeof scripts?.[script] === 'string')
  const engines = manifest.engines as { node?: unknown } | undefined
  const enginesNode = typeof engines?.node === 'string' ? engines.node : undefined
  const reasons: string[] = []
  if (typeof deprecated === 'string' && deprecated.length > 0) reasons.push(`package is deprecated: ${deprecated}`)
  if (dist?.tarball === undefined || dist.integrity === undefined) reasons.push('registry entry has no installable dist')
  if (lifecycleScripts.length > 0) reasons.push(`runs lifecycle scripts: ${lifecycleScripts.join(', ')}`)
  return {
    package: name,
    version,
    verified: reasons.length === 0,
    reasons,
    lifecycleScripts,
    compatible: enginesNode === undefined ? true : nodeSatisfies(enginesNode),
  }
}

/** One profile manifest file captured before an install. */
interface ProfileSnapshot {
  files: Record<string, string>
}

/**
 * Capture the profile manifest files an install may rewrite.
 * @param dir - the profile directory.
 * @returns the captured manifest contents.
 */
export function snapshotProfile(dir: string): ProfileSnapshot {
  const files: Record<string, string> = {}
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const path = join(dir, file)
    if (existsSync(path)) files[file] = readFileSync(path, 'utf8')
  }
  return { files }
}

/**
 * Restore a captured snapshot over the profile.
 * @param dir - the profile directory.
 * @param snapshot - the manifest contents captured by {@link snapshotProfile}.
 */
export function restoreSnapshot(dir: string, snapshot: ProfileSnapshot): void {
  for (const [file, content] of Object.entries(snapshot.files)) {
    writeFileSync(join(dir, file), content)
  }
}

/**
 * The default package-manager runner: `pnpm <args>` in the profile.
 * @param cwd - the directory pnpm runs in.
 * @param args - pnpm arguments.
 * @returns the process exit status and captured stderr.
 */
export function runPnpm(cwd: string, args: readonly string[]): PnpmResult {
  const result = spawnSync('pnpm', [...args], { cwd, stdio: 'pipe', encoding: 'utf8' })
  // On a spawn failure (missing pnpm, bad cwd) Node reports no status and a
  // nullish stderr despite the string-typed declaration; normalize both.
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return { status: result.status ?? 1, stderr }
}

/**
 * Resolve the receipts directory for one profile.
 * @param profileDir - the profile directory.
 * @param options - receipt dir override.
 * @returns the absolute receipts directory.
 */
export function receiptDirFor(profileDir: string, options: InstallOptions): string {
  return options.receiptDir ?? join(profileDir, RECEIPTS_DIR)
}

/**
 * Install a package into the profile with snapshot/rollback and a durable
 * receipt. The package manager runs `pnpm add <name>@<version>` in the
 * profile; any non-zero status restores the captured manifest files.
 * @param profileDir - the profile directory.
 * @param ref - `name@version`.
 * @param options - registry, receipt dir, and runner overrides.
 * @returns the durable receipt.
 */
export function installPlugin(profileDir: string, ref: string, options: InstallOptions = {}): InstallReceipt {
  const { name, version } = parseRef(ref)
  const snapshot = snapshotProfile(profileDir)
  const run = options.runPnpm ?? runPnpm
  const result = run(profileDir, ['add', `${name}@${version}`])
  if (result.status !== 0) {
    restoreSnapshot(profileDir, snapshot)
    throw new Error(`pnpm add failed (${result.status}): ${result.stderr.trim() || 'no stderr'}`)
  }
  const receipt: InstallReceipt = {
    id: randomUUID() as ReceiptId,
    package: name,
    version,
    profile: profileDir,
    installedAt: new Date().toISOString(),
  }
  writeReceipt(receiptDirFor(profileDir, options), receipt)
  return receipt
}

/**
 * Uninstall a previously managed installation, refusing when the receipt
 * does not match the current profile.
 * @param profileDir - the profile directory.
 * @param receiptId - the receipt identity.
 * @param options - receipt dir and runner overrides.
 */
export function uninstallPlugin(profileDir: string, receiptId: string, options: InstallOptions = {}): void {
  const receipt = readReceipt(receiptDirFor(profileDir, options), receiptId)
  if (receipt.profile !== profileDir) {
    throw new Error(`receipt ${receiptId} belongs to ${receipt.profile}, not ${profileDir}`)
  }
  const run = options.runPnpm ?? runPnpm
  const result = run(profileDir, ['remove', receipt.package])
  if (result.status !== 0) {
    throw new Error(`pnpm remove failed (${result.status}): ${result.stderr.trim() || 'no stderr'}`)
  }
  rmSync(join(receiptDirFor(profileDir, options), `${receiptId}.json`), { force: true })
}

/**
 * Write one receipt file.
 * @param receiptDir - the receipts directory.
 * @param receipt - the receipt to persist.
 */
export function writeReceipt(receiptDir: string, receipt: InstallReceipt): void {
  mkdirSync(receiptDir, { recursive: true })
  writeFileSync(join(receiptDir, `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
}

/**
 * Read one receipt file, throwing when it is absent or malformed.
 * @param receiptDir - the receipts directory.
 * @param receiptId - the receipt identity.
 * @returns the parsed receipt.
 */
export function readReceipt(receiptDir: string, receiptId: string): InstallReceipt {
  const path = join(receiptDir, `${receiptId}.json`)
  if (!existsSync(path)) throw new Error(`no receipt ${receiptId}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstallReceipt
  } catch {
    throw new Error(`receipt ${receiptId} is malformed`)
  }
}

/**
 * List every receipt in a directory (empty when the directory is absent).
 * @param receiptDir - the receipts directory.
 * @returns every parsed receipt, in readdir order.
 */
export function listReceipts(receiptDir: string): readonly InstallReceipt[] {
  if (!existsSync(receiptDir)) return []
  return readdirSync(receiptDir)
    .filter(file => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(receiptDir, file), 'utf8')) as InstallReceipt
      } catch {
        throw new Error(`receipt ${file} is malformed`)
      }
    })
    .sort((a, b) => a.installedAt.localeCompare(b.installedAt) || a.id.localeCompare(b.id))
}
