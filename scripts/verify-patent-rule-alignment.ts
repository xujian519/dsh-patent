/**
 * 规则与程序对齐门禁。
 *
 * 对照 `assets/authority/rule-procedure-alignment.yaml`：每个规则族的条文能被索引支撑，
 * 规则或源码锚点引用该条，用例文件写了对应测试；每项程序计算的引文是该款或该项正文的子串，
 * 代码锚点与用例都在；十三套模板与八个工作流 manifest 的清单与随包集合一致，格式断言绑在清单上。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-rule-alignment.ts`
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { articleCitationFocus } from '@deepseek-ai/dsh-law-core'
import { load as loadYaml } from 'js-yaml'

import { extractLawReferences, loadLawBaselines, verifyCitation } from '@deepseek-ai/dsh-patent-law'
import type { LawArticleReference, LawBaseline, LawName, LawReference, StatuteName } from '@deepseek-ai/dsh-patent-law'
import { loadFeeTable } from '@deepseek-ai/dsh-patent-fees'
import type { FeeItem } from '@deepseek-ai/dsh-patent-fees'
import { loadRuleSetFromFile } from '@deepseek-ai/dsh-patent-rule'

const ROOT = join(import.meta.dirname, '..')

const FAMILY_IDS = [
  'drafting',
  'subject-matter',
  'novelty-inventiveness',
  'unity-division',
  'reexamination-invalidation',
  'design',
  'term-compensation',
  'service-periods',
  'fees',
] as const

/** Statute lines the comparison table must cover. Item 0 means the line is not narrowed to an item. */
const REQUIRED_LINES: ReadonlyArray<readonly [StatuteName, number, number, number]> = [
  ['专利法实施细则', 4, 1, 0],
  ['专利法实施细则', 4, 2, 0],
  ['专利法实施细则', 4, 3, 0],
  ['专利法实施细则', 4, 4, 0],
  ['专利法实施细则', 4, 5, 0],
  ['专利法实施细则', 4, 6, 0],
  ['专利法实施细则', 4, 7, 0],
  ['专利法实施细则', 5, 0, 0],
  ['专利法实施细则', 6, 1, 0],
  ['专利法实施细则', 6, 2, 0],
  ['专利法实施细则', 6, 3, 0],
  ['专利法实施细则', 6, 4, 0],
  ['专利法实施细则', 6, 5, 0],
  ['专利法', 42, 1, 0],
  ['专利法', 42, 3, 0],
  ['专利法实施细则', 77, 0, 0],
  ['专利法实施细则', 81, 0, 0],
  ['专利法实施细则', 110, 1, 1],
  ['专利法实施细则', 110, 1, 2],
  ['专利法实施细则', 110, 1, 3],
  ['专利法实施细则', 110, 1, 4],
  ['专利法实施细则', 110, 1, 5],
]

const STATUTES = new Set<string>(['专利法', '专利法实施细则'])

type Provision = {
  law: StatuteName
  article: number
  paragraph?: number
  item?: number
  proposition?: string
  quote?: string
}

type PackagedRule = { kind: 'packaged'; id: string }
type SourceRule = { kind: 'source'; file: string; anchor: string }
type TestRef = { file: string; title: string }
type Link = { provision: Provision; rule: PackagedRule | SourceRule; test: TestRef }
type Family = { id: string; label: string; links: Link[] }
type Computation = {
  id: string
  gap: boolean
  absent: boolean
  provision: Provision
  code?: { file: string; anchor: string }
  test?: TestRef
  indexIds: string[]
  legalBasisIncludes?: string
}
type FormatTest = { file: string; title: string; binds?: string; idSource?: string }
type TemplateRow = { id: string; provisions: Provision[]; formatTest: FormatTest }
type ManifestRow = { id: string; provisions: Provision[] }
type Correction = {
  id: string
  law: StatuteName
  article: number
  paragraph?: number
  contains: string
  excludes?: string
  sourceAbsent?: { dir: string; text: string }
  test?: TestRef
}
type Inventory = {
  families: Family[]
  computations: Computation[]
  templates: TemplateRow[]
  manifests: ManifestRow[]
  corrections: Correction[]
}

