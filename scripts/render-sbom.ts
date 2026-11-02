/**
 * SPDX 2.3 and CycloneDX 1.7 SBOM renderers. Both consume the unified
 * Inventory emitted by `gen-third-party-notices.ts`, so tier policy,
 * license overrides, and vendor-disclosure rules are shared with the
 * markdown notices.
 *
 * The generators do NOT re-validate licenses: they trust that
 * `collectInventory()` has already run `assertRuntimeLicenses`.
 */

import type { Inventory, InventoryEntry } from './gen-third-party-notices.ts'

/** Replace characters that are illegal in SPDX/CycloneDX identifiers with `-`. */
function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9.\-_]/g, '-')
}

/** Normalize a URL to a downloadLocation; undefined → "NOASSERTION". */
function safeRepo(url?: string): string {
  return url && url.length > 0 ? url : 'NOASSERTION'
}

/** CycloneDX Component.type mapped from an inventory tier. */
function cycloneComponentType(entry: InventoryEntry): string {
  switch (entry.tier) {
    case 'first-party-native': return 'library'
    case 'runtime-npm':
    case 'dev-npm':
    case 'bundled-python':
    case 'direct-python':
    case 'vendored':
    case 'claude-platform':
      return 'library'
    default: return 'library'
  }
}

/** Build a Package URL for one inventory entry. `undefined` when we cannot form one. */
function purlFor(entry: InventoryEntry): string | undefined {
  const v = entry.version
  switch (entry.source) {
    case 'npm': {
      // pkg:npm/%40deepseek-ai/dsh-agent@1.2.3  (slash becomes %2F, or we keep slash in purl)
      const encodedName = entry.name.startsWith('@')
        ? `@${encodeURIComponent(entry.name.slice(1)).replace('%40', '%40')}`
        : entry.name
      return `pkg:npm/${encodedName}${v ? `@${v}` : ''}`
    }
    case 'python': {
      const normalized = entry.name.toLowerCase().replace(/[-_.]+/g, '-')
      return `pkg:pypi/${normalized}${v ? `@${v}` : ''}`
    }
    case 'vendor': {
      const encodedName = entry.name.startsWith('@')
        ? `@${entry.name.slice(1).replace('/', '/')}`
        : entry.name
      return `pkg:npm/${encodedName}${v ? `@${v}` : ''}?repository_url=${encodeURIComponent(entry.repo ?? '')}`
    }
    default:
      return undefined
  }
}

/** Official repository URL used as a stable fallback for the root package identity
 *  and for documentNamespace when the root manifest does not declare a repository. */
const REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * Map an SPDX identifier to a license type field, or return undefined if the
 * expression is not an SPDX id (e.g. "SEE LICENSE IN LICENSE.md", or free-form text).
 */
function mapLicenseId(license: string): string | undefined {
  const trimmed = license.trim()
  if (trimmed.length === 0) return undefined
  // Anything with AND/OR/with/exception or a slash — it is an expression, not a single id.
  if (/\b(AND|OR|WITH)\b|\/|–—/.test(trimmed)) return undefined
  if (/^SEE /i.test(trimmed)) return undefined
  return trimmed
}

// --------------------------------------------------------------------------
// SPDX 2.3
// --------------------------------------------------------------------------

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3'
  dataLicense: 'CC0-1.0'
  SPDXID: 'SPDXRef-DOCUMENT'
  name: string
  documentNamespace: string
  creationInfo: {
    created: string
    creators: string[]
    documentComment?: string
  }
  packages: SpdxPackage[]
  relationships: SpdxRelationship[]
}

interface SpdxPackage {
  SPDXID: string
  name: string
  versionInfo?: string
  downloadLocation: string
  licenseConcluded: string
  licenseDeclared: string
  /** Observed license id (from shipped LICENSE file), or NOASSERTION if unavailable. */
  licenseObserved: string
  copyrightText: string
  externalRefs?: { referenceCategory: 'PACKAGE-MANAGER' | 'SECURITY'; referenceType: string; referenceLocator: string }[]
  annotations?: SpdxAnnotation[]
}

