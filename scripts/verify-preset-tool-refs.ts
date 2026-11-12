/**
 * Verify that the tool names a shipped preset's text and skills reference in
 * backticks — and the tool names its own gate declarations name — are tools
 * that preset mounts, and that the counts the same corpus states are the
 * counts its registries carry.
 *
 * Known names come from the package map of `docs/tool-catalog.md`, the
 * freshness-gated catalog that boots every tool plugin; the mounted set comes
 * from the preset's own plugin entries, plus each row's load-time `toolName`
 * and the shipped aliases the catalog records, while a row the preset disables
 * contributes nothing and a row whose own config turns a registration off
 * drops that tool. A backticked name that no
 * mounted tool and no {@link EXEMPT_REFERENCES} entry accounts for fails the
 * gate, so a renamed or invented tool cannot stay in model-facing skill text.
 * A name a `deliveryGate` / `structuralGate` declaration carries fails the same
 * way: an unresolvable prerequisite denies the guarded call in every session
 * while the rest of the declaration looks healthy.
 *
 * The same corpus states two counts by hand: a preset README's "N model-facing
 * tools" beside a package, checked against the tools that package mounts, and
 * `render_patent_document`'s "one of the N shipped patent templates", checked
 * against the ids `TEMPLATE_IDS` exports. The template check reads both the
 * tool's own source description and the generated catalog, so a count that no
 * longer matches the registry fails whether or not the catalog was regenerated.
 * Both fail on a count the registry contradicts, so a tool or template added
 * without its prose cannot leave a model- or user-facing number behind.
 *
 * Only backticked lowercase snake_case names carrying an underscore are
 * checked; that is the form a tool reference takes here, and it keeps prose
 * values such as status words or field names out of the corpus unless they
 * need an explicit exemption.
 * @module scripts/verify-preset-tool-refs
 */

import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { TEMPLATE_IDS } from '@deepseek-ai/dsh-patent-document'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import { loadCordisYaml } from './cordis-yaml.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** Repository-relative path of the freshness-gated tool catalog. */
const CATALOG_PATH = 'docs/tool-catalog.md'

/**
 * Repository-relative path of the tool that states the shipped template count
 * in its model-visible parameter description.
 */
const TEMPLATE_DESCRIPTION_PATH = 'packages/patent/patent-document/src/tool/render-patent-document.ts'

/** Repository-relative directories of the shipped preset corpus. */
const PRESET_DIR = 'packages/bundle/web-app/presets'
const SKILL_DIR = 'packages/bundle/web-app/skills'

/**
 * Backticked names the mounted tool set does not account for, each with the
 * reason it is exempt: a data field, a status value, an external MCP tool, or
 * another plugin's tool that the corpus names without mounting it.
 */
