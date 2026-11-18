/**
 * The shipped `document` preset's rows mount for real.
 *
 * `document-preset.spec.ts` reads the preset as YAML and never activates it, so
 * a row that stops registering its tool — or a skill root whose `!!js` expression
 * resolves nowhere — would leave that spec green. This one loads
 * `presets/document.patch.yml` through the same overlay loader the profile boot
 * uses, evaluates the rows' skill-root expressions with the Loader's own
 * evaluator, and mounts the four rows a document delivery depends on over a
 * minimal host composition, so the tool catalog and the merged skill catalog are
 * the ones a document session actually gets. The Office row is asserted as a
 * declaration rather than mounted: it registers nothing until a model loads an
 * Office skill, and its `agents` / `workingDirectory` injections are not part of
 * the delivery composition this spec boots.
 *
 * The rows are taken from the preset file rather than copied: a copy would be a
 * second definition of the same 22 rows, and the shipped file is the thing whose
 * activation this spec exists to prove. Test-only overrides are limited to what a
 * deterministic mount needs (host skill roots off, watchers off, temporary homes);
 * the skill directory itself comes from the preset's own expression.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as DocTemplate from '@deepseek-ai/dsh-doc-template'
import * as DocumentDeliver from '@deepseek-ai/dsh-document-deliver'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
/** The bundle's shipped `document` preset declaration. */
const DOCUMENT_PRESET = join(REPO_ROOT, 'packages/bundle/web-app/presets/document.patch.yml')
/** The four rows a document delivery is built out of: the two tool rows and both skill roots. */
const DELIVERY_ROWS = ['tool-document-deliver', 'doc-template', 'skill-filesystem', 'skill-open-design'] as const
/** Tools those rows must put in the model's catalog. */
const DELIVERY_TOOLS = ['document_deliver', 'list_doc_templates', 'render_doc_template'] as const
/** The skills the first skill root ships. */
const DOCUMENT_SKILLS = [
  'document-brief', 'document-deck', 'document-html', 'document-report', 'document-word', 'document-quality-gate',
] as const

/** One preset row, flattened out of its declaration's `config.plugins`. */
interface PresetRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

/**
 * The rows the shipped document preset declares, in order.
 * @returns every row of the `preset-document` declaration's child composition.
 */
function documentRows(): PresetRow[] {
  const patch = loadOverlayPatches('document-composition-test', DOCUMENT_PRESET)
  const declaration = patch
    .flatMap(entry => entry.insert ?? [])
    .find(row => row.id === 'preset-document') as { config?: { plugins?: PresetRow[] } } | undefined
  const plugins = declaration?.config?.plugins
  if (plugins === undefined) throw new Error('document preset: the preset-document declaration carries no child composition')
  return plugins
}

/**
 * Row ids of `required` that `carried` lacks, in `required` order.
 *
 * Exported as a plain function so the negative control below runs the same
 * comparison the positive case relies on: a membership assertion that cannot
 * report a missing member would pass on an empty composition too.
 * @param carried - the row ids the composition carries.
 * @param required - the row ids it must carry.
 * @returns one entry per missing row id.
 */
function missingRows(carried: readonly string[], required: readonly string[]): string[] {
  const present = new Set(carried)
  return required.filter(id => !present.has(id))
}

/**
 * Rows the composition must carry, with the reason each is there.
 *
 * The reason is what a failed membership assertion reports, so a red run names
 * the row and what stops working without it.
 */
const REQUIRED_ROWS: readonly { readonly id: string; readonly purpose: string }[] = [
  { id: 'tool-document-deliver', purpose: 'document_deliver: the delivery registration + deterministic checks' },
  { id: 'doc-template', purpose: 'list_doc_templates / render_doc_template and the injected style guide' },
  { id: 'skill-filesystem', purpose: 'the six document skills, rooted at the bundle’s skills/document' },
  { id: 'skill-open-design', purpose: 'the optional OpenDesign skill provider (zero roots without OPEN_DESIGN_DIR)' },
  { id: 'tool-office', purpose: 'office_render / office_convert / office_recalculate once a globally visible Office skill is loaded' },
]

/**
 * Evaluate one row's `!!js` config nodes the way the Loader resolves an entry.
 *
 * `baseUrl` is the only value these expressions read from the scope: in a profile
 * it is the profile directory, which is how `createRequire(baseUrl)` resolves a
 * package the profile depends on. The repository root plays that role here, so
 * the resolved skill directory is the workspace's own bundle.
 * @param config - a row's config, as loaded from the preset.
 * @returns the config with every `!!js` node replaced by its value.
 */
function resolveConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (config === undefined) return {}
  return interpolate({ baseUrl: pathToFileURL(REPO_ROOT).href }, config) as Record<string, unknown>
}

/**
 * Run `body` with `OPEN_DESIGN_DIR` unset, then restore the variable.
 *
 * The OpenDesign row's expression reads the variable at evaluation time, which is
 * this call; a developer machine that has a checkout exported must still exercise
 * the shipped no-checkout case. The window is one synchronous call, so no other
 * spec observes the variable unset.
 * @param body - the work that evaluates the expression.
 * @returns whatever `body` returns.
 */
function withoutOpenDesign<T>(body: () => T): T {
  const previous = process.env['OPEN_DESIGN_DIR']
  delete process.env['OPEN_DESIGN_DIR']
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env['OPEN_DESIGN_DIR']
    else process.env['OPEN_DESIGN_DIR'] = previous
  }
}