interface SpdxAnnotation {
  annotationType: 'OTHER'
  annotationComment: string
  annotationDate: string
  annotator: 'Tool: DeepSeek Harness SBOM Generator'
}

interface SpdxRelationship {
  spdxElementId: string
  relationshipType: 'DESCRIBES' | 'DEPENDS_ON' | 'CONTAINS' | 'DESCENDANT_OF' | 'PRIMARY_PACKAGE'
  relatedSpdxElement: string
}

/**
 * Render the inventory as an SPDX 2.3 JSON document.
 * @param inventory - unified dependency inventory from collectInventory().
 */
export function renderSpdx(inventory: Inventory): SpdxDocument {
  const root = inventory.root
  const documentId = `${sanitizeId(root.name)}-${sanitizeId(root.version)}`
  const name = `${root.name}-sbom`
  const rootRepo = root.repo ?? REPO_URL
  const documentNamespace = `${rootRepo}/spdx/${documentId}/${sanitizeId(inventory.generatedAt)}`

  const rootSpdxId = 'SPDXRef-Package-' + sanitizeId(root.name)
  const rootPackage: SpdxPackage = {
    SPDXID: rootSpdxId,
    name: root.name,
    versionInfo: root.version,
    downloadLocation: safeRepo(rootRepo),
    licenseConcluded: root.license,
    licenseDeclared: root.license,
    licenseObserved: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  }

  const packages: SpdxPackage[] = [rootPackage]
  const relationships: SpdxRelationship[] = [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootSpdxId },
    { spdxElementId: rootSpdxId, relationshipType: 'PRIMARY_PACKAGE', relatedSpdxElement: 'SPDXRef-DOCUMENT' },
  ]

  const seen = new Set<string>()
  for (const entry of inventory.entries) {
    if (seen.has(entry.name + '@' + (entry.version ?? ''))) continue
    seen.add(entry.name + '@' + (entry.version ?? ''))
    const spdxId = 'SPDXRef-Package-' + sanitizeId(entry.name) + (entry.version ? '-' + sanitizeId(entry.version) : '')
    const pkg: SpdxPackage = {
      SPDXID: spdxId,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: safeRepo(entry.repo),
      licenseConcluded: entry.license,
      licenseDeclared: entry.declaredLicense ?? 'NOASSERTION',
      licenseObserved: entry.observedLicense ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    }
    const purl = purlFor(entry)
    if (purl) {
      pkg.externalRefs = [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: purl,
      }]
    }
    if (entry.tier !== 'runtime-npm' && entry.tier !== 'bundled-python' && entry.tier !== 'first-party-native') {
      pkg.annotations = [{
        annotationType: 'OTHER',
        annotationComment: `tier=${entry.tier} — not distributed with the primary artifact`,
        annotationDate: inventory.generatedAt,
        annotator: 'Tool: DeepSeek Harness SBOM Generator',
      }]
    }
    packages.push(pkg)
    if (entry.tier === 'runtime-npm' || entry.tier === 'bundled-python' || entry.tier === 'first-party-native'
      || entry.tier === 'claude-platform' || entry.tier === 'vendored') {
      relationships.push({ spdxElementId: rootSpdxId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: spdxId })
    }
  }

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name,
    documentNamespace,
    creationInfo: {
      created: inventory.generatedAt,
      creators: ['Tool: DeepSeek Harness SBOM Generator', `Tool: ${inventory.generator.name}@${inventory.generator.version}`],
      documentComment: 'Automated from scripts/gen-third-party-notices.ts inventory. Tier policy and license overrides live there; do not edit by hand.',
    },
    packages,
    relationships,
  }
}

// --------------------------------------------------------------------------
// CycloneDX 1.7
// --------------------------------------------------------------------------

