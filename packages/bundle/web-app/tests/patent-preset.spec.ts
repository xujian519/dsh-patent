/**
 * The `patent` preset pairs each service-providing row with the consumer that
 * reads it: `patent-data` publishes `patentData` and `patent-tools` reads it
 * when it builds the PDF-download channel. Both sit in one entry-local isolate
 * realm, which is what makes the consumer resolve this mount's instance.
 *
 * The 2026-09-21 audit found `patent_pdf_download` failing every call in this
 * deployment because the consumer had read `ctx.get('patentData')` during its own
 * apply(), one dependency hop before that service activates; the wiring now
 * resolves the service per call. This spec keeps the pairing itself from
 * disappearing silently — a preset that drops, renames, or disables either row,
 * or names a package this workspace does not contain, fails here rather than at
 * the first download attempt.
 *
 * The preset is this bundle's own `presets/patent.patch.yml`, so the spec reads
 * the file it ships and unwraps the declaration the patch inserts.
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
/** The bundle's shipped `patent` preset declaration. */
const PATENT_PRESET = join(REPO_ROOT, 'packages/bundle/web-app/presets/patent.patch.yml')
/** The directory holding the skills the `patent` preset ships. */
const PATENT_SKILLS = join(REPO_ROOT, 'packages/bundle/web-app/skills/patent')
/**
 * The dsh installation's manifest. The profile resolution table seeds its
 * package list from this manifest's declared dependency closure, so a host row
 * outside that closure has no table entry to import through.
 */
const INSTALLATION_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
/** The bundle shipping this preset; its closure joins the table when selected. */
const BUNDLE_ANCHOR = join(REPO_ROOT, 'packages/bundle/web-app/package.json')

/**
 * Literal endpoints of the deployment's cnlaw legal base. The persona and the
 * skills address that base through the declaration section `dsh-patent-law`
 * renders from Config, so a port spelled out here would tell the model to use
 * an endpoint its deployment never declared.
 */
const CNLAW_ENDPOINT_LITERAL = /(?:127\.0\.0\.1|localhost)(?::\d+)?|:(?:8100|8001|7687)\b|\b(?:8100|8001|7687)\b/gu

/** Every cnlaw endpoint literal in one text, for the assertion to report. */
function cnlawEndpointLiterals(text: string): string[] {
  return text.match(CNLAW_ENDPOINT_LITERAL) ?? []
}

/** One preset row, flattened out of its group nesting. */
interface PresetRow {
  id?: unknown
  name?: unknown
  disabled?: unknown
  parent?: string
  /** Group rows carry their isolate realm keys here. */
  isolate?: Record<string, unknown>
  /** A row's own config: an array for a group, an object for a configured row. */
  config?: unknown
}

/** The `insert`ed declaration row this spec reads the child composition from. */
interface DeclarationRow {
  name?: unknown
  config?: { id?: unknown; plugins?: unknown }
}

/** One `deliveryGate` evidence condition as the `patent` preset declares it. */
interface DeliveryEvidenceDeclaration {
  field?: string
  equals?: string | boolean | string[]
  minItems?: number
}

/** One `deliveryGate` entry as the `patent` preset declares it. */
interface DeliveryGateDeclaration {
  tool?: string
  requires?: string[]
  whenArgs?: { template?: string[] }
  evidence?: Record<string, DeliveryEvidenceDeclaration[]>
}

/** One `structuralGate` entry as the `patent` preset declares it. */
interface StructuralGateDeclaration {
  tool?: string
  textArgs?: string[]
  ruleIds?: string[]
  whenArgs?: { template?: string }
  strict?: boolean
}

/** The persona text a row declares, or `''` when the row carries none. */
function personaPrefix(row: PresetRow | undefined): string {
  const config = row?.config
  if (typeof config !== 'object' || config === null) return ''
  const prefix = 'prefix' in config ? config.prefix : undefined
  return typeof prefix === 'string' ? prefix : ''
}

/** Flatten a preset's entry list, keeping each row's enclosing group id. */
function flattenRows(entries: unknown[], parent?: string): PresetRow[] {
  const rows: PresetRow[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as PresetRow & { config?: unknown }
    rows.push({ ...row, ...(parent === undefined ? {} : { parent }) })
    if (Array.isArray(row.config)) {
      rows.push(...flattenRows(row.config, typeof row.id === 'string' ? row.id : parent))
    }
  }
  return rows
}