const fileText = new Map<string, string>()

/**
 * Read a repository file, caching the text for the rest of the check.
 * @param root - repository root.
 * @param path - path relative to the root.
 * @returns the file text, or undefined when the file is missing.
 */
function readText(root: string, path: string): string | undefined {
  const absolute = join(root, path)
  const cached = fileText.get(absolute)
  if (cached !== undefined) return cached
  if (!existsSync(absolute)) return undefined
  const text = readFileSync(absolute, 'utf8')
  fileText.set(absolute, text)
  return text
}

/**
 * @param value - a YAML value.
 * @returns whether it is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param value - a YAML value.
 * @returns the string, or undefined.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * @param value - a YAML value.
 * @returns the positive integer, or undefined.
 */
function intOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Read one provision object.
 * @param value - the YAML value.
 * @param where - the path used in errors.
 * @param problems - the error list.
 * @returns the provision, or undefined when a field is missing.
 */
function readProvision(value: unknown, where: string, problems: string[]): Provision | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}：条文必须是映射`)
    return undefined
  }
  const law = textOf(value['law'])
  const article = intOf(value['article'])
  if (law === undefined || !STATUTES.has(law) || article === undefined) {
    problems.push(`${where}：条文必须写明《专利法》或《专利法实施细则》与条号`)
    return undefined
  }
  const paragraph = value['paragraph'] === undefined ? undefined : intOf(value['paragraph'])
  const item = value['item'] === undefined ? undefined : intOf(value['item'])
  if (value['paragraph'] !== undefined && paragraph === undefined) problems.push(`${where}：款号必须是正整数`)
  if (value['item'] !== undefined && item === undefined) problems.push(`${where}：项号必须是正整数`)
  const provision: Provision = { law: law as StatuteName, article }
  if (paragraph !== undefined) provision.paragraph = paragraph
  if (item !== undefined) provision.item = item
  const proposition = textOf(value['proposition'])
  const quote = textOf(value['quote'])
  if (proposition !== undefined) provision.proposition = proposition
  if (quote !== undefined) provision.quote = quote
  return provision
}

/**
 * @param value - the YAML value.
 * @param where - the path used in errors.
 * @param problems - the error list.
 * @returns the test reference.
 */
function readTest(value: unknown, where: string, problems: string[]): TestRef | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}：用例必须是映射`)
    return undefined
  }
  const file = textOf(value['file'])
  const title = textOf(value['title'])
  if (file === undefined || title === undefined) {
    problems.push(`${where}：用例必须写明文件与标题`)
    return undefined
  }
  return { file, title }
}

/**
 * Parse the inventory. Structural problems are returned beside a partial document
 * so a later check can still report the rows that did parse.
 * @param value - the YAML document.
 * @returns the inventory and the structural problems.
 */
export function parseAlignmentInventory(value: unknown): { inventory: Inventory; problems: string[] } {
  const problems: string[] = []
  const empty: Inventory = { families: [], computations: [], templates: [], manifests: [], corrections: [] }
  if (!isRecord(value)) return { inventory: empty, problems: ['对照清单必须是映射'] }
  return { inventory: {
    families: readFamilies(value['families'], problems),
    computations: readComputations(value['computations'], problems),
    templates: readTemplates(value['templates'], problems),
    manifests: readManifests(value['manifests'], problems),
    corrections: readCorrections(value['corrections'], problems),
  }, problems }
}

/**
 * @param value - the families array.
 * @param problems - the error list.
 * @returns the families that parsed.
 */
function readFamilies(value: unknown, problems: string[]): Family[] {
  if (!Array.isArray(value)) {
    problems.push('families 必须是数组')
    return []
  }
  const families: Family[] = []
  for (const entry of value) {
    if (!isRecord(entry) || textOf(entry['id']) === undefined || textOf(entry['label']) === undefined || !Array.isArray(entry['links'])) {
      problems.push('规则族必须有 id、label 与 links')
      continue
    }
    const links: Link[] = []
    for (const link of entry['links']) {
      if (!isRecord(link)) {
        problems.push(`${String(entry['id'])}：链接必须是映射`)
        continue
      }
      const provision = readProvision(link['provision'], String(entry['id']), problems)
      const test = readTest(link['test'], String(entry['id']), problems)
      const rule = readRule(link['rule'], String(entry['id']), problems)
      if (provision?.proposition === undefined) problems.push(`${String(entry['id'])}：规则族链接必须写命题`)
      if (provision?.proposition !== undefined && rule !== undefined && test !== undefined) {
        links.push({ provision, rule, test })
      }
    }
    families.push({ id: String(entry['id']), label: String(entry['label']), links })
  }
  return families
}