export interface CycloneDXDocument {
  bomFormat: 'CycloneDX'
  specVersion: '1.7'
  version: 1
  metadata: {
    timestamp: string
    component: CycloneDXComponent
    tools?: { components: CycloneDXComponent[] }
  }
  components: CycloneDXComponent[]
  dependencies?: { ref: string; dependsOn: string[] }[]
}

interface CycloneDXComponent {
  type: string
  name: string
  version?: string
  group?: string
  description?: string
  'bom-ref'?: string
  licenses?: { license: { id?: string; expression?: string } }[]
  purl?: string
  externalReferences?: { type: 'website' | 'distribution' | 'vcs'; url: string }[]
  properties?: { name: string; value: string }[]
}

/**
 * Render the inventory as a CycloneDX 1.7 JSON document.
 * CycloneDX is the format the EU Cyber Resilience Act and many downstream
 * tools (Dependabot, OWASP Dependency-Track, Sonatype) consume natively.
 */
export function renderCycloneDX(inventory: Inventory): CycloneDXDocument {
  const root = inventory.root
  const rootRepo = root.repo ?? REPO_URL
  const rootPurl = purlFor({ name: root.name, version: root.version, license: root.license, tier: 'runtime-npm', source: 'npm' })
  const rootComponent: CycloneDXComponent = {
    type: 'application',
    name: root.name,
    version: root.version,
    description: 'DeepSeek Harness — all-plugin Cordis agent harness',
    licenses: [{ license: { id: root.license } }],
    purl: rootPurl,
    'bom-ref': rootPurl,
    externalReferences: [{ type: 'vcs', url: rootRepo }],
  }

  const components: CycloneDXComponent[] = []
  const rootDependsOn: string[] = []

  const seen = new Set<string>()
  for (const entry of inventory.entries) {
    if (seen.has(entry.name + '@' + (entry.version ?? ''))) continue
    seen.add(entry.name + '@' + (entry.version ?? ''))

    const licenseId = mapLicenseId(entry.license)
    const licenses = licenseId
      ? [{ license: { id: licenseId } }]
      : [{ license: { expression: entry.license } }]

    const comp: CycloneDXComponent = {
      type: cycloneComponentType(entry),
      name: entry.name,
      version: entry.version,
      'bom-ref': purlFor(entry),
      licenses,
      purl: purlFor(entry),
      properties: [
        { name: 'tier', value: entry.tier },
        ...(entry.source ? [{ name: 'source', value: entry.source }] : []),
        ...(entry.patched ? [{ name: 'patched', value: 'true' }] : []),
        ...(entry.repo ? [{ name: 'upstream', value: entry.repo }] : []),
        ...(entry.declaredLicense ? [{ name: 'licenseDeclared', value: entry.declaredLicense }] : []),
        ...(entry.observedLicense ? [{ name: 'licenseObserved', value: entry.observedLicense }] : []),
      ],
    }
    if (entry.repo) {
      comp.externalReferences = [{ type: 'vcs', url: entry.repo }]
    }
    components.push(comp)
    if (entry.tier === 'runtime-npm' || entry.tier === 'bundled-python'
      || entry.tier === 'first-party-native' || entry.tier === 'claude-platform') {
      const entryPurl = purlFor(entry)
      rootDependsOn.push(entryPurl ?? (entry.name + (entry.version ? '@' + entry.version : '')))
    }
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    version: 1,
    metadata: {
      timestamp: inventory.generatedAt,
      component: rootComponent,
      tools: {
        components: [{
          type: 'application',
          name: inventory.generator.name,
          version: inventory.generator.version,
          description: 'DeepSeek Harness SBOM generator — shares inventory with THIRD_PARTY_NOTICES.md',
        }],
      },
    },
    components,
    dependencies: rootDependsOn.length > 0 && rootPurl
      ? [{ ref: rootPurl, dependsOn: rootDependsOn }]
      : [],
  }
}