const EXEMPT_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['abstract_heading', 'validate_specification result key'],
  ['based_on', 'cnlaw graph relation name'],
  ['brief_ref', 'document brief metadata field'],
  ['case_type', 'cnlaw REST query parameter'],
  ['char_budget', 'document deliverable metadata field'],
  ['citation_verified', 'patent evidence field'],
  ['cnlaw_graph_ground', 'cnlaw MCP tool, provided by the deployment rather than a packaged plugin'],
  ['cnlaw_graph_patent', 'cnlaw MCP tool, provided by the deployment rather than a packaged plugin'],
  ['cnlaw_inventive_step', 'cnlaw MCP tool, provided by the deployment rather than a packaged plugin'],
  ['decision_result', 'cnlaw case field'],
  ['figure_mark_parentheses', 'validate_specification result key'],
  ['figure_number_spacing', 'validate_specification result key'],
  ['full_name', 'cnlaw REST response field'],
  ['gate_feedback', 'patent worker contract field'],
  ['heading_set', 'validate_specification result key'],
  ['in_progress', 'task status value'],
  ['inventive_step', 'cnlaw evidence package key'],
  ['max_claims', 'draft_claims tool parameter'],
  ['mcp__yuandian__yuandian_get_law_or_regulation_detail', 'Yuandian MCP tool, provided by the deployment rather than a packaged plugin'],
  ['mcp__yuandian__yuandian_search_authoritative_cases', 'Yuandian MCP tool, provided by the deployment rather than a packaged plugin'],
  ['mcp__yuandian__yuandian_search_judicial_cases', 'Yuandian MCP tool, provided by the deployment rather than a packaged plugin'],
  ['mcp__yuandian__yuandian_search_laws_and_regulations', 'Yuandian MCP tool, provided by the deployment rather than a packaged plugin'],
  ['mcp__yuandian__yuandian_search_legal_articles', 'Yuandian MCP tool, provided by the deployment rather than a packaged plugin'],
  ['paragraph_numbering', 'validate_specification result key'],
  ['patent_invalidation_v1', 'workflow manifest id'],
  ['patent_inventiveness_v1', 'workflow manifest id'],
  ['patent_novelty_v1', 'workflow manifest id'],
  ['patent_oa_response_v1', 'workflow manifest id'],
  ['patent_disclosure_v1', 'workflow manifest id'],
  ['patent_patentability_v1', 'workflow manifest id'],
  ['patent_reexamination_v1', 'workflow manifest id'],
  ['patent_infringement_v1', 'workflow manifest id'],
  ['output_path', 'render_doc_template parameter'],
  ['upsert_shot', 'video_project action value'],
  ['keyframe_path', 'video_project shot field'],
  ['clip_path', 'video_project shot field'],
  ['cost_cny', 'video_project shot field'],
  ['duration_sec', 'media and video_project parameter'],
  ['first_frame_path', 'media parameter'],
  ['project_path', 'media and video_project parameter'],
  ['reason_text', 'document_deliver parameter'],
  ['run_in_background', 'bash tool parameter'],
  ['section_order', 'validate_specification result key'],
  ['source_path', 'patent evidence field'],
  ['unreadable_ack', 'document_deliver parameter'],
  ['spawn_teammate', 'removed by the subagent-control split; no shipped package registers it, and the corpus names it only to prohibit its use'],

])

/**
 * Workflow stage ids the shipped manifests declare.
 *
 * Skill text names stages to say which part of a manifest a member verifies or
 * which stage a rewind revisits, so these names legitimately appear in
 * backticks without being tools. Deriving the set from the manifests keeps a
 * renamed or dropped stage from staying exempt, which a hand-kept list would
 * not catch.
 */
const STAGE_IDS: ReadonlySet<string> = new Set(
  builtinPatentManifests.flatMap(manifest => manifest.stages.map(stage => stage.id)),
)

/**
 * Whether a backticked name is a workflow stage id rather than a tool reference.
 * @param name - the backticked name.
 * @returns true when a shipped manifest declares it as a stage.
 */
export function isStageId(name: string): boolean {
  return STAGE_IDS.has(name)
}

/** One corpus file: a preset YAML or one of its skill files. */
export interface PresetFile {
  /** Repository-relative path, used in diagnostics. */
  readonly path: string
  /** File text. */
  readonly source: string
}

/** One preset with the README pair and skill files that belong to it. */
export interface PresetCorpus {
  /** Preset name: the `<name>` of `<name>.patch.yml` and of its skills directory. */
  readonly preset: string
  /** The preset YAML file. */
  readonly presetFile: PresetFile
  /** The preset's hand-written README files (`<name>.md`, `<name>.zh.md`), when it ships them. */
  readonly readmeFiles: readonly PresetFile[]
  /** The Markdown files under the preset's skills directory, in path order. */
  readonly skillFiles: readonly PresetFile[]
}

/** A backticked name and the line it appears on. */
export interface ToolReference {
  /** 1-based line number. */
  readonly line: number
  /** The backticked name. */
  readonly name: string
}

/**
 * The names one cataloged package registers, split by the column that lists them.
 */
