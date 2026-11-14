/**
 * 规则引用门禁：每条随包规则要么带可核验的结构化引用，要么用 basisKind 说明为何没有条号。
 *
 * `statute` / `guideline` 的 `legalBasis` 由 patent-law 与 legal-law 的解析器拆开，
 * 逐条对随包索引做不带命题的核验。判定为未索引、未核验、超出范围或款/项不存在即失败。
 * `judgment` / `practice-note` 不得再含已识别的法条引用。`exempt` 必须登记在
 * `citation-exemptions.yaml`。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-rule-citations.ts`
 * `--write` 按正文补上缺失的 basisKind，不改已有声明。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { ConstitutionalRule } from '@deepseek-ai/dsh-patent-core'
import { extractLegalLawReferences } from '@deepseek-ai/dsh-legal-law'
import { extractLawReferences } from '@deepseek-ai/dsh-patent-law'
import { loadRuleSetFromFile } from '@deepseek-ai/dsh-patent-rule'

import { blockingCitationDecisions } from '../packages/patent/patent-rule/src/runtime/citation-gate.ts'

const ROOT = join(import.meta.dirname, '..')
const RULES = join(ROOT, 'packages/patent/patent-rule/assets/rules')
const EXEMPTIONS = join(RULES, 'citation-exemptions.yaml')

type BasisKind = NonNullable<ConstitutionalRule['basisKind']>

type LoadedRule = { file: string; rule: ConstitutionalRule }

/**
 * Walk the rule assets.
 * @param dir - the directory to walk.
 * @returns the yaml files, pack manifests and the exemption register excluded.
 */
function yamlFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...yamlFiles(path))
    else if ((entry.endsWith('.yaml') || entry.endsWith('.yml')) && entry !== 'pack.yaml' && entry !== 'citation-exemptions.yaml') {
      files.push(path)
    }
  }
  return files
}

/**
 * Load every packaged rule once.
 * @returns the rules and the loader warnings.
 */
function loadRules(): { rules: LoadedRule[]; warnings: string[] } {
  const rules: LoadedRule[] = []
  const warnings: string[] = []
  for (const file of yamlFiles(RULES)) {
    const text = readFileSync(file, 'utf8')
    if (!/^rules:/m.test(text) || file.endsWith('/evidence-rules.yaml')) continue
    try {
      const loaded = loadRuleSetFromFile(file)
      for (const warning of loaded.warnings) warnings.push(`${relative(ROOT, file)}: ${warning.message}`)
      for (const rule of loaded.ruleSet.rules) rules.push({ file, rule })
    } catch (error) {
      warnings.push(`${relative(ROOT, file)}: ${(error as Error).message}`)
    }
  }
  for (const entry of evidenceRules()) rules.push(entry)
  return { rules, warnings }
}

/**
 * Evidence rules use their own document, with `ruleId` instead of `id`.
 * @returns one synthetic rule per evidence entry that carries a legalBasis.
 */
function evidenceRules(): LoadedRule[] {
  const file = join(RULES, 'patent/evidence-rules.yaml')
  const lines = readFileSync(file, 'utf8').split('\n')
  const rules: LoadedRule[] = []
  let id: string | undefined
  let basisKind: ConstitutionalRule['basisKind']
  let legalBasis: string | undefined
  const push = (): void => {
    if (id === undefined) return
    rules.push({
      file,
      rule: {
        id,
        name: id,
        severity: 'major',
        action: 'warn',
        ...(legalBasis === undefined ? {} : { legalBasis }),
        ...(basisKind === undefined ? {} : { basisKind }),
        check: { type: 'keyword_blocklist', keywords: [] },
      },
    })
  }
  for (const line of lines) {
    const idMatch = /^\s*-\s*ruleId:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) {
      push()
      id = idMatch[1]
      basisKind = undefined
      legalBasis = undefined
      continue
    }
    const basis = /^\s*legalBasis:\s*(.*)$/.exec(line)
    if (basis !== null) legalBasis = (basis[1] ?? '').trim()
    const kind = /^\s*basisKind:\s*(\S+)\s*$/.exec(line)
    if (kind !== null) basisKind = kind[1] as ConstitutionalRule['basisKind']
  }
  push()
  return rules
}

/**
 * The registered exemption reasons, keyed by rule id.
 * @returns the reasons.
 */
function exemptions(): Map<string, string> {
  const reasons = new Map<string, string>()
  let id: string | undefined
  for (const line of readFileSync(EXEMPTIONS, 'utf8').split('\n')) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line) ?? /^\s*id:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) id = idMatch[1]
    const reason = /^\s*reason:\s*(.+)\s*$/.exec(line)
    if (reason !== null && id !== undefined && reason[1] !== undefined && reason[1].trim() !== '') {
      reasons.set(id, reason[1].trim())
      id = undefined
    }
  }
  return reasons
}

/**
 * The category the legalBasis text supports.
 * @param legalBasis - the rule's basis text.
 * @returns the category.
 */
export function suggestBasisKind(legalBasis: string | undefined): BasisKind {
  const text = legalBasis ?? ''
  const patent = extractLawReferences(text)
  const legal = extractLegalLawReferences(text)
  if (patent.some(reference => reference.kind === 'law-article') || legal.length > 0) return 'statute'
  if (patent.some(reference => reference.kind === 'guideline-section')) return 'guideline'
  if (/最高法|判决|复审决定|判例|案号|沪民终|知民终|知行终/.test(text)) return 'judgment'
  return 'practice-note'
}

