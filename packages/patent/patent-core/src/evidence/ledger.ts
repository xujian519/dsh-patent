/**
 * Workflow evidence ledger: one receipt-shaped record per evidence source a
 * workflow run consumed, so the documents behind a run's citations can be
 * rebuilt from the persisted run result and the session log alone.
 *
 * Sources are the caller's material and claims, the prior-art hits (kept,
 * excluded, or undated), the evidence entries, and the conflicting-application
 * candidates. `citationId` is the stable lookup key: prior-art receipts carry
 * the same `D<n>` label `citation-check` uses, so a citation can be matched to
 * the document that grounds it. The ledger records which source supplied each
 * citation; it does not judge whether a cited document is prior art.
 */

import type { PipelineState } from '../atoms/handler.ts'
import { extractCitationIds } from '../citation-ids.ts'
import { isJsonRecord as isRecord } from '../llm-json.ts'
import { contentHash, type Receipt } from './receipt.ts'

/** Maximum snippet length carried by one ledger receipt. */
export const EVIDENCE_SNIPPET_LIMIT = 500

/** Evidence source categories one workflow run can record. */
export type WorkflowEvidenceSource =
  | 'material'
  | 'claims'
  | 'prior-art'
  | 'prior-art-excluded'
  | 'prior-art-undated'
  | 'evidence'
  | 'conflicting-application'
  | 'conflicting-application-excluded'
  | 'conflicting-application-unknown'

/**
 * Every evidence source category. The table keeps the persisted-record check in
 * step with the union: adding a member without listing it here fails to compile.
 */
export const WORKFLOW_EVIDENCE_SOURCES = {
  material: true,
  claims: true,
  'prior-art': true,
  'prior-art-excluded': true,
  'prior-art-undated': true,
  evidence: true,
  'conflicting-application': true,
  'conflicting-application-excluded': true,
  'conflicting-application-unknown': true,
} as const satisfies Record<WorkflowEvidenceSource, true>

/**
 * Test whether a value is a declared evidence source category.
 * @param value - Value to check.
 * @returns True when the value is a {@link WorkflowEvidenceSource}.
 */
export function isWorkflowEvidenceSource(value: unknown): value is WorkflowEvidenceSource {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_EVIDENCE_SOURCES, value)
}

/**
 * One evidence receipt: the stable fields of a tool-call receipt plus the
 * domain metadata a citation check needs. `startedAt` is omitted because a
 * workflow run has one start time, carried by the session event, and a
 * per-source timestamp would make replayed fixtures differ on every run.
 */
export type WorkflowEvidenceReceipt = Omit<Receipt, 'args' | 'startedAt'> & {
  /** JSON-safe source metadata: citation id, title, URI, dates, reason. */
  args: Record<string, string>
  /** Stable lookup key (`MATERIAL`, `CLAIMS`, `D1`, `EV-1`, `CA-1`, …). */
  citationId: string
  /** Which run input or stage output the record came from. */
  source: WorkflowEvidenceSource
  /** Document title or identifier, when one was supplied. */
  title?: string
  /** Publication date as recorded by the source. */
  publicationDate?: string
  /** SHA-256 content hash (`sha256:<hex>`) over the record's identifying text, when it carries any. */
  contentHash?: string
}

/** Evidence records one workflow run consumed, plus a digest over their content. */
export type WorkflowEvidenceLedger = {
  /** Receipts in stable source order (material, claims, prior art, evidence, conflicts). */
  receipts: WorkflowEvidenceReceipt[]
  /** SHA-256 hash (`sha256:` prefix) over the citation ids, sources, and per-record content hashes; independent of run metadata. */
  digest: string
  /**
   * `incomplete: true` when a source array existed but some entries were not
   * objects and could not be recorded. Absent otherwise.
   */
  incomplete?: boolean
}

/** Options for {@link buildWorkflowEvidenceLedger}. */
export type BuildWorkflowEvidenceLedgerOptions = {
  /** Manifest whose run is being recorded. */
  manifestId: string
  /** Run identity; defaults to the manifest id. */
  runId?: string
}

/** One record before it becomes a receipt. */
type EvidenceEntry = {
  citationId: string
  source: WorkflowEvidenceSource
  title?: string
  sourceUri?: string
  publicationDate?: string
  snippet?: string
  reason?: string
  a24Exception?: string
}

const TITLE_KEYS = ['title', 'patent', 'name', 'applicationNumber', 'publicationNumber'] as const
const SOURCE_URI_KEYS = ['url', 'sourceUri', 'sourceURI', 'link'] as const
const PUBLICATION_KEYS = ['publicationDate', 'publication_date', 'publishedAt'] as const
const SNIPPET_KEYS = ['snippet', 'abstract', 'text', 'description'] as const
const A24_EXCEPTION_KEYS = ['a24Exception', 'a24_exception'] as const

