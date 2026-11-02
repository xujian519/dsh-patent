/**
 * Generate SPDX 2.3 and CycloneDX 1.7 SBOM artifacts from the dependency inventory.
 * Reuses `collectInventory()` from `gen-third-party-notices.ts` — so tier policy,
 * license overrides, and vendor-disclosure rules are shared with THIRD_PARTY_NOTICES.md.
 *
 * Usage:
 *   pnpm run gen-sbom                     # writes sbom.spdx.json + sbom.cdx.json
 *   pnpm run gen-sbom --format spdx      # writes sbom.spdx.json only
 *   pnpm run gen-sbom --format cyclonedx # writes sbom.cdx.json only
 *   pnpm run verify-spdx                 # bytes-lock check on sbom.spdx.json
 *   pnpm run verify-cyclonedx            # bytes-lock check on sbom.cdx.json
 *   pnpm run verify-sbom                 # both checks
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from './gen-third-party-notices.ts'
import { renderCycloneDX, renderSpdx } from './render-sbom.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SPDX_OUT = 'sbom.spdx.json'
const CDX_OUT = 'sbom.cdx.json'

type Format = 'spdx' | 'cyclonedx'

/** Parse CLI arguments into the requested formats and mode. */
function parseArgs(argv: string[]): { formats: Format[]; checkOnly: boolean } {
  const formats: Format[] = []
  let checkOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--check') {
      checkOnly = true
      continue
    }
    if (arg === '--format' && i + 1 < argv.length) {
      const value = argv[++i]
      if (value === 'spdx' || value === 'cyclonedx') {
        formats.push(value)
      } else {
        throw new Error(`gen-sbom: unsupported --format ${value}; expected spdx or cyclonedx.`)
      }
      continue
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length)
      if (value === 'spdx' || value === 'cyclonedx') {
        formats.push(value)
      } else {
        throw new Error(`gen-sbom: unsupported --format=${value}; expected spdx or cyclonedx.`)
      }
      continue
    }
    if (arg === '--spdx') formats.push('spdx')
    else if (arg === '--cyclonedx') formats.push('cyclonedx')
  }
  if (formats.length === 0) formats.push('spdx', 'cyclonedx')
  return { formats: [...new Set(formats)], checkOnly }
}

/** SPDX timestamp field (creationInfo.created). */
const SPDX_TS = ['creationInfo', 'created'] as const
/** CycloneDX timestamp field (metadata.timestamp). */
const CDX_TS = ['metadata', 'timestamp'] as const

/**
 * Reconstruct a committed timestamp from a committed SBOM file, so a
 * `--check` run can regenerate with the exact same inventory metadata and
 * compare byte-for-byte. Returns undefined when the file is missing or
 * malformed.
 */
function readCommittedTimestamp(format: Format): string | undefined {
  const outPath = resolve(ROOT, format === 'spdx' ? SPDX_OUT : CDX_OUT)
  let text: string | null = null
  try {
    text = readFileSync(outPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const doc = JSON.parse(text) as Record<string, unknown>
    const path = format === 'spdx' ? SPDX_TS : CDX_TS
    let cursor: unknown = doc
    for (const key of path) {
      if (typeof cursor !== 'object' || cursor === null) return undefined
      cursor = (cursor as Record<string, unknown>)[key]
    }
    return typeof cursor === 'string' ? cursor : undefined
  } catch {
    return undefined
  }
}
function writeOrCheck(
  format: Format,
  rendered: string,
  checkOnly: boolean,
): 'up-to-date' | 'wrote' | 'stale' {
  const outPath = resolve(ROOT, format === 'spdx' ? SPDX_OUT : CDX_OUT)
  const label = format === 'spdx' ? SPDX_OUT : CDX_OUT
  if (checkOnly) {
    let committed: string | null = null
    try {
      committed = readFileSync(outPath, 'utf8')
    } catch {
      committed = null
    }
    if (committed === rendered) return 'up-to-date'
    console.error(`gen-sbom: ${label} is stale. Run \`pnpm run gen-sbom\` and commit ${label}.`)
    return 'stale'
  }
  writeFileSync(outPath, rendered)
  return 'wrote'
}

async function main(): Promise<void> {
  const { formats, checkOnly } = parseArgs(process.argv.slice(2))
  // In --check mode, each format may carry a different committed timestamp —
  // e.g. SPDX could be 2026-11-01 and CycloneDX 2026-11-02 if one was regenerated
  // later. We collect per-format and, when they differ, pick the first for
  // collectInventory() but the renderer writes whatever inventory.generatedAt says.
  const perFormatTs = new Map<Format, string | undefined>()
  if (checkOnly) {
    for (const format of formats) perFormatTs.set(format, readCommittedTimestamp(format))
  }
  const firstFormat = formats[0]
  const tsCandidate = checkOnly && firstFormat !== undefined ? perFormatTs.get(firstFormat) : undefined
  const inventory = await collectInventory(tsCandidate)

  let anyStale = false
  for (const format of formats) {
    const formatTs = checkOnly ? perFormatTs.get(format) : undefined
    // Each format renderer uses inventory.generatedAt; if we have a specific
    // format timestamp, we must render with that timestamp.
    const renderInventory = formatTs && formatTs !== inventory.generatedAt
      ? { ...inventory, generatedAt: formatTs }
      : inventory
    const rendered = format === 'spdx'
      ? JSON.stringify(renderSpdx(renderInventory), null, 2) + '\n'
      : JSON.stringify(renderCycloneDX(renderInventory), null, 2) + '\n'
    const result = writeOrCheck(format, rendered, checkOnly)
    const label = format === 'spdx' ? SPDX_OUT : CDX_OUT
    if (result === 'up-to-date') {
      console.log(`gen-sbom: ${label} is up to date.`)
    } else if (result === 'wrote') {
      console.log(`gen-sbom: wrote ${label}.`)
    } else {
      anyStale = true
    }
  }

  if (anyStale) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
