/**
 * The document preset's model-visible text agrees with the code and with the
 * skills that teach it.
 *
 * No test pins the preset's persona or plan-mode section, so the four drift
 * classes this file covers survived review: a format the tool accepts but the
 * text never names, a plan-mode tail that split into two wordings, a style name
 * that a rename would split into two behaviour sets, and a skill or template
 * family the persona advertises while no skill teaches it. These are pure string
 * comparisons over the shipped files — no model call, no mount.
 *
 * The sets asserted are the facts the code already owns (`DELIVERABLE_FORMATS`,
 * the shipped style names, the shipped skill directories); the prose around them
 * stays free to be rewritten.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { DELIVERABLE_FORMATS, type DeliverableFormat } from '@deepseek-ai/dsh-document-deliver'
import { loadStyles, styleDirectories } from '@deepseek-ai/dsh-doc-style'
import { expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const PRESET_DIR = join(REPO_ROOT, 'packages/bundle/web-app/presets')
/** The preset whose text this file holds to the code. */
const DOCUMENT_PRESET = join(PRESET_DIR, 'document.patch.yml')
/** The skill directory the preset's first skill root points at. */
const DOCUMENT_SKILLS = join(REPO_ROOT, 'packages/bundle/web-app/skills/document')
/** The shared plan-mode tail starts here; everything from this line on is one text. */
const PLAN_TAIL_START = 'You are in plan mode.'
/**
 * Formats the persona and the plan section must not have to name: `other` is the
 * tool's escape hatch for a deliverable outside the enumerated list, so naming it
 * in model-facing prose would teach a format instead of an escape.
 */
const UNNAMED_FORMATS: readonly DeliverableFormat[] = ['other']
/**
 * How each deliverable format is written in prose. The aliases are what the text
 * may say; a format with no alias here fails the test below, which is how a new
 * `DELIVERABLE_FORMATS` entry forces the prose to name it.
 */
const FORMAT_ALIASES: Readonly<Record<DeliverableFormat, RegExp>> = {
  markdown: /Markdown/iu,
  html: /HTML/iu,
  pdf: /PDF/iu,
  docx: /Word|docx/iu,
  pptx: /PPTX|PowerPoint/iu,
  other: /other/iu,
}
/** Formats the tool does not accept; a persona that names one promises something no tool can do. */
const UNSUPPORTED_FORMATS = /\b(?:Excel|xlsx|CSV|RTF|EPUB|txt)\b/u
/** A hyphenated identifier, the shape every template-family and skill name takes. */
const KEBAB_TOKEN = /[a-z][a-z0-9]*(?:-[a-z0-9*]+)+/gu
/** The OpenDesign skill provider's own name, which is neither a skill nor a template family. */
const PROVIDER_NAME = 'open-design'

/** One preset row, flattened out of its group nesting. */
interface PresetRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly config?: unknown
}

/**
 * Find the row with `id` in a preset document, descending through every value.
 * @param node - a preset node, list, or scalar.
 * @param id - the row id to find.
 * @returns the row, or undefined when the document has no such row.
 */