/** Read the first non-empty string field among `keys`. */
function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Bound one snippet so a ledger receipt never carries a whole document. */
function bounded(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > EVIDENCE_SNIPPET_LIMIT ? trimmed.slice(0, EVIDENCE_SNIPPET_LIMIT) : trimmed
}

/** Build the domain fields shared by every document-shaped entry. */
function documentFields(
  record: Record<string, unknown>,
  snippetKeys: readonly string[],
): Pick<EvidenceEntry, 'title' | 'sourceUri' | 'publicationDate' | 'snippet'> {
  const title = readString(record, TITLE_KEYS)
  const sourceUri = readString(record, SOURCE_URI_KEYS)
  const publicationDate = readString(record, PUBLICATION_KEYS)
  const snippet = bounded(readString(record, snippetKeys) ?? title)
  return {
    ...(title !== undefined ? { title } : {}),
    ...(sourceUri !== undefined ? { sourceUri } : {}),
    ...(publicationDate !== undefined ? { publicationDate } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  }
}

/**
 * One record's citation id: an explicit `D<n>` label first, then a `D<n>` found
 * in its title/url/patent, then the position. The text fallback uses the same
 * extraction as `citation-check`, so a conclusion's `D<n>` resolves to this
 * receipt rather than to a differently numbered position.
 */
function citationLabel(record: Record<string, unknown>, index: number): string {
  const label = record['dLabel'] ?? record['label']
  if (typeof label === 'string' && /^D\d+$/.test(label.trim())) return label.trim()
  const parts = [record['title'], record['url'], record['patent']]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const fromText = extractCitationIds(parts).find(id => /^D\d+$/.test(id))
  return fromText ?? `D${index + 1}`
}

/** Per-array shape of one evidence source. */
type ArraySource = {
  source: WorkflowEvidenceSource
  /** Snippet fields to try, in order. */
  snippetKeys: readonly string[]
  /** Build the citation id for one record. */
  cite: (record: Record<string, unknown>, index: number) => string
  /** Record the exclusion/pending reason when present. */
  withReason?: true
  /** Record an A24 first-disclosure marker when present. */
  withA24Exception?: true
}

/** Record one evidence array; a non-object entry marks the source incomplete. */
function arrayEntries(value: unknown, opts: ArraySource): { entries: EvidenceEntry[]; incomplete: boolean } {
  if (!Array.isArray(value)) return { entries: [], incomplete: false }
  let incomplete = false
  const entries: EvidenceEntry[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      incomplete = true
      continue
    }
    const reason = opts.withReason === true ? readString(item, ['reason']) : undefined
    const a24Exception = opts.withA24Exception === true ? readString(item, A24_EXCEPTION_KEYS) : undefined
    entries.push({
      citationId: opts.cite(item, index),
      source: opts.source,
      ...documentFields(item, opts.snippetKeys),
      ...(reason !== undefined ? { reason } : {}),
      ...(a24Exception !== undefined ? { a24Exception } : {}),
    })
  }
  return { entries, incomplete }
}

/** Citation id for one prior-art document: its own `D<n>` label, else its position. */
function priorArtEntries(value: unknown, source: WorkflowEvidenceSource): { entries: EvidenceEntry[]; incomplete: boolean } {
  return arrayEntries(value, {
    source,
    snippetKeys: ['snippet', 'abstract', 'text'],
    cite: citationLabel,
    withReason: true,
    withA24Exception: true,
  })
}

/**
 * Citation ids the ledger assigns to one prior-art array, in receipt order.
 *
 * `citation-check` grounds a conclusion's `D<n>` labels against these ids, so a
 * cited label resolves to the prior-art receipt the run persists. The ids come
 * from the same labeling function the ledger uses, which keeps the check and
 * the stored receipts from drifting apart.
 * @param value - the `prior_art` state array (kept documents).
 * @returns citation ids (`D1`, `D2`, …) for object entries; non-objects are skipped.
 */
export function priorArtReceiptCitationIds(value: unknown): string[] {
  return priorArtEntries(value, 'prior-art').entries.map(entry => entry.citationId)
}

/** Record the caller-supplied evidence entries. */
function evidenceEntries(value: unknown): { entries: EvidenceEntry[]; incomplete: boolean } {
  return arrayEntries(value, {
    source: 'evidence',
    snippetKeys: SNIPPET_KEYS,
    cite: (_record, index) => `EV-${index + 1}`,
  })
}

/** Record conflicting-application candidates, confirmed applications, or leftovers. */
function conflictingEntries(value: unknown, source: WorkflowEvidenceSource): { entries: EvidenceEntry[]; incomplete: boolean } {
  return arrayEntries(value, {
    source,
    snippetKeys: ['title', 'snippet'],
    cite: (_record, index) => `CA-${index + 1}`,
    withReason: true,
  })
}