export interface CatalogPackage {
  /** The model-visible names the package registers. */
  readonly names: ReadonlySet<string>
  /** The shipped aliases the catalog records for those tools. */
  readonly aliases: ReadonlySet<string>
}

/**
 * Collect the backticked snake_case names one catalog cell lists.
 * @param cell - the table cell text.
 * @returns the names the cell carries.
 */
function catalogCellNames(cell: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of cell.matchAll(/`([a-z][a-z0-9_]*)`/gu)) names.add(match[1] as string)
  return names
}

/**
 * Parse the tool names and shipped aliases of the catalog's package map.
 *
 * Names and aliases stay apart: a count of tools compares against `names`,
 * while reference resolution accepts both.
 * @param source - text of `docs/tool-catalog.md`.
 * @returns every cataloged package's names and aliases, keyed by package name.
 */
export function parseToolCatalog(source: string): Map<string, CatalogPackage> {
  const catalog = new Map<string, CatalogPackage>()
  for (const line of source.split('\n')) {
    const row = /^\| `(@deepseek-ai\/[^`]+)` \|/u.exec(line)
    if (row === null) continue
    // | package | names | requires | writes / affects | aliases | note |
    const cells = line.split('|')
    catalog.set(row[1] as string, {
      names: catalogCellNames(cells[2] ?? ''),
      aliases: catalogCellNames(cells[5] ?? ''),
    })
  }
  return catalog
}

/** One plugin config switch that decides whether the package registers a cataloged tool. */
export interface ConfigToolSwitch {
  /** The plugin config key, as the preset writes it. */
  readonly key: string
  /** The cataloged tool the package registers only while the switch is on. */
  readonly tool: string
}

/**
 * The config switches that decide tool registration, per package.
 *
 * The catalog lists what a package can register; a preset that turns a switch
 * off mounts only the rest, so the mounted set subtracts it. This is the one
 * place that records which config keys carry that power — a package whose
 * config only tunes limits does not belong here.
 */
const CONFIG_TOOL_SWITCHES: ReadonlyMap<string, readonly ConfigToolSwitch[]> = new Map([
  // web/tool-web/src/index.ts calls applyWebSearchTool / applyWebFetchTool only
  // while search / fetch resolve true, so a preset writing `fetch: false`
  // removes `web_fetch` from the model-facing set.
  ['@deepseek-ai/dsh-tool-web', [
    { key: 'search', tool: 'web_search' },
    { key: 'fetch', tool: 'web_fetch' },
  ]],
])

/**
 * The cataloged tools one plugin entry's own config turns off.
 * @param entry - the plugin entry carrying `name` and, optionally, `config`.
 * @param packageName - the entry's package name.
 * @param configSwitches - config keys that remove a tool, per package.
 * @returns the tools this entry's config turns off.
 */
function switchedOffTools(
  entry: Record<string, unknown>,
  packageName: string,
  configSwitches: ReadonlyMap<string, readonly ConfigToolSwitch[]>,
): Set<string> {
  const off = new Set<string>()
  const switches = configSwitches.get(packageName)
  if (switches === undefined) return off
  const config = entry.config
  if (typeof config !== 'object' || config === null) return off
  const values = new Map(Object.entries(config))
  for (const item of switches) {
    if (values.get(item.key) === false) off.add(item.tool)
  }
  return off
}

/**
 * Flatten a preset's YAML into the object nodes a gate declaration can live on.
 *
 * Both readers below — the mounted tool set and the gate-declared names — walk
 * the same tree with the same rule (a row the preset disables contributes
 * nothing, and `!!js` conditions arrive evaluated, so a platform-off row is
 * skipped exactly as the load skips it), so the walk exists once here.
 * @param presetSource - the preset YAML text.
 * @returns every object node outside a disabled row, in document order.
 */
export function presetRowRecords(presetSource: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.disabled === true) return
    records.push(record)
    for (const item of Object.values(record)) visit(item)
  }
  visit(loadCordisYaml(presetSource))
  return records
}

/** The cataloged tools one preset mounts through one package. */
export interface MountedPackageTools {
  /** The model-visible names the package mounts. */
  readonly names: Set<string>
  /** The shipped aliases that resolve to those tools. */
  readonly aliases: Set<string>
}

/**
 * Resolve the cataloged tools one preset mounts, grouped by the package that
 * registers them.
 * @param presetSource - the preset YAML text.
 * @param catalog - {@link parseToolCatalog} result.
 * @param configSwitches - config keys that remove a tool, per package.
 * @returns each mounted package's cataloged names and aliases, with the tools a row's own config turns off removed.
 */
export function mountedToolsByPackage(
  presetSource: string,
  catalog: ReadonlyMap<string, CatalogPackage>,
  configSwitches: ReadonlyMap<string, readonly ConfigToolSwitch[]> = CONFIG_TOOL_SWITCHES,
): Map<string, MountedPackageTools> {
  const byPackage = new Map<string, MountedPackageTools>()
  for (const record of presetRowRecords(presetSource)) {
    if (typeof record.name !== 'string') continue
    const cataloged = catalog.get(record.name)
    if (cataloged === undefined) continue
    const off = switchedOffTools(record, record.name, configSwitches)
    let mounted = byPackage.get(record.name)
    if (mounted === undefined) {
      mounted = { names: new Set<string>(), aliases: new Set<string>() }
      byPackage.set(record.name, mounted)
    }
    for (const tool of cataloged.names) {
      if (!off.has(tool)) mounted.names.add(tool)
    }
    for (const alias of cataloged.aliases) {
      if (!off.has(alias)) mounted.aliases.add(alias)
    }
  }
  return byPackage
}

/**
 * Resolve the tool names one preset mounts.
 * @param presetSource - the preset YAML text.
 * @param catalog - {@link parseToolCatalog} result.
 * @param configSwitches - config keys that remove a tool, per package.
 * @returns the mounted tool names and their shipped aliases, including every
 * load-time `toolName` value and excluding the tools a row's own config turns off.
 */
export function mountedToolNames(
  presetSource: string,
  catalog: ReadonlyMap<string, CatalogPackage>,
  configSwitches: ReadonlyMap<string, readonly ConfigToolSwitch[]> = CONFIG_TOOL_SWITCHES,
): Set<string> {
  const names = new Set<string>()
  for (const mounted of mountedToolsByPackage(presetSource, catalog, configSwitches).values()) {
    for (const tool of mounted.names) names.add(tool)
    for (const alias of mounted.aliases) names.add(alias)
  }
  for (const record of presetRowRecords(presetSource)) {
    if (typeof record.toolName === 'string' && record.toolName.length > 0) names.add(record.toolName)
  }
  return names
}

/** One tool count a preset README states for one plugin package. */
export interface DeclaredToolCount {
  /** 1-based line number. */
  readonly line: number
  /** The package whose tools the sentence counts. */
  readonly packageName: string
  /** The count the sentence states. */
  readonly count: number
}

/**
 * Collect the per-package tool counts a README states.
 *
 * The recognized sentences are the preset READMEs' catalogue lines: a
 * backticked package name, an em dash, and `<count> model-facing tools` or its
 * Chinese counterpart `<count> 个模型工具`. A sentence that shapes the count
 * differently is not a declaration and stays out of the corpus.
 * @param source - the README text.
 * @returns every declared count, in line order.
 */
export function declaredToolCounts(source: string): DeclaredToolCount[] {
  const declarations: DeclaredToolCount[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/`(@deepseek-ai\/[^`]+)`\s*—+\s*(\d+)\s+(?:model-facing tools|个模型工具)/gu)) {
      declarations.push({
        line: index + 1,
        packageName: match[1] as string,
        count: Number(match[2]),
      })
    }
  }
  return declarations
}

