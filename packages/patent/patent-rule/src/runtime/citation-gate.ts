/**
 * 交付物引用门禁：交付入参里的每一处已识别引用都要能按随包索引核验。
 *
 * 交付前置门禁只证明本会话跑过 `law_verify`。本模块在渲染前再读制品文本本身，
 * 用与 `law_verify` 相同的解析器和索引判定。条号超出范围、索引没有这部法、
 * 条文未转录，或款、项不存在，都拒绝这次调用。
 * @module @deepseek-ai/dsh-patent-rule/runtime/citation-gate
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  extractLegalLawReferences,
  legalLawBaselineDir,
  parseLegalLawBaseline,
  verifyLegalCitation,
  type LegalLawBaseline,
  type LegalLawName,
} from '@deepseek-ai/dsh-legal-law'
import { extractLawReferences, loadLawBaselines, verifyCitation } from '@deepseek-ai/dsh-patent-law'
import type { LawBaseline, LawName } from '@deepseek-ai/dsh-patent-law'

import { declaredArgsMatch, type DeclaredArgValue } from './args-match.ts'
import { gateUnresolvedIssues, structuralGateText } from './structural-gate.ts'

/** 一条交付物引用门禁：哪个工具的哪些入参是制品文本。 */
export type CitationGateEntry = {
  /** 被门禁的交付工具名。 */
  tool: string
  /** 承载制品文本的入参名。 */
  textArgs: string[]
  /** 精确匹配才生效的入参；缺省表示该工具的每次调用都核验。 */
  whenArgs?: Record<string, DeclaredArgValue>
}

const BLOCKING = new Set(['not-indexed', 'unverified', 'out-of-range', 'mismatch'])

let patentBaselines: Map<LawName, LawBaseline> | undefined
let civilBaselines: Map<LegalLawName, LegalLawBaseline> | undefined

function patentIndex(): Map<LawName, LawBaseline> {
  patentBaselines ??= loadLawBaselines()
  return patentBaselines
}

/**
 * The civil statutes the patent rules cite most, parsed without the rest of
 * the legal-law corpus. Every name in `INITIAL_LAW_NAMES` must be covered:
 * the extractor recognizes those names unconditionally, so a statute missing
 * here would turn a valid citation into a blocking `not-indexed` finding.
 */
const CIVIL_LAW_INDEX_FILES = [
  'civil-code.yaml',
  'civil-procedure-law.yaml',
  'labor-contract-law.yaml',
  'company-law.yaml',
]

/**
 * Baselines for the statutes the patent rules cite.
 * @returns baselines keyed by law name.
 */
function civilIndex(): Map<LegalLawName, LegalLawBaseline> {
  if (civilBaselines !== undefined) return civilBaselines
  civilBaselines = new Map()
  const dir = legalLawBaselineDir()
  for (const file of CIVIL_LAW_INDEX_FILES) {
    const path = join(dir, file)
    const baseline = parseLegalLawBaseline(readFileSync(path, 'utf8'), path)
    civilBaselines.set(baseline.law, baseline)
  }
  return civilBaselines
}

/**
 * Citations in `text` that the shipped indexes do not accept.
 * @param text - deliverable text.
 * @returns one reason per blocking citation, in order of appearance.
 */
export function blockingCitationDecisions(text: string): string[] {
  if (text.trim() === '') return []
  const reasons: string[] = []
  const patent = patentIndex()
  for (const reference of extractLawReferences(text)) {
    const finding = verifyCitation(reference, patent)
    if (BLOCKING.has(finding.decision)) reasons.push(`${reference.raw}：${finding.reason}`)
  }
  const civil = civilIndex()
  for (const reference of extractLegalLawReferences(text)) {
    // 本索引只随包了常引的几部法；其余法名（刑法、著作权法…）不在这里核验，
    // 不能把「没索引」报成核验失败——那会拒掉合法交付并劝模型删掉正确引用。
    if (!civil.has(reference.law)) continue
    const finding = verifyLegalCitation(reference, civil)
    if (BLOCKING.has(finding.decision)) reasons.push(`${reference.raw}：${finding.reason}`)
  }
  return reasons
}

/**
 * Blocking citations in the deliverable arguments a declaration covers.
 * @param entries - the deployment's citation gate.
 * @param tool - the tool about to run.
 * @param args - its arguments.
 * @returns the blocking reasons. Empty when no declaration applies or every citation passes.
 */
export function citationGateBlocking(
  entries: readonly CitationGateEntry[],
  tool: string,
  args: unknown,
): string[] {
  const reasons: string[] = []
  for (const entry of entries) {
    if (entry.tool !== tool || !declaredArgsMatch(entry.whenArgs, args)) continue
    reasons.push(...blockingCitationDecisions(structuralGateText(args, entry.textArgs)))
  }
  return reasons
}

/**
 * 本次调用无法执行引用门禁的原因（适用条目的制品入参缺失或名字不存在）。
 * @param entries - the deployment's citation gate.
 * @param tool - the tool about to run.
 * @param args - its arguments.
 * @param parameters - 工具入参声明；调用方能取到时传入。
 * @returns 去重后的原因；可执行时为空数组。
 */
export function citationGateUnresolved(
  entries: readonly CitationGateEntry[],
  tool: string,
  args: unknown,
  parameters?: Record<string, unknown>,
): string[] {
  return gateUnresolvedIssues(entries, tool, args, parameters)
}

/**
 * The denial a caller shows when the deliverable's citations do not pass.
 * @param tool - the tool that was denied.
 * @param reasons - the blocking citation reasons.
 * @returns the denial text.
 */
export function renderCitationGateDenial(tool: string, reasons: readonly string[]): string {
  const listed = reasons.slice(0, 8).join('\n')
  const more = reasons.length > 8 ? `\n另有 ${String(reasons.length - 8)} 处。` : ''
  return `交付物引用门禁拒绝 ${tool}：制品中的引用未能按随包索引核验。\n${listed}${more}\n请改成现行索引里的条、款或项，或删去无法核验的引用后再调用。`
}