/**
 * @param value - the rule reference.
 * @param where - the path used in errors.
 * @param problems - the error list.
 * @returns the rule reference.
 */
function readRule(value: unknown, where: string, problems: string[]): PackagedRule | SourceRule | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}：规则必须是映射`)
    return undefined
  }
  if (value['kind'] === 'packaged') {
    const id = textOf(value['id'])
    if (id === undefined) {
      problems.push(`${where}：随包规则必须写 id`)
      return undefined
    }
    return { kind: 'packaged', id }
  }
  if (value['kind'] === 'source') {
    const file = textOf(value['file'])
    const anchor = textOf(value['anchor'])
    if (file === undefined || anchor === undefined) {
      problems.push(`${where}：源码规则必须写文件与锚点`)
      return undefined
    }
    return { kind: 'source', file, anchor }
  }
  problems.push(`${where}：规则种类必须是 packaged 或 source`)
  return undefined
}

/**
 * @param value - the computations array.
 * @param problems - the error list.
 * @returns the computations that parsed.
 */
function readComputations(value: unknown, problems: string[]): Computation[] {
  if (!Array.isArray(value)) {
    problems.push('computations 必须是数组')
    return []
  }
  const computations: Computation[] = []
  for (const entry of value) {
    if (!isRecord(entry) || textOf(entry['id']) === undefined) {
      problems.push('程序计算必须有 id')
      continue
    }
    const id = String(entry['id'])
    const provision = readProvision(entry['provision'], id, problems)
    if (provision?.quote === undefined) problems.push(`${id}：程序计算必须摘录条文原句`)
    const indexIds = Array.isArray(entry['indexIds'])
      ? entry['indexIds'].filter((item): item is string => typeof item === 'string' && item !== '')
      : []
    if (Array.isArray(entry['indexIds']) && indexIds.length !== entry['indexIds'].length) {
      problems.push(`${id}：费用 id 必须是非空字符串`)
    }
    let code: Computation['code']
    if (entry['code'] !== undefined) {
      if (!isRecord(entry['code']) || textOf(entry['code']['file']) === undefined || textOf(entry['code']['anchor']) === undefined) {
        problems.push(`${id}：代码锚点必须写明文件与文本`)
      } else {
        code = { file: String(entry['code']['file']), anchor: String(entry['code']['anchor']) }
      }
    }
    const test = entry['test'] === undefined ? undefined : readTest(entry['test'], id, problems)
    if (provision !== undefined) {
      computations.push({
        id,
        gap: entry['gap'] === true,
        absent: entry['absent'] === true,
        provision,
        ...(code !== undefined ? { code } : {}),
        ...(test !== undefined ? { test } : {}),
        indexIds,
        ...(textOf(entry['legalBasisIncludes']) !== undefined ? { legalBasisIncludes: String(entry['legalBasisIncludes']) } : {}),
      })
    }
  }
  return computations
}

/**
 * @param value - the templates array.
 * @param problems - the error list.
 * @returns the template rows that parsed.
 */
function readTemplates(value: unknown, problems: string[]): TemplateRow[] {
  if (!Array.isArray(value)) {
    problems.push('templates 必须是数组')
    return []
  }
  const templates: TemplateRow[] = []
  for (const entry of value) {
    if (!isRecord(entry) || textOf(entry['id']) === undefined || !Array.isArray(entry['provisions']) || !isRecord(entry['formatTest'])) {
      problems.push('模板行必须有 id、provisions 与 formatTest')
      continue
    }
    const id = String(entry['id'])
    const provisions = entry['provisions']
      .map(item => readProvision(item, id, problems))
      .filter((item): item is Provision => item?.proposition !== undefined)
    const format = entry['formatTest']
    const file = textOf(format['file'])
    const title = textOf(format['title'])
    if (file === undefined || title === undefined) {
      problems.push(`${id}：格式断言必须写明文件与标题`)
      continue
    }
    templates.push({
      id,
      provisions,
      formatTest: {
        file,
        title,
        ...(textOf(format['binds']) !== undefined ? { binds: String(format['binds']) } : {}),
        ...(textOf(format['idSource']) !== undefined ? { idSource: String(format['idSource']) } : {}),
      },
    })
  }
  return templates
}

/**
 * @param value - the manifests array.
 * @param problems - the error list.
 * @returns the manifest rows that parsed.
 */
function readManifests(value: unknown, problems: string[]): ManifestRow[] {
  if (!Array.isArray(value)) {
    problems.push('manifests 必须是数组')
    return []
  }
  const manifests: ManifestRow[] = []
  for (const entry of value) {
    if (!isRecord(entry) || textOf(entry['id']) === undefined || !Array.isArray(entry['provisions'])) {
      problems.push('manifest 行必须有 id 与 provisions')
      continue
    }
    const id = String(entry['id'])
    manifests.push({
      id,
      provisions: entry['provisions']
        .map(item => readProvision(item, id, problems))
        .filter((item): item is Provision => item?.proposition !== undefined),
    })
  }
  return manifests
}

/**
 * @param value - the corrections array.
 * @param problems - the error list.
 * @returns the corrections that parsed.
 */
function readCorrections(value: unknown, problems: string[]): Correction[] {
  if (!Array.isArray(value)) {
    problems.push('corrections 必须是数组')
    return []
  }
  const corrections: Correction[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = textOf(entry['id'])
    const law = textOf(entry['law'])
    const article = intOf(entry['article'])
    const contains = textOf(entry['contains'])
    if (id === undefined || law === undefined || !STATUTES.has(law) || article === undefined || contains === undefined) {
      problems.push('勘误必须写明 id、法律、条号与现行正文')
      continue
    }
    const paragraph = entry['paragraph'] === undefined ? undefined : intOf(entry['paragraph'])
    let sourceAbsent: Correction['sourceAbsent']
    if (entry['sourceAbsent'] !== undefined) {
      if (!isRecord(entry['sourceAbsent']) || textOf(entry['sourceAbsent']['dir']) === undefined || textOf(entry['sourceAbsent']['text']) === undefined) {
        problems.push(`${id}：sourceAbsent 必须写明目录与不得出现的文本`)
      } else {
        sourceAbsent = { dir: String(entry['sourceAbsent']['dir']), text: String(entry['sourceAbsent']['text']) }
      }
    }
    const test = entry['test'] === undefined ? undefined : readTest(entry['test'], id, problems)
    corrections.push({
      id,
      law: law as StatuteName,
      article,
      ...(paragraph !== undefined ? { paragraph } : {}),
      contains,
      ...(textOf(entry['excludes']) !== undefined ? { excludes: String(entry['excludes']) } : {}),
      ...(sourceAbsent !== undefined ? { sourceAbsent } : {}),
      ...(test !== undefined ? { test } : {}),
    })
  }
  return corrections
}

/**
 * Load the shipped inventory.
 * @param root - repository root.
 * @returns the YAML document.
 */
export function loadAlignmentDocument(root = ROOT): unknown {
  return loadYaml(readFileSync(join(root, 'packages/patent/patent-law/assets/authority/rule-procedure-alignment.yaml'), 'utf8'))
}

/**
 * Check one inventory document.
 * @param document - the parsed YAML document.
 * @param root - repository root.
 * @returns the problems. An empty list means the inventory matches the tree.
 */
export function checkAlignmentDocument(document: unknown, root = ROOT): string[] {
  fileText.clear()
  const { inventory, problems } = parseAlignmentInventory(document)
  const baselines = loadLawBaselines()
  const rules = loadPackagedBases(root)
  const fees = loadFeeTable().items
  problems.push(...checkFamilies(inventory.families, baselines, rules, root))
  problems.push(...checkComputations(inventory.computations, baselines, fees, root))
  problems.push(...checkTemplates(inventory.templates, baselines, root))
  problems.push(...checkManifests(inventory.manifests, baselines, root))
  problems.push(...checkCorrections(inventory.corrections, baselines, root))
  return problems
}

/**
 * Check the shipped inventory.
 * @param root - repository root.
 * @returns the problems.
 */
export function checkRuleProcedureAlignment(root = ROOT): string[] {
  return checkAlignmentDocument(loadAlignmentDocument(root), root)
}

/**
 * Load packaged rule bases, including evidence rules that use `ruleId`.
 * @param root - repository root.
 * @returns rule id to legalBasis.
 */
function loadPackagedBases(root: string): Map<string, string> {
  const bases = new Map<string, string>()
  const rulesDir = join(root, 'packages/patent/patent-rule/assets/rules')
  for (const file of yamlFiles(rulesDir)) {
    const text = readFileSync(file, 'utf8')
    if (!/^rules:/m.test(text) || file.endsWith('/evidence-rules.yaml')) continue
    const loaded = loadRuleSetFromFile(file)
    for (const rule of loaded.ruleSet.rules) {
      if (rule.legalBasis !== undefined) bases.set(rule.id, rule.legalBasis)
    }
  }
  const evidence = join(rulesDir, 'patent/evidence-rules.yaml')
  let id: string | undefined
  let basis: string | undefined
  const flush = (): void => {
    if (id !== undefined && basis !== undefined) bases.set(id, basis)
    id = undefined
    basis = undefined
  }
  for (const line of readFileSync(evidence, 'utf8').split('\n')) {
    const idMatch = /^  - ruleId: (\S+)/.exec(line)
    if (idMatch?.[1] !== undefined) {
      flush()
      id = idMatch[1]
      continue
    }
    const basisMatch = /^    legalBasis: (.+)$/.exec(line)
    if (basisMatch?.[1] !== undefined && id !== undefined) basis = basisMatch[1]
  }
  flush()
  return bases
}

/**
 * @param dir - the directory to walk.
 * @returns the yaml files under it.
 */
function yamlFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...yamlFiles(path))
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) files.push(path)
  }
  return files
}

/**
 * @param families - the rule families.
 * @param baselines - the law index.
 * @param rules - packaged legalBasis values.
 * @param root - repository root.
 * @returns the problems.
 */
function checkFamilies(
  families: readonly Family[],
  baselines: Map<LawName, LawBaseline>,
  rules: ReadonlyMap<string, string>,
  root: string,
): string[] {
  const problems: string[] = []
  const ids = families.map(family => family.id)
  for (const id of FAMILY_IDS) {
    if (!ids.includes(id)) problems.push(`缺少规则族 ${id}`)
  }
  for (const id of ids) {
    if (!FAMILY_IDS.includes(id as typeof FAMILY_IDS[number])) problems.push(`未知规则族 ${id}`)
  }
  for (const family of families) {
    if (family.links.length === 0) problems.push(`${family.id}：规则族没有条文链接`)
    for (const link of family.links) {
      problems.push(...supportProblems(family.id, link.provision, baselines))
      const needle = link.rule.kind === 'packaged' ? link.rule.id : ''
      if (link.rule.kind === 'packaged') {
        const basis = rules.get(link.rule.id)
        if (basis === undefined) problems.push(`${family.id}：规则 ${link.rule.id} 不在随包资产中`)
        else if (!cites(basis, link.provision)) problems.push(`${family.id}：规则 ${link.rule.id} 的依据没有引用该条`)
      } else {
        const source = readText(root, link.rule.file)
        if (source === undefined) problems.push(`${family.id}：找不到 ${link.rule.file}`)
        else if (!source.includes(link.rule.anchor)) problems.push(`${family.id}：${link.rule.file} 没有锚点「${link.rule.anchor}」`)
      }
      problems.push(...testProblems(family.id, link.test, needle, root))
    }
  }
  return problems
}

/**
 * @param computations - the comparison rows.
 * @param baselines - the law index.
 * @param fees - the fee index.
 * @param root - repository root.
 * @returns the problems.
 */
function checkComputations(
  computations: readonly Computation[],
  baselines: Map<LawName, LawBaseline>,
  fees: readonly FeeItem[],
  root: string,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const row of computations) {
    if (seen.has(row.id)) problems.push(`${row.id}：程序计算 id 重复`)
    seen.add(row.id)
    const focus = focusText(row.provision, baselines, problems, row.id)
    if (row.provision.quote !== undefined && focus !== undefined && !focus.includes(row.provision.quote)) {
      problems.push(`${row.id}：条文正文没有「${row.provision.quote}」`)
    }
    if (row.gap && row.code !== undefined && !/不/.test(row.code.anchor)) {
      problems.push(`${row.id}：未实现的计算必须在锚点里写明不计算什么`)
    }
    if (row.code !== undefined) {
      const source = readText(root, row.code.file)
      if (source === undefined) problems.push(`${row.id}：找不到 ${row.code.file}`)
      else if (!source.includes(row.code.anchor)) problems.push(`${row.id}：${row.code.file} 没有锚点「${row.code.anchor}」`)
    }
    if (row.test !== undefined) problems.push(...testProblems(row.id, row.test, '', root))
    if (row.absent) {
      const hit = fees.filter(item => [item.name, item.sourceDoc, item.legalBasis].some(field => field?.includes(row.provision.quote ?? '')))
      if (hit.length > 0) problems.push(`${row.id}：费用索引已有 ${hit.map(item => item.id).join('、')}，不能再标成未收录`)
    } else if (row.indexIds.length > 0) {
      for (const id of row.indexIds) {
        const item = fees.find(candidate => candidate.id === id)
        if (item === undefined) problems.push(`${row.id}：费用索引没有 ${id}`)
        else if (row.legalBasisIncludes !== undefined && !(item.legalBasis ?? '').includes(row.legalBasisIncludes)) {
          problems.push(`${row.id}：${id} 的依据没有「${row.legalBasisIncludes}」`)
        }
      }
    } else if (row.code === undefined) {
      problems.push(`${row.id}：程序计算必须给出代码锚点或费用条目`)
    }
    if (row.code !== undefined && row.test === undefined) problems.push(`${row.id}：程序计算没有用例`)
  }
  for (const [law, article, paragraph, item] of REQUIRED_LINES) {
    const covered = computations.some(row => row.provision.law === law
      && row.provision.article === article
      && (paragraph === 0 || row.provision.paragraph === paragraph)
      && (item === 0 || row.provision.item === item))
    if (!covered) problems.push(`对照表缺少${law}第${String(article)}条${paragraph === 0 ? '' : `第${String(paragraph)}款`}${item === 0 ? '' : `第${String(item)}项`}`)
  }
  return problems
}

/**
 * @param templates - the template inventory.
 * @param baselines - the law index.
 * @param root - repository root.
 * @returns the problems.
 */
function checkTemplates(
  templates: readonly TemplateRow[],
  baselines: Map<LawName, LawBaseline>,
  root: string,
): string[] {
  const problems: string[] = []
  const ids = templates.map(row => row.id)
  const shipped = readTemplateIds(root)
  const dirs = templateDirectories(root)
  for (const id of shipped) {
    if (!ids.includes(id)) problems.push(`模板 ${id} 没有条文清单`)
  }
  for (const id of ids) {
    if (!shipped.includes(id)) problems.push(`清单中的模板 ${id} 不在渲染器的模板表里`)
    if (!dirs.includes(id)) problems.push(`清单中的模板 ${id} 没有 template.html`)
  }
  if (new Set(ids).size !== ids.length) problems.push('模板 id 重复')
  for (const row of templates) {
    if (row.provisions.length === 0) problems.push(`${row.id}：模板没有条文`)
    for (const provision of row.provisions) problems.push(...supportProblems(row.id, provision, baselines))
    const source = readText(root, row.formatTest.file)
    if (source === undefined) problems.push(`${row.id}：找不到格式断言 ${row.formatTest.file}`)
    else if (!source.includes(`it('${row.formatTest.title}'`) && !source.includes(`it("${row.formatTest.title}"`)) {
      problems.push(`${row.id}：格式断言没有标题「${row.formatTest.title}」`)
    } else if (row.formatTest.binds !== undefined) {
      if (!source.includes(row.formatTest.binds)) problems.push(`${row.id}：格式断言没有绑定 ${row.formatTest.binds}`)
      const listed = row.formatTest.idSource === undefined ? undefined : readText(root, row.formatTest.idSource)
      if (listed === undefined || !listed.includes(`'${row.id}'`)) problems.push(`${row.id}：模板 id 不在 ${row.formatTest.idSource ?? '格式断言'} 中`)
    } else if (!source.includes(row.id)) {
      problems.push(`${row.id}：格式断言没有写到这个模板`)
    }
  }
  return problems
}

/**
 * @param manifests - the manifest inventory.
 * @param baselines - the law index.
 * @param root - repository root.
 * @returns the problems.
 */
function checkManifests(
  manifests: readonly ManifestRow[],
  baselines: Map<LawName, LawBaseline>,
  root: string,
): string[] {
  const problems: string[] = []
  const source = readText(root, 'packages/patent/patent-workflow/src/workflow/manifests.ts') ?? ''
  const shipped = [...source.matchAll(/id: '(patent_[a-z0-9_]+)'/g)].map(match => match[1] ?? '')
  const ids = manifests.map(row => row.id)
  for (const id of shipped) {
    if (!ids.includes(id)) problems.push(`工作流 ${id} 没有条文清单`)
  }
  for (const row of manifests) {
    if (!shipped.includes(row.id)) problems.push(`清单中的工作流 ${row.id} 不在内置 manifest 中`)
    if (row.provisions.length === 0) problems.push(`${row.id}：工作流没有条文`)
    for (const provision of row.provisions) problems.push(...supportProblems(row.id, provision, baselines))
  }
  if (new Set(ids).size !== ids.length) problems.push('工作流 id 重复')
  return problems
}

/**
 * @param corrections - the numbering corrections.
 * @param baselines - the law index.
 * @param root - repository root.
 * @returns the problems.
 */
function checkCorrections(
  corrections: readonly Correction[],
  baselines: Map<LawName, LawBaseline>,
  root: string,
): string[] {
  const problems: string[] = []
  for (const correction of corrections) {
    const focus = focusText(correction, baselines, problems, correction.id)
    if (focus !== undefined && !focus.includes(correction.contains)) {
      problems.push(`${correction.id}：现行正文没有「${correction.contains}」`)
    }
    if (focus !== undefined && correction.excludes !== undefined && focus.includes(correction.excludes)) {
      problems.push(`${correction.id}：现行正文不该有「${correction.excludes}」`)
    }
    if (correction.sourceAbsent !== undefined) {
      const hit = walkText(join(root, correction.sourceAbsent.dir)).find(file => file.text.includes(correction.sourceAbsent?.text ?? ''))
      if (hit !== undefined) problems.push(`${correction.id}：${relative(root, hit.file)} 仍写着「${correction.sourceAbsent.text}」`)
    }
    if (correction.test !== undefined) problems.push(...testProblems(correction.id, correction.test, correction.contains, root))
  }
  return problems
}

/**
 * @param where - the row id.
 * @param provision - the provision.
 * @param baselines - the law index.
 * @returns the problems from a proposition that the cited text does not support.
 */
function supportProblems(where: string, provision: Provision, baselines: Map<LawName, LawBaseline>): string[] {
  if (provision.proposition === undefined) return [`${where}：缺少命题`]
  const reference: LawArticleReference = {
    kind: 'law-article',
    law: provision.law,
    article: provision.article,
    raw: `${provision.law}第${String(provision.article)}条`,
    ...(provision.paragraph !== undefined ? { paragraph: provision.paragraph } : {}),
    ...(provision.item !== undefined ? { item: provision.item } : {}),
  }
  const finding = verifyCitation(reference, baselines, { proposition: provision.proposition })
  return finding.decision === 'valid' ? [] : [`${where}：${finding.reason}`]
}

/**
 * @param provision - the cited location.
 * @param baselines - the law index.
 * @param problems - receives an error when the article or the item is missing.
 * @param where - the row id.
 * @returns the text the quote is compared with.
 */
function focusText(
  provision: { law: StatuteName; article: number; paragraph?: number; item?: number },
  baselines: Map<LawName, LawBaseline>,
  problems: string[],
  where: string,
): string | undefined {
  const baseline = baselines.get(provision.law)
  const entry = baseline?.articles.find(article => article.article === provision.article)
  if (entry?.text == null) {
    problems.push(`${where}：${provision.law}第${String(provision.article)}条没有正文`)
    return undefined
  }
  const focus = articleCitationFocus(
    {
      article: entry.article,
      text: entry.text,
      ...(entry.paragraphs !== undefined ? { paragraphs: [...entry.paragraphs] } : {}),
    },
    {
      ...(provision.paragraph !== undefined ? { paragraph: provision.paragraph } : {}),
      ...(provision.item !== undefined ? { item: provision.item } : {}),
    },
  )
  if (focus.missingItem !== null) {
    problems.push(`${where}：${focus.missingItem}`)
    return undefined
  }
  return focus.text
}

/**
 * @param reference - a parsed reference.
 * @returns whether it names a statute article.
 */
function isArticle(reference: LawReference): reference is LawArticleReference {
  return reference.kind === 'law-article'
}

/**
 * @param basis - a rule's legalBasis.
 * @param provision - the provision the rule must cite.
 * @returns whether the basis cites that law and article, and the paragraph or item when it names one.
 */
function cites(basis: string, provision: Provision): boolean {
  const refs = extractLawReferences(basis).filter(isArticle).filter(reference =>
    reference.law === provision.law && reference.article === provision.article)
  if (refs.length === 0) return false
  if (provision.paragraph !== undefined && refs.some(reference => reference.paragraph !== undefined)
    && !refs.some(reference => reference.paragraph === provision.paragraph)) return false
  if (provision.item !== undefined && refs.some(reference => reference.item !== undefined)
    && !refs.some(reference => reference.item === provision.item)) return false
  return true
}

/**
 * @param where - the row id.
 * @param test - the test reference.
 * @param needle - a proposition or subject the test file must also contain, when non-empty.
 * @param root - repository root.
 * @returns the problems.
 */
function testProblems(where: string, test: TestRef, needle: string, root: string): string[] {
  const source = readText(root, test.file)
  if (source === undefined) return [`${where}：找不到用例 ${test.file}`]
  if (!source.includes(`it('${test.title}'`) && !source.includes(`it("${test.title}"`)) {
    return [`${where}：${test.file} 没有标题「${test.title}」`]
  }
  if (needle !== '' && !source.includes(needle)) return [`${where}：用例文件没有命题「${needle}」`]
  return []
}

/**
 * @param root - repository root.
 * @returns the template ids declared by the renderer.
 */
function readTemplateIds(root: string): string[] {
  const source = readText(root, 'packages/patent/patent-document/src/tool/render-patent-document.ts') ?? ''
  const start = source.indexOf('export const TEMPLATE_IDS')
  const end = source.indexOf('] as const', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1] ?? '').filter(id => id !== '')
}

/**
 * @param root - repository root.
 * @returns template directories that ship a template.html.
 */
function templateDirectories(root: string): string[] {
  const dir = join(root, 'packages/patent/patent-document/assets/templates/patent')
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(join(dir, name, 'assets/template.html')) || existsSync(join(dir, name, 'template.html')))
}

/**
 * @param dir - an absolute directory.
 * @returns the text of each source file under it.
 */
function walkText(dir: string): Array<{ file: string; text: string }> {
  if (!existsSync(dir)) return []
  const files: Array<{ file: string; text: string }> = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...walkText(path))
    else if (entry.endsWith('.ts') || entry.endsWith('.yaml')) files.push({ file: path, text: readFileSync(path, 'utf8') })
  }
  return files
}

/**
 * Print the problems and exit non-zero when the inventory does not match.
 */
function main(): void {
  const problems = checkRuleProcedureAlignment()
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  console.log('verify-patent-rule-alignment: 规则族、程序计算、模板与工作流清单一致')
}

if (process.argv[1]?.endsWith('verify-patent-rule-alignment.ts')) main()