/**
 * Check every per-package tool count a preset README states.
 * @param catalogSource - text of `docs/tool-catalog.md`.
 * @param corpus - one entry per shipped preset.
 * @param configSwitches - config keys that remove a tool, per package.
 * @returns one diagnostic per count the mounted tool set contradicts.
 */
export function findToolCountViolations(
  catalogSource: string,
  corpus: readonly PresetCorpus[],
  configSwitches: ReadonlyMap<string, readonly ConfigToolSwitch[]> = CONFIG_TOOL_SWITCHES,
): string[] {
  const catalog = parseToolCatalog(catalogSource)
  if (catalog.size === 0) throw new Error('verify-preset-tool-refs: the tool catalog carries no package rows')
  const violations: string[] = []
  for (const entry of corpus) {
    const mounted = mountedToolsByPackage(entry.presetFile.source, catalog, configSwitches)
    for (const file of entry.readmeFiles) {
      for (const declaration of declaredToolCounts(file.source)) {
        const tools = mounted.get(declaration.packageName)
        if (tools === undefined) {
          violations.push(
            `${file.path}:${String(declaration.line)}: states a tool count for ${declaration.packageName}, which preset ${entry.preset} does not mount`,
          )
          continue
        }
        if (tools.names.size !== declaration.count) {
          violations.push(
            `${file.path}:${String(declaration.line)}: states ${String(declaration.count)} tools for ${declaration.packageName}, but preset ${entry.preset} mounts ${String(tools.names.size)}`,
          )
        }
      }
    }
  }
  return violations
}