/**
 * Verify one rule's citations and category.
 * @param rule - the loaded rule.
 * @param exempt - registered exemption reasons.
 * @returns the failure messages for this rule.
 */
function checkRule(rule: ConstitutionalRule, exempt: Map<string, string>): string[] {
  const failures: string[] = []
  if (rule.basisKind === undefined) {
    failures.push(`${rule.id}: 缺少 basisKind（应为 ${suggestBasisKind(rule.legalBasis)}）`)
    return failures
  }
  if (rule.basisKind === 'exempt') {
    if (!exempt.has(rule.id)) failures.push(`${rule.id}: basisKind 为 exempt，但 citation-exemptions.yaml 没有登记理由`)
    return failures
  }
  const expected = suggestBasisKind(rule.legalBasis)
  if (rule.basisKind !== expected) {
    failures.push(`${rule.id}: basisKind 是 ${rule.basisKind}，依据文本对应 ${expected}`)
  }
  if (rule.basisKind === 'judgment' || rule.basisKind === 'practice-note') return failures
  const text = rule.legalBasis ?? ''
  for (const reason of blockingCitationDecisions(text)) failures.push(`${rule.id}: ${reason}`)
  const cited = extractLawReferences(text).length + extractLegalLawReferences(text).length
  if (cited === 0) failures.push(`${rule.id}: basisKind 为 ${rule.basisKind}，但 legalBasis 没有识别出引用`)
  return failures
}

/**
 * Check every packaged rule.
 * @returns the failure messages. Empty means the gate passes.
 */
export function checkPackagedRuleCitations(): string[] {
  const exempt = exemptions()
  const { rules, warnings } = loadRules()
  const failures = [...warnings]
  const ids = new Set<string>()
  for (const { rule } of rules) {
    ids.add(rule.id)
    failures.push(...checkRule(rule, exempt))
  }
  for (const id of exempt.keys()) {
    if (!ids.has(id)) failures.push(`citation-exemptions.yaml: ${id} 不是随包规则`)
  }
  return failures
}

/**
 * Insert basisKind on the rules in one file that do not declare it.
 * @param text - the file text.
 * @param missing - rule id to the category to write.
 * @param noBasis - rule ids whose category anchors on `action` because they have no legalBasis.
 * @returns the stamped text.
 */
function stampFile(text: string, missing: Map<string, BasisKind>, noBasis: Set<string>): string {
  if (missing.size === 0) return text
  const lines = text.split('\n')
  const output: string[] = []
  let id: string | undefined
  let written = false
  const flush = (): void => {
    if (id === undefined || written || !missing.has(id)) return
    output.push(`    basisKind: ${missing.get(id)}`)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const idMatch = /^(?:\s*)(?:-\s*)?(?:id|ruleId):\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) {
      flush()
      id = idMatch[1]
      written = false
    }
    if (/^\s*basisKind:/.test(line)) written = true
    output.push(line)
    if (id === undefined || written || !missing.has(id)) continue
    const basis = /^(\s*)legalBasis:(\s*)(.*)$/.exec(line)
    const action = noBasis.has(id) ? /^(\s*)action:/.exec(line) : null
    if (basis === null && action === null) continue
    const indent = (basis ?? action)?.[1] ?? '    '
    let end = output.length
    const folded = basis !== null && (basis[3] === '|-' || basis[3] === '|')
    if (folded) {
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? '')) {
        index += 1
        output.push(lines[index] ?? '')
      }
      end = output.length
    }
    output.splice(end, 0, `${indent}basisKind: ${missing.get(id)}`)
    written = true
  }
  flush()
  return output.join('\n')
}

/**
 * Rewrite rule files that are missing basisKind.
 * @returns the files changed.
 */
export function writeMissingBasisKinds(): string[] {
  const changed: string[] = []
  const byFile = new Map<string, { missing: Map<string, BasisKind>; noBasis: Set<string> }>()
  for (const { file, rule } of loadRules().rules) {
    if (rule.basisKind !== undefined) continue
    const bucket = byFile.get(file) ?? { missing: new Map(), noBasis: new Set() }
    bucket.missing.set(rule.id, suggestBasisKind(rule.legalBasis))
    if (rule.legalBasis === undefined) bucket.noBasis.add(rule.id)
    byFile.set(file, bucket)
  }
  for (const [file, bucket] of byFile) {
    const text = readFileSync(file, 'utf8')
    const stamped = stampFile(text, bucket.missing, bucket.noBasis)
    if (stamped === text) continue
    writeFileSync(file, stamped.endsWith('\n') ? stamped : `${stamped}\n`)
    changed.push(relative(ROOT, file))
  }
  return changed
}

function main(): void {
  if (process.argv.includes('--write')) {
    const changed = writeMissingBasisKinds()
    console.log(changed.length === 0 ? 'basisKind 已齐全' : `已写入 basisKind：\n${changed.join('\n')}`)
    return
  }
  const failures = checkPackagedRuleCitations()
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log('verify-patent-rule-citations: 随包规则的引用与类别一致')
}

if (process.argv[1]?.endsWith('verify-patent-rule-citations.ts')) main()