/** Collect the material and claims blocks the run was given. */
function materialEntries(state: PipelineState): EvidenceEntry[] {
  const entries: EvidenceEntry[] = []
  const material = typeof state['input'] === 'string' ? bounded(state['input']) : undefined
  if (material !== undefined) {
    entries.push({ citationId: 'MATERIAL', source: 'material', title: '初始材料', snippet: material })
  }
  const claims = typeof state['claims'] === 'string' ? bounded(state['claims']) : undefined
  if (claims !== undefined) {
    entries.push({ citationId: 'CLAIMS', source: 'claims', title: '权利要求书', snippet: claims })
  }
  return entries
}

/**
 * Content hash over the fields that identify one record, independent of run metadata.
 *
 * Uses a fixed-position JSON array (undefined serializes to null) so field identity is preserved:
 * `{title:'x', snippet:'s'}` and `{sourceUri:'x', snippet:'s'}` must not collide.
 */
function digestOf(entry: EvidenceEntry): string {
  const fields = [
    entry.title,
    entry.sourceUri,
    entry.publicationDate,
    entry.snippet,
    entry.reason,
    entry.a24Exception,
  ]
  // 无任何识别文本时不产生哈希，保持「空来源无 contentHash」语义
  if (fields.every(part => part === undefined || part === '')) return ''
  return contentHash(JSON.stringify(fields))
}

/** Turn one record into the receipt shape the run result and session event carry. */
function toReceipt(entry: EvidenceEntry, runKey: string): WorkflowEvidenceReceipt {
  const contentDigest = digestOf(entry)
  return {
    toolCallId: `${runKey}:${entry.citationId}`,
    turnId: runKey,
    toolName: 'patent_workflow_run',
    args: {
      source: entry.source,
      citationId: entry.citationId,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.sourceUri !== undefined ? { sourceUri: entry.sourceUri } : {}),
      ...(entry.publicationDate !== undefined ? { publicationDate: entry.publicationDate } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.a24Exception !== undefined ? { a24Exception: entry.a24Exception } : {}),
    },
    success: true,
    write: false,
    ...(entry.snippet !== undefined ? { resultText: entry.snippet } : {}),
    citationId: entry.citationId,
    source: entry.source,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.publicationDate !== undefined ? { publicationDate: entry.publicationDate } : {}),
    ...(contentDigest !== '' ? { contentHash: contentDigest } : {}),
  }
}

/**
 * Build the evidence ledger for one finished workflow run.
 *
 * The final pipeline state is the source of truth: stages that filter prior art
 * overwrite `prior_art` and record exclusions beside it, so the ledger reflects
 * what the run actually used rather than what the caller passed in.
 * @param state - final shared pipeline state of the run.
 * @param options - manifest id, run id, and receipt timestamp.
 * @returns the receipts and a content digest over them.
 */
export function buildWorkflowEvidenceLedger(
  state: PipelineState,
  options: BuildWorkflowEvidenceLedgerOptions,
): WorkflowEvidenceLedger {
  const priorArt = priorArtEntries(state['prior_art'], 'prior-art')
  const priorArtExcluded = priorArtEntries(state['prior_art_excluded'], 'prior-art-excluded')
  const priorArtUndated = priorArtEntries(state['prior_art_undated'], 'prior-art-undated')
  const evidence = evidenceEntries(state['evidence'])
  const conflicts = conflictingEntries(state['conflicting_applications'], 'conflicting-application')
  const conflictsExcluded = conflictingEntries(
    state['conflicting_application_excluded'],
    'conflicting-application-excluded',
  )
  const conflictsUnknown = conflictingEntries(
    state['conflicting_application_unknown'],
    'conflicting-application-unknown',
  )
  // `prior-art-filter` keeps undated documents in `prior_art` and also lists
  // them in `prior_art_undated`; the same document must not produce two receipts
  // under one D label.
  const priorArtCitationIds = new Set(priorArt.entries.map(entry => entry.citationId))
  const entries: EvidenceEntry[] = [
    ...materialEntries(state),
    ...priorArt.entries,
    ...priorArtExcluded.entries,
    ...priorArtUndated.entries.filter(entry => !priorArtCitationIds.has(entry.citationId)),
    ...evidence.entries,
    ...conflicts.entries,
    ...conflictsExcluded.entries,
    ...conflictsUnknown.entries,
  ]
  const runKey = options.runId ?? options.manifestId
  const receipts = entries.map(entry => toReceipt(entry, runKey))
  const digest = contentHash(JSON.stringify(receipts.map(receipt => [receipt.citationId, receipt.source, receipt.contentHash ?? ''])))
  const incomplete = [
    priorArt.incomplete,
    priorArtExcluded.incomplete,
    priorArtUndated.incomplete,
    evidence.incomplete,
    conflicts.incomplete,
    conflictsExcluded.incomplete,
    conflictsUnknown.incomplete,
  ].some(Boolean)
  return {
    receipts,
    digest,
    ...(incomplete ? { incomplete: true } : {}),
  }
}