/**
 * The tool whose parameter description states how many templates it ships.
 */
const TEMPLATE_COUNT_TOOL = 'render_patent_document'

/** A count a tool description states, with the phrase that carries it. */
export interface StatedTemplateCount {
  /** The matched phrase, e.g. `one of the eleven shipped patent templates`. */
  readonly phrase: string
  /** The stated count, or undefined when the token names no number the reader knows. */
  readonly count: number | undefined
}

/** Spelled counts the shipped descriptions can use: one to twenty-nine. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
])

/**
 * Read a spelled or digit count.
 * @param token - the number word, hyphenated compound, or digit string.
 * @returns the count, or undefined when the token names no number in range.
 */
function countOf(token: string): number | undefined {
  if (/^\d+$/u.test(token)) return Number(token)
  const parts = token.toLowerCase().split('-')
  const tens = parts[0] === undefined ? undefined : NUMBER_WORDS.get(parts[0])
  if (parts.length === 1) return tens
  const units = parts.length === 2 && parts[1] !== undefined ? NUMBER_WORDS.get(parts[1]) : undefined
  if (tens !== 20 || units === undefined || units < 1 || units > 9) return undefined
  return tens + units
}

/**
 * Extract one tool's section from the generated catalog.
 * @param source - text of `docs/tool-catalog.md`.
 * @param tool - the tool name as its `###` heading renders it.
 * @returns the section text, or undefined when the catalog carries no such heading.
 */