/** Read the `patent` declaration's rows out of the bundle's patch file. */
async function patentRows(): Promise<PresetRow[]> {
  const source = await readFile(PATENT_PRESET, 'utf8')
  const entries: unknown = yaml.load(source, { schema: entryListSchema })
  if (!Array.isArray(entries)) throw new TypeError('the patent preset patch must contain a Cordis entry list')
  const inserted: unknown[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const insert = (entry as { insert?: unknown }).insert
    if (Array.isArray(insert)) for (const row of insert) inserted.push(row)
  }
  const declaration = inserted.find((entry): entry is DeclarationRow => {
    const row = entry as DeclarationRow
    return row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === 'patent'
  })
  const plugins = declaration?.config?.plugins
  if (!Array.isArray(plugins)) throw new TypeError('the patent preset patch must declare the `patent` preset with a plugin list')
  return flattenRows(plugins)
}

/** The shipped `deepseek-official` model catalog source (the adapter's default list). */
const DEEPSEEK_CATALOG = join(REPO_ROOT, 'packages/llm/llm-deepseek/src/models.ts')

/** Catalog text used to pin the entry-scoped extractor below. */
const CATALOG_FIXTURE = [
  'export const DEFAULT_MODELS = [',
  '  {',
  "    id: 'alpha',",
  "    inputModalities: ['text'],",
  '  },',
  '  {',
  "    id: 'beta',",
  "    inputModalities: ['text', 'image'],",
  '  },',
  ']',
].join('\n')

/**
 * The `inputModalities` an entry declares in one catalog source, or null when the
 * catalog has no such entry. Entries are brace-delimited object literals; the
 * extraction is scoped to one entry so a neighbouring model's modalities cannot
 * satisfy the preset's requirement.
 * @param source - catalog source text.
 * @param id - model id to look up.
 * @returns the declared modalities, or null when the id is absent.
 */
function imageModalitiesIn(source: string, id: string): string[] | null {
  for (const match of source.matchAll(/\{\s*\n\s*id:\s*'([^']+)'([\s\S]*?)\n\s*\}/g)) {
    if (match[1] !== id) continue
    const declared = /inputModalities:\s*\[([^\]]*)\]/.exec(match[2] ?? '')
    return (declared?.[1] ?? '').split(',').map(part => part.trim().replace(/'/g, '')).filter(part => part !== '')
  }
  return null
}

/** Modalities the shipped `deepseek-official` catalog declares for one model id. */
function shippedCatalogModalities(id: string): string[] | null {
  return imageModalitiesIn(readFileSync(DEEPSEEK_CATALOG, 'utf8'), id)
}

/** Every package name this workspace contains. */
function workspacePackageNames(): Set<string> {
  const names = new Set<string>()
  for (const relative of globSync('packages/*/*/package.json', { cwd: REPO_ROOT })) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as { name?: string }
    if (typeof manifest.name === 'string') names.add(manifest.name)
  }
  return names
}

/** The isolate realm keys declared by the patent group. */
function patentRealmKeys(rows: PresetRow[]): string[] {
  const group = rows.find(row => row.id === 'patent' && row.parent === undefined)
  return Object.keys(group?.isolate ?? {})
}

/** The package part of a row name: scoped rows may append a subpath slot. */
function packageOf(name: string): string {
  const segments = name.split('/')
  return name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] as string
}

/**
 * Every workspace package name mapped to its manifest path. The closure walks
 * below read manifests rather than built entry points, the way the profile
 * resolution table does, so the checks hold on an unbuilt tree as well.
 * @returns Workspace package names and their `package.json` paths.
 */
function workspaceManifests(): Map<string, string> {
  const manifests = new Map<string, string>()
  const patterns = [
    'packages/*/*/package.json',
    'vendor/*/package.json',
    'apps/*/package.json',
    'native/system/package.json',
    'native/system/packages/*/package.json',
  ]
  for (const pattern of patterns) {
    for (const relative of globSync(pattern, { cwd: REPO_ROOT })) {
      const path = join(REPO_ROOT, relative)
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }
      if (typeof manifest.name === 'string') manifests.set(manifest.name, path)
    }
  }
  return manifests
}

/**
 * Whether `name` is reachable from `anchor` through declared `dependencies`
 * and `peerDependencies`, the way the profile resolution table seeds itself
 * before any plugin import. The walk stays inside the workspace map: reaching
 * a row through an external package is not a path the installation offers.
 * @param anchor - Absolute manifest path the walk starts from.
 * @param name - Package name to find in the anchor's declared closure.
 * @param manifests - Workspace name-to-manifest map.
 * @returns true when the anchor's declared closure contains the name.
 */
