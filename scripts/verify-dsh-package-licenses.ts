/**
 * Enforce an MIT-selectable license declaration for repository-owned DSH npm packages.
 * @module scripts/verify-dsh-package-licenses
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import parseSpdx from 'spdx-expression-parse'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_PACKAGE_NAME = /^@deepseek-ai\/dsh(?:-|$)/

/** Result of checking every DSH package reachable through the root workspace list. */
export interface DshPackageLicenseReport {
  /** Number of DSH package manifests checked. */
  packageCount: number
  /** Repository-relative diagnostics for non-MIT declarations. */
  failures: string[]
}

function readManifest(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`verify-dsh-package-licenses: ${file} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function workspaceManifestPaths(root: string): string[] {
  const rootManifest = readManifest(root, 'package.json')
  const workspaces = rootManifest.workspaces
  if (!isStringArray(workspaces)) {
    throw new Error('verify-dsh-package-licenses: package.json workspaces must be a string array.')
  }

  const files = new Set(['package.json'])
  for (const pattern of workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

function printable(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function allowsMit(expression: ReturnType<typeof parseSpdx>): boolean {
  if ('conjunction' in expression) {
    // `OR` needs one alternative a consumer may take; `AND` applies every obligation.
    return expression.conjunction === 'or'
      && (allowsMit(expression.left) || allowsMit(expression.right))
  }
  return expression.plus !== true
    && expression.exception === undefined
    && expression.license === 'MIT'
}

/**
 * Whether a manifest declaration still lets a consumer use the package under MIT.
 * @param license - the raw `license` value from the package manifest.
 * @returns true for MIT and for expressions with an MIT disjunct; false otherwise.
 */
export function declaresMit(license: unknown): boolean {
  if (typeof license !== 'string') return false
  // Some npm manifests use a slash for a choice despite SPDX requiring `OR`.
  const normalized = license.replace(/\s*\/\s*/g, ' OR ').trim()
  try {
    return allowsMit(parseSpdx(normalized))
  } catch {
    return false
  }
}

/**
 * Check every DSH npm package declared by the repository workspace.
 * @param root - absolute repository root containing the workspace package.json.
 * @returns the checked package count and every non-MIT declaration.
 */
export function inspectDshPackageLicenses(root: string): DshPackageLicenseReport {
  let packageCount = 0
  const failures: string[] = []

  for (const file of workspaceManifestPaths(root)) {
    const manifest = readManifest(root, file)
    const name = manifest.name
    if (typeof name !== 'string' || !DSH_PACKAGE_NAME.test(name)) continue

    packageCount++
    if (!declaresMit(manifest.license)) {
      const normalizedFile = file.split(sep).join('/')
      failures.push(
        `${normalizedFile}: ${name} must declare a license allowing MIT; found ${printable(manifest.license)}.`,
      )
    }
  }

  return { packageCount, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectDshPackageLicenses(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-dsh-package-licenses: non-MIT DSH package declarations found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-dsh-package-licenses: ${String(report.packageCount)} DSH package(s) checked; all declare a license allowing MIT.\n`,
    )
  }
}