export function catalogToolSection(source: string, tool: string): string | undefined {
  const heading = new RegExp(`^### \`${tool}\`[ \\t]*$`, 'm').exec(source)
  if (heading === null) return undefined
  const rest = source.slice(heading.index + heading[0].length)
  const next = /^#{2,3} /m.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/**
 * Collect the total template counts a tool description states.
 *
 * Two phrasings mean "the shipped template count": `one of the <n> shipped
 * patent templates` and `all <n> templates accept`. Per-category counts such
 * as "the ten document templates" name a subset and stay out.
 * @param section - one tool's catalog section.
 * @returns every stated total, grouped by phrasing.
 */
export function statedTemplateCounts(section: string): StatedTemplateCount[] {
  const statements: StatedTemplateCount[] = []
  const patterns = [
    /one of the ([a-z]+(?:-[a-z]+)?|\d+) shipped patent templates/giu,
    /all ([a-z]+(?:-[a-z]+)?|\d+) templates accept/giu,
  ]
  for (const pattern of patterns) {
    for (const match of section.matchAll(pattern)) {
      statements.push({ phrase: match[0], count: countOf(match[1] as string) })
    }
  }
  return statements
}

/**
 * Count the ids one tool's catalog schema enumerates for its `template` property.
 * @param section - one tool's catalog section.
 * @returns the id list, or undefined when the section carries no such enum.
 */
function templateEnumIds(section: string): string[] | undefined {
  const block = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(section)
  if (block === null) return undefined
  const schema: unknown = JSON.parse(block[1] as string)
  if (typeof schema !== 'object' || schema === null) return undefined
  const { properties } = schema as { properties?: unknown }
  if (typeof properties !== 'object' || properties === null) return undefined
  const { template } = properties as { template?: unknown }
  if (typeof template !== 'object' || template === null) return undefined
  const { enum: ids } = template as { enum?: unknown }
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return undefined
  return ids
}

/**
 * Check every shipped-template count one text states.
 *
 * A text that states no count fails: the statement is the gate's whole subject,
 * so dropping it would retire the check silently.
 * @param source - the text carrying the statements.
 * @param expectedCount - the count the shipped template registry carries.
 * @param context - the statement's location prefix, ending in a colon when it names a file.
 * @returns one diagnostic per missing or contradicted count.
 */
export function findTemplateStatementViolations(
  source: string,
  expectedCount: number,
  context: string,
): string[] {
  const statements = statedTemplateCounts(source)
  if (statements.length === 0) return [`${context} no longer states the shipped template count`]
  return statements.map((statement) => {
    if (statement.count === undefined) {
      return `${context} states "${statement.phrase}", which names no count, while the shipped registry carries ${String(expectedCount)} templates`
    }
    if (statement.count !== expectedCount) {
      return `${context} states "${statement.phrase}", but the shipped registry carries ${String(expectedCount)} templates`
    }
    return ''
  }).filter(line => line !== '')
}

/**
 * Check that a tool's enumerated ids and stated template counts match the
 * shipped template registry.
 * @param catalogSource - text of `docs/tool-catalog.md`.
 * @param expectedIds - the ids the tool ships; defaults to the exported registry.
 * @param tool - the tool whose description states the count.
 * @returns one diagnostic per mismatch, or per section that no longer states or enumerates the count.
 */
export function findTemplateCountViolations(
  catalogSource: string,
  expectedIds: readonly string[] = TEMPLATE_IDS,
  tool: string = TEMPLATE_COUNT_TOOL,
): string[] {
  const section = catalogToolSection(catalogSource, tool)
  if (section === undefined) return [`${CATALOG_PATH}: no \`${tool}\` section to check`]
  const ids = templateEnumIds(section)
  if (ids === undefined) return [`${CATALOG_PATH}: \`${tool}\` carries no template enum`]
  const violations: string[] = []
  const missing = expectedIds.filter(id => !ids.includes(id))
  const unexpected = ids.filter(id => !expectedIds.includes(id))
  if (missing.length > 0 || unexpected.length > 0) {
    const detail = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected ${unexpected.join(', ')}` : '',
    ].filter(part => part !== '').join('; ')
    violations.push(`${CATALOG_PATH}: \`${tool}\` enumerates template ids that differ from the shipped registry (${detail})`)
  }
  violations.push(
    ...findTemplateStatementViolations(section, expectedIds.length, `${CATALOG_PATH}: \`${tool}\``),
  )
  return violations
}

/**
 * Collect the tool-shaped names of one file.
 * @param source - the file text.
 * @returns every backticked lowercase snake_case name carrying an underscore.
 */