/**
 * Read one skill row's resolved `customSkillDirs` as a path list.
 *
 * The row's config is `Record<string, unknown>` once interpolated, and the
 * expression's result is deployment input rather than a typed value, so the shape
 * is checked here instead of asserted.
 * @param value - the resolved `customSkillDirs` value.
 * @returns the root paths, in order.
 */
function asRootList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw new Error(`test setup: customSkillDirs resolved to ${JSON.stringify(value)}, not a path list`)
  }
  return value
}

/** Names a test-only mount maps to the module namespaces the Loader imports. */
const MODULES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
  ['@deepseek-ai/dsh-skill', SkillRegistry],
  ['@deepseek-ai/dsh-document-deliver', DocumentDeliver],
  ['@deepseek-ai/dsh-doc-template', DocTemplate],
  ['@deepseek-ai/dsh-skill-filesystem', SkillFileSystem],
])

/** One mount's context plus the temporary directory it owns. */
interface Mounted {
  readonly ctx: Context
  readonly cwd: string
}

/**
 * Mount the four delivery rows over a minimal host composition.
 *
 * Test-only overrides, both for determinism rather than behaviour: the skill rows
 * drop host roots and watchers (a watcher on the repository would outlive the
 * case and observe concurrent edits), and their homes point at a temporary
 * directory so the merged catalog is exactly what the preset ships.
 * @param without - row ids to leave out, so a case can prove what a row supplies.
 * @returns the mounted context; the caller disposes it.
 */
async function mountDeliveryRows(without: readonly string[] = []): Promise<Mounted> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-document-composition-'))
  const ctx = new Context()
  const rows = documentRows().filter(row => (DELIVERY_ROWS as readonly (string | undefined)[]).includes(row.id))
    .filter(row => !without.includes(row.id as string))
  const configured = rows.map(row => ({
    id: row.id,
    name: row.name,
    config: {
      ...withoutOpenDesign(() => resolveConfig(row.config)),
      ...row.name === '@deepseek-ai/dsh-skill-filesystem'
        ? { includeDefaultRoots: false, watch: false, dshHome: join(cwd, '.dsh'), agentsHome: join(cwd, '.agents') }
        : {},
    },
  }))
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd } },
    { id: 'skills', name: '@deepseek-ai/dsh-skill' },
    ...configured,
  ]))
  ctx.baseUrl = pathToFileURL(cwd).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('test setup: the Loader reports no module loader to stub')
  // Spread the real loader so every member the Loader reads stays in place; only
  // module resolution is replaced, keeping the test's own module namespaces.
  ctx.loader.internal = {
    ...internal,
    async import(specifier: string) {
      const module = MODULES.get(specifier)
      if (module === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
      return module
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, cwd }
}

it('mounts the delivery rows the shipped preset declares', async () => {
  const carried = documentRows().flatMap(row => row.id === undefined ? [] : [row.id])
  expect(missingRows(carried, REQUIRED_ROWS.map(row => row.id))).toEqual([])
  const skillRows = documentRows().filter(row => row.name === '@deepseek-ai/dsh-skill-filesystem')
  expect(skillRows.map(row => row.id).sort()).toEqual(['skill-filesystem', 'skill-open-design'])
})

it('reports the row a composition lacks', () => {
  // The positive case above passes on any list only if the comparison can fail.
  expect(missingRows(['tool-document-deliver', 'skill-filesystem', 'tool-office'], REQUIRED_ROWS.map(row => row.id)))
    .toEqual(['doc-template', 'skill-open-design'])
})

it('registers the three delivery tools and the six document skills', async () => {
  const { ctx, cwd } = await mountDeliveryRows()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(cwd, { recursive: true, force: true }) }
  })
  for (const name of DELIVERY_TOOLS) expect(ctx.tools.get(name), name).toBeDefined()
  expect((await ctx.skills.list()).map(skill => skill.name).sort()).toEqual([...DOCUMENT_SKILLS].sort())
})

it('takes the template tools away when the doc-template row is left out', async () => {
  // A membership assertion alone would pass on a composition that never mounts the
  // row's plugin; dropping the row here shows the tool names come from it.
  const { ctx, cwd } = await mountDeliveryRows(['doc-template'])
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(cwd, { recursive: true, force: true }) }
  })
  expect(ctx.tools.get('document_deliver')).toBeDefined()
  expect(ctx.tools.get('list_doc_templates')).toBeUndefined()
  expect(ctx.tools.get('render_doc_template')).toBeUndefined()
})

it('roots the document skill provider at the bundle directory and the OpenDesign provider at nothing', async () => {
  const rows = new Map(documentRows().map(row => [row.id, row]))
  const documentRoots = asRootList(withoutOpenDesign(() => resolveConfig(rows.get('skill-filesystem')?.config))['customSkillDirs'])
  expect(documentRoots).toEqual([join(REPO_ROOT, 'packages/bundle/web-app/skills/document')])
  const shipped = (await readdir(documentRoots[0] as string, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  expect(shipped).toEqual([...DOCUMENT_SKILLS].sort())
  // Without the checkout the OpenDesign row mounts an explicit empty catalog
  // rather than inheriting the shipped roots.
  const openDesignRoots = asRootList(withoutOpenDesign(() => resolveConfig(rows.get('skill-open-design')?.config))['customSkillDirs'])
  expect(openDesignRoots).toEqual([])
})