function withinInstallationClosure(anchor: string, name: string, manifests: ReadonlyMap<string, string>): boolean {
  const seen = new Set<string>()
  const queue = [anchor]
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const manifest = JSON.parse(readFileSync(current, 'utf8')) as {
      dependencies?: Record<string, unknown>
      peerDependencies?: Record<string, unknown>
    }
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
    for (const dependency of declared) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      if (dependency === name) return true
      const next = manifests.get(dependency)
      if (next !== undefined) queue.push(next)
    }
  }
  return false
}

describe('patent preset composition', () => {
  it('names only packages this workspace contains', async () => {
    const known = workspacePackageNames()
    const unknown = (await patentRows())
      .map(row => row.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
      .map(packageOf)
      .filter(name => !known.has(name))
    expect(unknown).toEqual([])
  })

  it('resolves every row package from an anchor the runtime carries', async () => {
    // A workspace package can still sit outside the declared closures the
    // profile resolution table seeds from — the installation's and the
    // selected bundles'. The mount then reports the row as "never started"
    // and the whole preset refuses to activate at session creation.
    const manifests = workspaceManifests()
    const unresolved = (await patentRows())
      .map(row => row.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
      .map(packageOf)
      .filter(name => !withinInstallationClosure(INSTALLATION_ANCHOR, name, manifests)
        && !withinInstallationClosure(BUNDLE_ANCHOR, name, manifests))
    expect([...new Set(unresolved)]).toEqual([])
  })

  it('keeps the patent-data provider and its consumer enabled in one realm', async () => {
    const rows = await patentRows() as Array<PresetRow & { config?: { nuoRequestChannel?: unknown; cniprEnabled?: unknown } }>
    const provider = rows.find(row => row.id === 'patent-data')
    const consumer = rows.find(row => row.id === 'patent-tools')

    expect(provider?.name).toBe('@deepseek-ai/dsh-patent-data')
    expect(consumer?.name).toBe('@deepseek-ai/dsh-patent-tools')
    expect(provider?.disabled).toBeUndefined()
    expect(consumer?.disabled).toBeUndefined()
    // Same enclosing group: a consumer outside the realm resolves the host's
    // registry instead of this mount's instance.
    expect(provider?.parent).toBe(consumer?.parent)
    expect(provider?.parent).toBe('patent')
    expect(patentRealmKeys(rows)).toContain('patentData')
    // Keep the plain fetch first for directly connected hosts, and let the browser
    // recover searches when the connection layer fails (for example behind a
    // network policy that drops patents.google.com).
    expect(provider?.config?.nuoRequestChannel).toBe('fallback')
    // The preset is the deployment that uses the channel: it ships the ego lite login
    // this row's CNIPR channel reuses. A deployment without one leaves it off and keeps
    // its own channel instead.
    expect(provider?.config?.cniprEnabled).toBe(true)
  })

  it('enables the model-facing web tool with its fetch channel', async () => {
    const rows = await patentRows() as Array<PresetRow & { config?: { fetch?: unknown } }>
    const toolWeb = rows.find(row => row.id === 'tool-web')
    expect(toolWeb?.config?.fetch).toBe(true)
  })

  it('routes the team flow through the approval seam the persona names', async () => {
    // The persona and the team skill state the two decisions the user keeps (a team is
    // created and a case is closed only with the user); these two rows are what turns
    // them into refusals instead of instructions, so a deployment edit that drops them
    // would leave the discipline stated everywhere and enforced nowhere.
    const rows = await patentRows() as Array<PresetRow & { config?: { approveCreation?: unknown; approveClosure?: unknown } }>
    const row = rows.find(entry => entry.id === 'patent-teams')
    expect(row?.name).toBe('@deepseek-ai/dsh-patent-teams')
    expect(row?.disabled).toBeUndefined()
    expect(row?.config?.approveCreation).toBe(true)
    expect(row?.config?.approveClosure).toBe(true)
  })

  it('mounts the law index checker the fact-check gate calls', async () => {
    // The persona and the fact-check / quality-gate skills instruct the model to run
    // law_verify first; without this row the tool is absent from the session.
    const rows = await patentRows()
    const row = rows.find(entry => entry.id === 'patent-law')
    expect(row?.name).toBe('@deepseek-ai/dsh-patent-law')
    expect(row?.disabled).toBeUndefined()
  })

  it('mounts the TRIZ lookup tool routed for explicit parameter pairs', async () => {
    // The disclosure-understanding skill routes explicit improving/worsening
    // parameter pairs to `triz`; dropping this row leaves that route pointing at
    // a tool the session never registers.
    const rows = await patentRows()
    const row = rows.find(entry => entry.id === 'methodology')
    expect(row?.name).toBe('@deepseek-ai/dsh-methodology')
    expect(row?.disabled).toBeUndefined()
  })

  it('mounts the fee index tool the number gate calls', async () => {
    // patent-quality-gate item 4 and the persona require the fee amounts to come from
    // patent_fees; without this row the model has no tool to price them with.
    const rows = await patentRows()
    const row = rows.find(entry => entry.id === 'patent-fees')
    expect(row?.name).toBe('@deepseek-ai/dsh-patent-fees')
    expect(row?.disabled).toBeUndefined()
  })

  it('gates a delivery render on the gate runs and the round archival the persona requires', async () => {
    // The delivery discipline also lives in the persona prefix; this declaration is
    // what makes it an execution point. A required tool whose package the preset does
    // not mount, or a template id the renderer does not ship, leaves a gate that looks
    // armed and never fires.
    const rows = await patentRows()
    const row = rows.find(entry => entry.id === 'patent-rule')
    const gate = (row?.config as { deliveryGate?: DeliveryGateDeclaration[] } | undefined)?.deliveryGate ?? []
    expect(gate).toHaveLength(10)

    const compliance = gate.find(entry => entry.tool === 'render_patent_document'
      && entry.requires?.includes('matter_log_append') === true)
    expect(compliance?.requires).toEqual(['rule_check', 'law_verify', 'matter_log_append'])
    // A zero-byte rule check reports an empty `evaluated` list; the gate requires the
    // identity of the text actually read.
    expect(compliance?.evidence?.rule_check).toEqual([{ field: 'evaluated', minItems: 1 }])

    // The DOCX that goes to the office is a deliverable too, and it carries no argument
    // to narrow a gate on, so its entry applies to the tool unconditionally.
    const filing = gate.find(entry => entry.tool === 'build_patent_filing')
    expect(filing?.requires).toEqual(['rule_check', 'law_verify', 'matter_log_append'])
    expect(filing?.whenArgs).toBeUndefined()
    expect(filing?.evidence?.rule_check).toEqual([{ field: 'evaluated', minItems: 1 }])

    // Citation-bearing deliverables require a law_verify run that actually recognized
    // at least one citation; an application document or form may legitimately cite none.
    const citation = gate.find(entry => entry.requires?.length === 1 && entry.requires[0] === 'law_verify')
    expect(citation?.evidence?.law_verify).toEqual([{ field: 'findings', minItems: 1 }])
    expect(citation?.whenArgs?.template).toContain('oa-response')
    expect(citation?.whenArgs?.template).not.toContain('claims-spec')
    expect(citation?.whenArgs?.template).not.toContain('search-report-form')

    const closures = gate.filter(entry => entry.requires?.includes('patent_workflow_run') === true)
    expect(closures).toHaveLength(7)
    const closure = (template: string): DeliveryGateDeclaration | undefined =>
      closures.find(entry => entry.whenArgs?.template?.includes(template) === true)
    expect(closure('oa-response')?.evidence?.patent_workflow_run).toEqual([
      { field: 'ok', equals: true },
      { field: 'manifestId', equals: 'patent_oa_response_v1' },
    ])
    expect(closure('claims-spec')?.evidence?.patent_workflow_run).toEqual([
      { field: 'ok', equals: true },
      { field: 'manifestId', equals: 'patent_disclosure_v1' },
    ])
    for (const entry of closures) {
      expect(entry.tool).toBe('render_patent_document')
      expect(entry.requires).toEqual(['patent_workflow_run'])
      expect(entry.evidence?.patent_workflow_run).toContainEqual({ field: 'ok', equals: true })
      expect(entry.evidence?.patent_workflow_run?.some(requirement => requirement.field === 'manifestId'))
        .toBe(true)
    }

    // Every gated tool, and every tool a gate requires, comes from a build package this
    // preset enables: rule_check, patent_workflow_run and matter_log_append from
    // patent-tools, law_verify from patent-law, and the two gated tools from
    // patent-document and patent-filing. A prerequisite no mounted package registers is
    // the worst shape a gate can take: it denies every delivery forever while every
    // other check stays green, which is why scripts/verify-preset-tool-refs also
    // resolves these names against the mounted tool set.
    for (const id of ['patent-tools', 'patent-law', 'patent-document', 'patent-filing']) {
      const mounted = rows.find(entry => entry.id === id)
      expect(mounted?.name).toBe(`@deepseek-ai/dsh-${id}`)
      expect(mounted?.disabled).toBeUndefined()
    }

    // Every gated template is one the renderer ships. The closure entry covers the
    // analysis templates plus claims-spec, whose disclosure manifest ends in a claims
    // draft; rectification-response has no manifest entry and stays out, and so does
    // right-evaluation-report, whose transcription use has no analysis to close.
    const catalog = JSON.parse(readFileSync(
      join(REPO_ROOT, 'packages/patent/patent-document/assets/templates/patent/manifest.json'),
      'utf8',
    )) as { templates?: string[] }
    const shippedTemplates = catalog.templates ?? []
    const closureTemplates = closures.flatMap(entry => entry.whenArgs?.template ?? []).sort()
    expect(closureTemplates).toHaveLength(11)
    expect(closureTemplates.filter(template => !shippedTemplates.includes(template))).toEqual([])
    expect(closureTemplates).toContain('claims-spec')
    expect(closureTemplates).toContain('search-report-form')
    expect(closureTemplates).not.toContain('rectification-response')
    expect(closureTemplates).not.toContain('right-evaluation-report')
  })

  it('arms the artifact structural gate on the 26.3 criteria rule the rule assets ship', async () => {
    // The structural gate denies a render before it runs; PR-OA-007 must exist in
    // the shipped rule assets and stay block-level, or the declaration looks armed
    // and never fires. This is the first rule that enters through render arguments.
    // `strict` is what turns that mismatch into a load failure: without it a
    // renamed rule asset only warns and drops the entry.
    const rows = await patentRows()
    const row = rows.find(entry => entry.id === 'patent-rule')
    const gate = (row?.config as { structuralGate?: StructuralGateDeclaration[] } | undefined)?.structuralGate
    expect(gate).toHaveLength(1)
    const [artifact] = gate ?? []
    expect(artifact?.tool).toBe('render_patent_document')
    expect(artifact?.whenArgs).toEqual({ template: 'oa-response' })
    expect(artifact?.textArgs).toEqual(['draft'])
    expect(artifact?.ruleIds).toEqual(['PR-OA-007'])
    expect(artifact?.strict).toBe(true)
    const ruleAssets = yaml.load(readFileSync(
      join(REPO_ROOT, 'packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml'),
      'utf8',
    )) as { rules?: Record<string, { id?: string; action?: string }> }
    const shipped = new Map(Object.values(ruleAssets.rules ?? {}).map(rule => [rule.id, rule.action]))
    for (const ruleId of artifact?.ruleIds ?? []) {
      expect(shipped.get(ruleId), `structuralGate.${ruleId} 未随规则资产以 block 级发布`).toBe('block')
    }
  })

  it('states the team-channel discipline from the mounting rows, not an unrecorded test', async () => {
    // The mode excluded the generic send_message while quoting an observation
    // ("实测直接报「active teammate … not found」") that no file recorded and that
    // no shipped combination reproduces by construction: the preset does not mount
    // the agent-team package, and the generic name is registered by
    // subagent-control against managed subagents. The reason is checkable here.
    const rows = await patentRows()
    const named = rows.filter((row): row is PresetRow & { name: string } => typeof row.name === 'string')
    const mounted = named.map(row => packageOf(row.name))
    expect(mounted).not.toContain('@deepseek-ai/dsh-tool-agent-team')
    expect(mounted).toContain('@deepseek-ai/dsh-tool-subagent-control')
    const skill = readFileSync(join(PATENT_SKILLS, 'patent-team-composition', 'SKILL.md'), 'utf8')
    const discipline = skill.split('\n').find(line => line.includes('patent_teams_send_message'))
    expect(discipline, 'the skill must keep the team-coordination channel discipline').toBeDefined()
    expect(discipline).toContain('@deepseek-ai/dsh-tool-subagent-control')
    expect(discipline).not.toContain('实测')
  })

  it('keeps patent deliverables on the controlled-draft channel only', () => {
    // The 2026-10-10 scan found the same five document names in two template
    // systems: @deepseek-ai/dsh-doc-template's variable-substitution assets and
    // this preset's controlled-draft templates. The patent-report assets were
    // removed and the controlled draft is the only content source, so a name
    // reappearing on both sides is a regression this case catches.
    const docTemplateNames = globSync('packages/document/doc-template/assets/templates/**/*.md', { cwd: REPO_ROOT })
      .map(relative => /^name:\s*(\S+)\s*$/mu.exec(readFileSync(join(REPO_ROOT, relative), 'utf8'))?.[1])
      .filter((name): name is string => name !== undefined)
    const controlledDraftTemplates = (JSON.parse(readFileSync(
      join(REPO_ROOT, 'packages/patent/patent-document/assets/templates/patent/manifest.json'),
      'utf8',
    )) as { templates?: string[] }).templates ?? []
    expect(docTemplateNames.length).toBeGreaterThan(0)
    expect(controlledDraftTemplates.length).toBeGreaterThan(0)
    expect(docTemplateNames.filter(name => controlledDraftTemplates.includes(name))).toEqual([])
  })

  it('sends the model to the cnlaw declaration instead of a literal endpoint', async () => {
    // The base's endpoints are deployment Config, rendered into the prompt by
    // dsh-patent-law; a port spelled out here would survive a deployment that
    // moved or did not mount the base.
    const text = personaPrefix((await patentRows()).find(row => row.id === 'persona'))
    expect(text).toContain('cnlaw 声明段')
    expect(cnlawEndpointLiterals(text)).toEqual([])
  })

  it('keeps the evidence check and the conditional figure route the zero-call audit added', async () => {
    // The 2026-10-03 zero-call audit gave evaluate_evidence its first route and
    // narrowed add_patent_figure_references to self-drawn or external SVG input.
    // The audit's first route is still persona text; the figure route and the
    // index backing search_patent_figure now sit in the skills the persona points
    // at, so this asserts over the mode's whole model-visible text — a rewrite
    // that drops either rule leaves every other gate green.
    const voice = await patentVoice()
    expect(voice).toContain('`evaluate_evidence`')
    expect(voice).toContain('自绘或外部来源的 SVG')
    expect(voice).toContain('`.sati/figures-index.json`')
    // The persona states the model's task; the guard's name and wiring are
    // deployment implementation detail, not prompt content (packages/AGENTS.md).
    expect(personaPrefix((await patentRows()).find(row => row.id === 'persona'))).not.toContain('EVI-011')
  })

  it('names a figure-analysis route the shipped catalog declares image-capable', async () => {
    // analyze_patent_figure is gated on the route's DECLARED input modalities, and an
    // uncatalogued model is treated as text-only. A preset naming a route the shipped
    // catalog does not declare with "image" denies every figure-analysis call — the
    // 2026-09-28 incident. The catalog below is the one this bundle's deployments get.
    const rows = await patentRows() as Array<PresetRow & { config?: { imageModel?: { provider?: unknown; model?: unknown } } }>
    const route = rows.find(row => row.id === 'patent-tools')?.config?.imageModel
    expect(route?.provider).toBe('deepseek-official')
    const model = String(route?.model)
    const declared = shippedCatalogModalities(model)
    expect(declared, `deepseek-official catalog has no entry for ${model}`).not.toBeNull()
    expect(declared, `catalog entry ${model} must declare image input`).toContain('image')
  })

  it('reports an image modality only for the model it belongs to', () => {
    // The extractor above passes on a catalog whose entries all declare image only if it
    // actually scopes to one entry; this fixture pins that scoping.
    expect(imageModalitiesIn(CATALOG_FIXTURE, 'alpha')).toEqual(['text'])
    expect(imageModalitiesIn(CATALOG_FIXTURE, 'beta')).toEqual(['text', 'image'])
    expect(imageModalitiesIn(CATALOG_FIXTURE, 'gamma')).toBeNull()
  })

  it('states no cnlaw endpoint literal in the shipped patent skills', () => {
    const offenders = globSync('**/*.md', { cwd: PATENT_SKILLS })
      .map(relative => ({ relative, hits: cnlawEndpointLiterals(readFileSync(join(PATENT_SKILLS, relative), 'utf8')) }))
      .filter(entry => entry.hits.length > 0)
      .map(entry => `${entry.relative}: ${entry.hits.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('reports a literal endpoint when one is present', () => {
    // The two assertions above pass on a corpus that has no endpoint only if this
    // detector actually finds one.
    expect(cnlawEndpointLiterals('curl -sG "http://127.0.0.1:8100/search" -d q=…'))
      .toEqual(['127.0.0.1:8100'])
    expect(cnlawEndpointLiterals('cnlaw 服务（:8001 图谱 + Neo4j 7687）')).toEqual([':8001', '7687'])
  })
})

/** The `patent` preset's own persona prefix, or `''` when the row carries none. */
async function patentPersona(): Promise<string> {
  return personaPrefix((await patentRows()).find(row => row.id === 'persona'))
}

/** The mode's shipped model-visible text: its persona prefix plus every bundled skill. */
async function patentVoice(): Promise<string> {
  const skills = globSync('**/*.md', { cwd: PATENT_SKILLS })
    .map(relative => readFileSync(join(PATENT_SKILLS, relative), 'utf8'))
  return [await patentPersona(), ...skills].join('\n')
}

/**
 * The persona's nine work disciplines, each anchored on the phrase that carries
 * its meaning. No recorded session replays the persona text and no other gate
 * reads it, so this list is what keeps a rewrite from dropping a discipline
 * quietly; adding or removing a discipline means editing this list.
 */
const PATENT_DISCIPLINES: readonly (readonly [string, string])[] = [
  ['检索先于结论', '检索先于结论'],
  ['单独对比与三步法', '单独对比原则'],
  ['法条引用核验', '`law_verify`'],
  ['逐特征比对', '逐特征比对'],
  ['输出即证据', '输出即证据'],
  ['HITL 确认点', 'HITL 确认点不可跳过'],
  ['无来源即撤回', '无来源即撤回'],
  ['指令即验收条件', '指令（验收条件）'],
  ['工具问题必须处置', '工具发现的问题必须处置'],
]

/** The disciplines whose anchor phrase `text` does not carry. */
function missingDisciplines(text: string): string[] {
  return PATENT_DISCIPLINES.filter(([, anchor]) => !text.includes(anchor)).map(([name]) => name)
}

describe('patent persona disciplines', () => {
  it('keeps every work discipline the persona states', async () => {
    expect(missingDisciplines(await patentPersona())).toEqual([])
  })

  it('reports a discipline when its anchor is absent', () => {
    // The case above passes on any persona only if the detector actually finds a
    // missing anchor.
    expect(missingDisciplines('')).toEqual(PATENT_DISCIPLINES.map(([name]) => name))
    expect(missingDisciplines('检索先于结论')).toEqual([
      '单独对比与三步法',
      '法条引用核验',
      '逐特征比对',
      '输出即证据',
      'HITL 确认点',
      '无来源即撤回',
      '指令即验收条件',
      '工具问题必须处置',
    ])
  })

  it('keeps the mandatory disclaimer verbatim', async () => {
    expect(await patentPersona()).toContain(
      '本分析由 AI 辅助生成，不构成正式法律意见。专利申请和专利性判断应由具备资质的专利代理人或专利律师确认。',
    )
  })
})

/**
 * The persona's work-mode routing. The team flow is opt-in — the default is
 * single-session execution scoped to what the user asked for — and the skill
 * that routing names carries the confirmation points a team must keep. No
 * recorded session replays the persona text, so these anchors are what keep a
 * rewrite from quietly making the team the default again.
 */
describe('patent work-mode routing', () => {
  it('defaults to the intent-driven flow and gates the team flow on a user instruction', async () => {
    const persona = await patentPersona()
    expect(persona).toContain('流程二 · 意图驱动（默认）')
    expect(persona).toContain('流程一 · 专利团队（需用户明确指示）')
    expect(persona).toContain('未获用户明确指示不得组建团队')
  })

  it('states the team trigger and the confirmation points in the skill it names', () => {
    const skill = readFileSync(join(PATENT_SKILLS, 'patent-team-composition', 'SKILL.md'), 'utf8')
    const description = /^description:\s*(.+)$/mu.exec(skill)?.[1] ?? ''
    // The description is what the model sees before loading the skill: a team
    // that reads as the standing route for complex cases gets built on that
    // reading alone.
    expect(description).toContain('仅在用户明确要求组队时使用')
    expect(skill).toContain('## 人工确认点（captain 不得单方收口）')
    expect(skill).toContain('组队方案先确认')
  })
})

/**
 * A patent case is date-bound: the deadlines, the annual-fee year, and the
 * renewal dates in a search report all follow from the filing and notice dates,
 * so the mode needs the clock row, and the reminders that follow those dates
 * need the schedule tools. `command-goal` pairs with `tool-goal` on the preset
 * plane — the web patch ships that row disabled and leaves the human command to
 * the preset — so mounting the tool without the command ships half the pair.
 * `scripts/preset-mode-baseline.json` holds every delivery mode to the shared
 * row set; this spec keeps the three rows named here from disappearing behind a
 * policy edit.
 */
describe('patent preset delivery rows', () => {
  it('mounts the clock, the reminder tools, and the goal command beside the goal tool', async () => {
    const rows = new Map((await patentRows()).flatMap(row => (typeof row.id === 'string' ? [[row.id, row] as const] : [])))
    for (const [id, name] of [
      ['time-context', '@deepseek-ai/dsh-time-context'],
      ['tool-schedule', '@deepseek-ai/dsh-tool-schedule'],
      ['command-goal', '@deepseek-ai/dsh-command-goal'],
      ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
    ] as const) {
      expect(rows.get(id)?.name, `${id} row`).toBe(name)
      expect(rows.get(id)?.disabled, `${id} row`).toBeUndefined()
    }
  })

  it('declares no per-child composition the delegation tool rejects', async () => {
    const rows = new Map((await patentRows()).flatMap(row => (typeof row.id === 'string' ? [[row.id, row] as const] : [])))
    for (const id of ['tool-subagent', 'tool-subagent-fork']) {
      const config = rows.get(id)?.config as { persona?: unknown; toolFilter?: unknown } | undefined
      // `dsh-tool-subagent` fails its mount on either field; a preset carrying
      // one can never compose a new Session in this mode.
      expect(config?.persona, `${id} persona`).toBeUndefined()
      expect(config?.toolFilter, `${id} toolFilter`).toBeUndefined()
    }
  })
})

/**
 * `presets/patent.md` names every skill the preset ships, and its count folds
 * into the prose a reader uses to size the delivery surface. The list and the
 * directory drifted apart once when a skill was added, so this case holds the
 * two together: an added, dropped, or renamed skill, or a count left at the old
 * number, fails here instead of shipping a guide that names a skill the loader
 * cannot find. The English count (`Sixteen skills ship …`) is prose the pairing
 * check covers with the rest of the guide, not a number this case can read back.
 */
describe('patent preset skill list', () => {
  /** The skill names `presets/patent.md` lists under its `## Skills` heading, in order. */
  function listedSkills(): string[] {
    const guide = readFileSync(join(REPO_ROOT, 'packages/bundle/web-app/presets/patent.md'), 'utf8')
    const start = guide.indexOf('\n## Skills\n')
    const end = guide.indexOf('\n## ', start + 1)
    const section = guide.slice(start, end === -1 ? undefined : end)
    return [...section.matchAll(/^- ([\w-]+)$/gmu)].map(match => match[1] ?? '')
  }

  /** The skill names the preset's skill directory ships. */
  function shippedSkills(): string[] {
    return globSync('*/SKILL.md', { cwd: PATENT_SKILLS }).map(relative => relative.replace(/[\\/]SKILL\.md$/u, ''))
  }

  /** Every name on one side of the comparison and not the other, as reported lines. */
  function skillListMismatches(listed: readonly string[], shipped: readonly string[]): string[] {
    const onDisk = new Set(shipped)
    const inGuide = new Set(listed)
    return [
      ...[...inGuide].filter(name => !onDisk.has(name)).map(name => `指南列出但目录没有：${name}`),
      ...[...onDisk].filter(name => !inGuide.has(name)).map(name => `目录有但指南未列：${name}`),
    ]
  }

  it('lists exactly the skills the directory ships', () => {
    expect(shippedSkills().length).toBeGreaterThan(0)
    expect(skillListMismatches(listedSkills(), shippedSkills())).toEqual([])
  })

  it('reports a name on either side alone', () => {
    // The case above passes on any list only if the comparison can fail.
    expect(skillListMismatches(['patent-ghost'], ['patent-invalidity'])).toEqual([
      '指南列出但目录没有：patent-ghost',
      '目录有但指南未列：patent-invalidity',
    ])
  })

  it('states that count wherever the Chinese guide gives one', () => {
    const chinese = readFileSync(join(REPO_ROOT, 'packages/bundle/web-app/presets/patent.zh.md'), 'utf8')
    const stated = [...chinese.matchAll(/(\d+) 个技能/gu)].map(match => Number(match[1]))
    expect(stated.length).toBeGreaterThan(0)
    expect(stated).toEqual(stated.map(() => listedSkills().length))
  })

  it('每个技能的 frontmatter 可解析且 name 与目录同名', () => {
    // A file the loader cannot parse is skipped with a log line, not an error, so a
    // skill whose frontmatter broke would be listed by the guide above and absent from
    // the session. The provider keys a skill by its declared `name`, which is why the
    // directory name is the thing to hold it to.
    const parsed = shippedSkills().map((skill) => {
      const file = readFileSync(join(PATENT_SKILLS, skill, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(file)?.[1]
      expect(frontmatter, `${skill}/SKILL.md 缺少 frontmatter`).toBeDefined()
      const fields = yaml.load(frontmatter ?? '') as { name?: unknown; description?: unknown }
      return { skill, name: fields.name, description: fields.description }
    })
    expect(parsed.filter(entry => entry.name !== entry.skill).map(entry => `${entry.skill} → ${String(entry.name)}`)).toEqual([])
    expect(parsed
      .filter(entry => typeof entry.description !== 'string' || entry.description.trim() === '')
      .map(entry => entry.skill)).toEqual([])
  })
})