export function toolReferences(source: string): ToolReference[] {
  const references: ToolReference[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]*)`/gu)) {
      references.push({ line: index + 1, name: match[1] as string })
    }
  }
  return references
}

/**
 * One tool name a preset's gate declaration names.
 *
 * A gate that names a tool no mounted package registers is the worst shape a
 * declaration can take: it denies the guarded call in every session while every
 * other check stays green, because the name is valid YAML and a valid string.
 * These names therefore resolve against the mounted set too, not just the
 * backticked prose references.
 */
export interface GateToolReference {
  /** The declaration that named it, e.g. `deliveryGate.requires`. */
  readonly source: string
  /** The tool name. */
  readonly name: string
}

/**
 * Collect the tool names one preset's gate declarations name: the tool a
 * delivery gate guards, the prerequisites it requires, and the tool a
 * structural gate guards.
 * @param presetSource - the preset YAML text.
 * @returns every gate-declared tool name, in declaration order.
 */
export function gateToolReferences(presetSource: string): GateToolReference[] {
  const references: GateToolReference[] = []
  const push = (source: string, value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) references.push({ source, name: value })
  }
  const gatesOf = (record: Record<string, unknown>, key: string): Record<string, unknown>[] => {
    const declared = record[key]
    if (!Array.isArray(declared)) return []
    return declared.filter((gate): gate is Record<string, unknown> => typeof gate === 'object' && gate !== null)
  }
  for (const record of presetRowRecords(presetSource)) {
    for (const gate of gatesOf(record, 'deliveryGate')) {
      push('deliveryGate.tool', gate.tool)
      for (const required of Array.isArray(gate.requires) ? gate.requires : []) {
        push('deliveryGate.requires', required)
      }
    }
    for (const gate of gatesOf(record, 'structuralGate')) push('structuralGate.tool', gate.tool)
  }
  return references
}

/**
 * Check every backticked tool reference in a preset corpus.
 * @param catalogSource - text of `docs/tool-catalog.md`.
 * @param corpus - one entry per shipped preset.
 * @param exemptReferences - exempt names, each mapped to its reason.
 * @returns one diagnostic per name no mounted tool and no exemption accounts for.
 */
export function findToolRefViolations(
  catalogSource: string,
  corpus: readonly PresetCorpus[],
  exemptReferences: ReadonlyMap<string, string> = EXEMPT_REFERENCES,
): string[] {
  const catalog = parseToolCatalog(catalogSource)
  if (catalog.size === 0) throw new Error('verify-preset-tool-refs: the tool catalog carries no package rows')
  const violations: string[] = []
  for (const entry of corpus) {
    const mounted = mountedToolNames(entry.presetFile.source, catalog)
    for (const file of [entry.presetFile, ...entry.readmeFiles, ...entry.skillFiles]) {
      for (const reference of toolReferences(file.source)) {
        if (mounted.has(reference.name) || exemptReferences.has(reference.name)) continue
        // A stage id is not a tool: skill text names stages to say which part of a
        // manifest a member verifies. Manifests own that vocabulary, so the set is
        // derived rather than exempted name by name.
        if (isStageId(reference.name)) continue
        violations.push(
          `${file.path}:${String(reference.line)}: \`${reference.name}\` is not a tool preset ${entry.preset} mounts`,
        )
      }
    }
    for (const reference of gateToolReferences(entry.presetFile.source)) {
      if (mounted.has(reference.name)) continue
      violations.push(
        `${entry.presetFile.path}: ${reference.source} names ${reference.name}, which preset ${entry.preset} does not mount`,
      )
    }
  }
  return violations
}

/**
 * Load every shipped preset with the README pair and skill files that belong to it.
 * @param root - repository root.
 * @returns one corpus entry per preset, in path order.
 * @throws Error when a README or a skills directory has no matching preset.
 */