function findRow(node: unknown, id: string): PresetRow | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRow(child, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const row = node as Record<string, unknown>
  if (row['id'] === id) return row
  for (const value of Object.values(row)) {
    const found = findRow(value, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Load one preset and return its rows by id.
 * @param path - absolute path of the preset patch file.
 * @returns a lookup over every row the file declares.
 */
async function rowsOf(path: string): Promise<(id: string) => PresetRow | undefined> {
  const source = await readFile(path, 'utf8')
  const document = parseEntryYaml(source)
  return (id: string) => findRow(document, id)
}

/**
 * One row's `config`, or an empty object when it declares none.
 * @param row - the row to read.
 * @returns the row's config object.
 */
function configOf(row: PresetRow | undefined): Record<string, unknown> {
  const config = row?.config
  return typeof config === 'object' && config !== null ? config as Record<string, unknown> : {}
}

/**
 * One string config field, or the empty string when the row does not carry it.
 * @param config - the row's config object.
 * @param key - the config key to read.
 * @returns the field's text.
 */
function textOf(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/**
 * The formats named in one text.
 * @param text - model-visible prose.
 * @returns the formats whose alias appears, in `DELIVERABLE_FORMATS` order.
 */
function namedFormats(text: string): DeliverableFormat[] {
  return DELIVERABLE_FORMATS.filter(format => FORMAT_ALIASES[format].test(text))
}

/**
 * The mode-specific preamble of one plan-mode section: everything before the
 * shared tail.
 *
 * The format enumeration lives here. The shared tail is identical across presets
 * and happens to contain the word "markdown" ("the complete plan markdown"), so
 * measuring the whole section would let a deleted enumeration entry pass on that
 * sentence.
 * @param section - a preset's `plan-mode` section text.
 * @returns the text before the shared marker.
 */
function planPreamble(section: string): string {
  const start = section.indexOf(PLAN_TAIL_START)
  return start === -1 ? section : section.slice(0, start)
}

/**
 * The shared plan-mode tail of one section.
 * @param section - a preset's `plan-mode` section text.
 * @returns everything from the shared marker to the end, or undefined when the section carries no tail.
 */
function planTail(section: string): string | undefined {
  const start = section.indexOf(PLAN_TAIL_START)
  return start === -1 ? undefined : section.slice(start).trimEnd()
}

/** Every skill directory the bundle ships, by name. */
async function shippedSkills(): Promise<string[]> {
  const entries = await readdir(DOCUMENT_SKILLS, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/** One skill's full text (frontmatter and body), read for the identifiers it mentions. */
async function skillTexts(skills: readonly string[]): Promise<string[]> {
  return Promise.all(skills.map(skill => readFile(join(DOCUMENT_SKILLS, skill, 'SKILL.md'), 'utf8')))
}

/**
 * Formats named in `text` that the tool accepts but the text omits.
 * @param text - model-visible prose.
 * @returns the accepted formats whose alias the text does not carry, `other` excluded.
 */
function unnamedFormats(text: string): DeliverableFormat[] {
  const named = new Set(namedFormats(text))
  return DELIVERABLE_FORMATS.filter(format => !UNNAMED_FORMATS.includes(format) && !named.has(format))
}

/**
 * The style-name disagreement among the three places that must name one style.
 * @param persona - the persona prefix.
 * @param styleGuide - `doc-template.styleGuide`.
 * @param defaultStyle - `tool-document-deliver.defaultStyle`.
 * @returns one description per disagreement; empty when all three agree and the persona names the style.
 */
function styleDisagreements(persona: string, styleGuide: string, defaultStyle: string): string[] {
  const findings: string[] = []
  if (styleGuide === '') findings.push('doc-template.styleGuide is empty')
  if (defaultStyle !== styleGuide) findings.push(`gate checks ${JSON.stringify(defaultStyle)}, guide injects ${JSON.stringify(styleGuide)}`)
  if (!persona.includes(styleGuide)) findings.push(`persona does not name ${JSON.stringify(styleGuide)}`)
  return findings
}

/**
 * Hyphenated `document-*` identifiers in one corpus that no shipped skill names.
 * @param texts - the persona and skill bodies.
 * @param shipped - the shipped skill directory names.
 * @returns each unknown identifier once, sorted.
 */
function unknownSkillTokens(texts: readonly string[], shipped: readonly string[]): string[] {
  const mentioned = new Set(texts.flatMap(text => text.match(KEBAB_TOKEN) ?? []))
  return [...mentioned].filter(token => token.startsWith('document-') && !shipped.includes(token)).sort()
}

/**
 * Template-family names the persona advertises that no skill teaches.
 *
 * A name is covered when some skill body contains it; a name written with a
 * trailing `*` names a family prefix, so any skill teaching one member covers it.
 * Skill names, shipped style names, and the provider name are identifiers of
 * other things and are skipped.
 * @param persona - the persona prefix.
 * @param corpus - every skill body, joined.
 * @param shipped - the shipped skill directory names.
 * @param styles - the shipped style names.
 * @returns each uncovered name, in appearance order.
 */
function orphanTemplateFamilies(
  persona: string, corpus: string, shipped: readonly string[], styles: readonly string[],
): string[] {
  return (persona.match(KEBAB_TOKEN) ?? [])
    .filter(token => !shipped.includes(token) && !styles.includes(token) && token !== PROVIDER_NAME)
    .filter(token => !corpus.includes(token.endsWith('*') ? token.slice(0, -1) : token))
}

/**
 * Presets whose plan-mode tail differs from the first one seen.
 * @param tails - preset file name to its tail.
 * @returns one line per divergent preset.
 */
function tailMismatches(tails: ReadonlyMap<string, string>): string[] {
  const [reference, ...rest] = [...tails]
  if (reference === undefined) return []
  return rest.filter(([, tail]) => tail !== reference[1]).map(([file]) => `${file} diverges from ${reference[0]}`)
}

/** The document preset's persona prefix, plan-mode section, and style pair, read once. */
interface DocumentText {
  readonly persona: string
  readonly plan: string
  readonly styleGuide: string
  readonly defaultStyle: string
  readonly skills: readonly string[]
  readonly skillBodies: readonly string[]
}

/** Read the shipped text and the shipped skill corpus. */
async function documentText(): Promise<DocumentText> {
  const rowOf = await rowsOf(DOCUMENT_PRESET)
  const skills = await shippedSkills()
  return {
    persona: textOf(configOf(rowOf('persona')), 'prefix'),
    plan: textOf(configOf(rowOf('plan-mode')), 'section'),
    styleGuide: textOf(configOf(rowOf('doc-template')), 'styleGuide'),
    defaultStyle: textOf(configOf(rowOf('tool-document-deliver')), 'defaultStyle'),
    skills,
    skillBodies: await skillTexts(skills),
  }
}

it('names every deliverable format the tool accepts, and no format it does not', async () => {
  const { persona } = await documentText()
  expect(DELIVERABLE_FORMATS.length).toBeGreaterThan(UNNAMED_FORMATS.length)
  expect(unnamedFormats(persona)).toEqual([])
  expect(persona).not.toMatch(UNSUPPORTED_FORMATS)
})

it('names the same format set in the plan-mode section', async () => {
  const { plan } = await documentText()
  expect(unnamedFormats(planPreamble(plan))).toEqual([])
})

it('names one writing style in the persona, the injected guide, and the quality gate', async () => {
  const { persona, styleGuide, defaultStyle } = await documentText()
  expect(styleDisagreements(persona, styleGuide, defaultStyle)).toEqual([])
})

it('mentions only skills the bundle ships, and ships the six it lists', async () => {
  const { persona, skills, skillBodies } = await documentText()
  expect(unknownSkillTokens([persona, ...skillBodies], skills)).toEqual([])
  expect(skills).toHaveLength(6)
})

it('teaches every template family the persona advertises', async () => {
  const { persona, skillBodies, skills } = await documentText()
  const styles = loadStyles(styleDirectories()).map(style => style.name)
  expect(orphanTemplateFamilies(persona, skillBodies.join('\n'), skills, styles)).toEqual([])
})

it('keeps one plan-mode tail across the presets that carry a plan-mode section', async () => {
  const files = (await readdir(PRESET_DIR)).filter(file => file.endsWith('.patch.yml')).sort()
  const tails = new Map<string, string>()
  for (const file of files) {
    const section = textOf(configOf((await rowsOf(join(PRESET_DIR, file)))('plan-mode')), 'section')
    if (section === '') continue
    const tail = planTail(section)
    expect(tail, `${file} carries a plan-mode section with no shared tail`).toBeDefined()
    tails.set(file, tail as string)
  }
  expect(tails.size).toBeGreaterThan(1)
  expect(tailMismatches(tails)).toEqual([])
})

it('reports each drift the comparisons cover', async () => {
  // Positive cases pass on any input only if the comparisons can fail.
  expect(unnamedFormats('HTML 单页、PDF 导出、Word 文档与 PPTX 演示')).toEqual(['markdown'])
  expect(styleDisagreements('本部署已注入 assistant 样式指南', 'assistant-neutral', 'assistant-neutral'))
    .toEqual(['persona does not name "assistant-neutral"'])
  expect(styleDisagreements('本部署已注入 assistant-neutral 样式指南', 'assistant-neutral', 'patent-standard'))
    .toEqual(['gate checks "patent-standard", guide injects "assistant-neutral"'])
  expect(unknownSkillTokens(['见 document-ghost 与 document-brief'], ['document-brief'])).toEqual(['document-ghost'])
  expect(orphanTemplateFamilies('模板（web-prototype / pm-spec 等）', 'web-prototype 用法', ['document-html'], ['assistant-neutral']))
    .toEqual(['pm-spec'])
  expect(tailMismatches(new Map([['a.patch.yml', 'X'], ['b.patch.yml', 'Y']]))).toEqual(['b.patch.yml diverges from a.patch.yml'])
})