export function loadPresetCorpus(root: string): PresetCorpus[] {
  const presetRoot = resolve(root, PRESET_DIR)
  const skillRoot = resolve(root, SKILL_DIR)
  const presetFiles = readdirSync(presetRoot).filter(file => file.endsWith('.patch.yml')).sort()
  const presetNames = new Set(presetFiles.map(file => file.replace(/\.patch\.yml$/u, '')))
  const readmes = readdirSync(presetRoot).filter(file => file.endsWith('.md')).sort()
  const orphanReadmes = readmes.filter(file => !presetNames.has(file.replace(/(?:\.zh)?\.md$/u, '')))
  if (orphanReadmes.length > 0) {
    throw new Error(`verify-preset-tool-refs: README(s) without a preset: ${orphanReadmes.join(', ')}`)
  }
  const skillDirs = existsSync(skillRoot)
    ? readdirSync(skillRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    : []
  const orphans = skillDirs.filter(directory => !presetNames.has(directory))
  if (orphans.length > 0) {
    throw new Error(`verify-preset-tool-refs: skills director(ies) without a preset: ${orphans.join(', ')}`)
  }
  return presetFiles.map((file) => {
    const preset = file.replace(/\.patch\.yml$/u, '')
    const presetPath = `${PRESET_DIR}/${file}`
    const readmeFiles = readmes
      .filter(readme => readme === `${preset}.md` || readme === `${preset}.zh.md`)
      .map(readme => `${PRESET_DIR}/${readme}`)
      .map(path => ({ path, source: readFileSync(resolve(root, path), 'utf8') }))
    const skillFiles = globSync(`${SKILL_DIR}/${preset}/**/*.md`, { cwd: root }).sort().map(path => ({
      path,
      source: readFileSync(resolve(root, path), 'utf8'),
    }))
    return {
      preset,
      presetFile: { path: presetPath, source: readFileSync(resolve(root, presetPath), 'utf8') },
      readmeFiles,
      skillFiles,
    }
  })
}

/**
 * Total the tool counts the corpus READMEs state.
 * @param corpus - one entry per shipped preset.
 * @returns the declared count total.
 * @throws Error when the corpus carries READMEs but states no tool count.
 */
export function declaredCountTotal(corpus: readonly PresetCorpus[]): number {
  const readmeFiles = corpus.reduce((sum, entry) => sum + entry.readmeFiles.length, 0)
  const declared = corpus.reduce(
    (sum, entry) => sum + entry.readmeFiles.reduce(
      (fileSum, file) => fileSum + declaredToolCounts(file.source).length,
      0,
    ),
    0,
  )
  if (readmeFiles > 0 && declared === 0) {
    throw new Error('verify-preset-tool-refs: the shipped preset READMEs state no tool counts')
  }
  return declared
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const corpus = loadPresetCorpus(ROOT)
  const catalogSource = readFileSync(resolve(ROOT, CATALOG_PATH), 'utf8')
  const descriptionSource = readFileSync(resolve(ROOT, TEMPLATE_DESCRIPTION_PATH), 'utf8')
  const references = corpus.reduce(
    (sum, entry) => sum
      + [entry.presetFile, ...entry.readmeFiles, ...entry.skillFiles]
        .reduce((fileSum, file) => fileSum + toolReferences(file.source).length, 0)
      + gateToolReferences(entry.presetFile.source).length,
    0,
  )
  if (corpus.length === 0 || references === 0) {
    throw new Error('verify-preset-tool-refs: the shipped preset corpus scanned empty')
  }
  const declaredCounts = declaredCountTotal(corpus)
  const violations = [
    ...findToolRefViolations(catalogSource, corpus),
    ...findToolCountViolations(catalogSource, corpus),
    ...findTemplateCountViolations(catalogSource, TEMPLATE_IDS),
    ...findTemplateStatementViolations(descriptionSource, TEMPLATE_IDS.length, `${TEMPLATE_DESCRIPTION_PATH}:`),
  ]
  if (violations.length > 0) {
    process.stderr.write('verify-preset-tool-refs: violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `verify-preset-tool-refs: ${String(references)} reference(s) across ${String(corpus.length)} preset(s) resolve; `
    + `${String(declaredCounts)} declared tool count(s) and the ${TEMPLATE_COUNT_TOOL} template count match.\n`,
  )
}
