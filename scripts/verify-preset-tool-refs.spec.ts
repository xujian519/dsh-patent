import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  declaredCountTotal,
  declaredToolCounts,
  findTemplateCountViolations,
  findTemplateStatementViolations,
  findToolCountViolations,
  findToolRefViolations,
  loadPresetCorpus,
  mountedToolNames,
  mountedToolsByPackage,
  parseToolCatalog,
  toolReferences,
  type PresetCorpus,
} from './verify-preset-tool-refs.ts'

const root = resolve(import.meta.dirname, '..')

/** A catalog excerpt in the generated package-map format. */
const CATALOG = [
  '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
  '| --- | --- | --- | --- | --- | --- |',
  '| `@deepseek-ai/dsh-patent-document` | `render_patent_document`, `verify_deliverable` | `ctx.tools` | `tool/call` | - | - |',
  '| `@deepseek-ai/dsh-tool-fs` | `edit`, `read`, `read_image`, `write` | `ctx.tools` | `tool/call` | - | - |',
  '| `@deepseek-ai/dsh-tool-subagent` | `subagent` | `ctx.tools` | `tool/call` | `subagent_fork` | - |',
  '| `@deepseek-ai/dsh-tool-web` | `web_fetch`, `web_search` | `ctx.tools` | `tool/call` | - | - |',
].join('\n')

/** One corpus entry over a preset YAML and an optional README and skill file. */
function corpusOf(preset: string, presetSource: string, skillSource = '', readmeSource = ''): PresetCorpus {
  return {
    preset,
    presetFile: { path: `presets/${preset}.patch.yml`, source: presetSource },
    readmeFiles: readmeSource === '' ? [] : [{ path: `presets/${preset}.md`, source: readmeSource }],
    skillFiles: skillSource === '' ? [] : [{ path: `skills/${preset}/probe/SKILL.md`, source: skillSource }],
  }
}

const FS_PRESET = ['- insert:', "    - name: '@deepseek-ai/dsh-tool-fs'", ''].join('\n')

/** A preset that mounts the patent-tools package. */
const PATENT_TOOLS_PRESET = ['- insert:', "    - name: '@deepseek-ai/dsh-patent-tools'", ''].join('\n')

/** A catalog whose patent-tools row carries three tools. */
const COUNT_CATALOG = [
  '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
  '| --- | --- | --- | --- | --- | --- |',
  '| `@deepseek-ai/dsh-patent-tools` | `patent_search`, `draft_claims`, `matter_log_append` | `ctx.tools` | `tool/call` | - | - |',
  '| `@deepseek-ai/dsh-tool-web` | `web_fetch`, `web_search` | `ctx.tools` | `tool/call` | - | - |',
].join('\n')

/**
 * A catalog carrying one `render_patent_document` section.
 * @param description - the `template` parameter description.
 * @param ids - the template ids the schema enumerates.
 * @param mainDescription - the tool description that precedes the schema.
 * @returns catalog text with a following section, so the scan proves its own boundary.
 */
function templateCatalog(description: string, ids: string[], mainDescription = 'Render a document.'): string {
  return [
    '## `@deepseek-ai/dsh-patent-document`',
    '',
    '### `render_patent_document`',
    '',
    mainDescription,
    '',
    '```json',
    JSON.stringify({ type: 'object', properties: { template: { type: 'string', description, enum: ids } } }, null, 2),
    '```',
    '',
    '## `@deepseek-ai/dsh-next`',
    '',
  ].join('\n')
}

const tempRoots: string[] = []
afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true })
})

describe('parseToolCatalog', () => {
  it('reads the model-visible names and shipped aliases of each package row', () => {
    const catalog = parseToolCatalog(CATALOG)
    expect(catalog.get('@deepseek-ai/dsh-tool-fs')).toEqual({
      names: new Set(['edit', 'read', 'read_image', 'write']),
      aliases: new Set(),
    })
    expect(catalog.get('@deepseek-ai/dsh-tool-subagent')).toEqual({
      names: new Set(['subagent']),
      aliases: new Set(['subagent_fork']),
    })
  })

  it('reads no package from prose outside the table', () => {
    expect(parseToolCatalog('A paragraph mentioning `@deepseek-ai/dsh-tool-fs`.')).toEqual(new Map())
  })
})

describe('mountedToolNames', () => {
  it('collects the catalog names of every plugin the preset names', () => {
    expect(mountedToolNames(FS_PRESET, parseToolCatalog(CATALOG))).toEqual(new Set(['edit', 'read', 'read_image', 'write']))
  })

  it('adds a load-time toolName and ignores packages the catalog does not carry', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-fs'",
      "    - name: '@deepseek-ai/dsh-tool-unlisted'",
      '      config:',
      '        toolName: custom_tool',
      '',
    ].join('\n')
    expect(mountedToolNames(preset, parseToolCatalog(CATALOG))).toEqual(new Set(['edit', 'read', 'read_image', 'write', 'custom_tool']))
  })

  it('drops a row the preset disables, so its package and toolName mount nothing', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-subagent'",
      '      disabled: true',
      '      config:',
      '        toolName: custom_tool',
      '',
    ].join('\n')
    expect(mountedToolNames(preset, parseToolCatalog(CATALOG))).toEqual(new Set())
  })

  it('keeps a row whose disabled condition evaluates to false', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-fs'",
      '      disabled: false',
      '',
    ].join('\n')
    expect(mountedToolNames(preset, parseToolCatalog(CATALOG))).toEqual(new Set(['edit', 'read', 'read_image', 'write']))
  })

  it('drops a tool the row config turns off and keeps the rest of the package', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-web'",
      '      config:',
      '        fetch: false',
      '        searchTimeoutMs: 60000',
      '',
    ].join('\n')
    expect(mountedToolNames(preset, parseToolCatalog(CATALOG))).toEqual(new Set(['web_search']))
  })
})

describe('mountedToolsByPackage', () => {
  it('groups the catalog names of every plugin the preset names', () => {
    expect([...mountedToolsByPackage(PATENT_TOOLS_PRESET, parseToolCatalog(COUNT_CATALOG)).entries()]).toEqual([
      ['@deepseek-ai/dsh-patent-tools', {
        names: new Set(['patent_search', 'draft_claims', 'matter_log_append']),
        aliases: new Set(),
      }],
    ])
  })

  it('subtracts a tool the row config turns off', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-web'",
      '      config:',
      '        fetch: false',
      '',
    ].join('\n')
    expect([...mountedToolsByPackage(preset, parseToolCatalog(COUNT_CATALOG)).values()]).toEqual([
      { names: new Set(['web_search']), aliases: new Set() },
    ])
  })
})

describe('declaredToolCounts', () => {
  it('reads the English and Chinese catalogue lines', () => {
    const source = [
      '- `@deepseek-ai/dsh-patent-tools` — 33 model-facing tools: search, drafting.',
      '- `@deepseek-ai/dsh-patent-tools` — 33 个模型工具：检索、撰写。',
    ].join('\n')
    expect(declaredToolCounts(source)).toEqual([
      { line: 1, packageName: '@deepseek-ai/dsh-patent-tools', count: 33 },
      { line: 2, packageName: '@deepseek-ai/dsh-patent-tools', count: 33 },
    ])
  })

  it('ignores a count stated without the package it belongs to', () => {
    expect(declaredToolCounts('The preset ships thirty model-facing tools.')).toEqual([])
  })
})

describe('findToolCountViolations', () => {
  it('accepts a count equal to the tools the package mounts', () => {
    const readme = '- `@deepseek-ai/dsh-patent-tools` — 3 model-facing tools: the three.'
    expect(findToolCountViolations(COUNT_CATALOG, [corpusOf('a', PATENT_TOOLS_PRESET, '', readme)])).toEqual([])
  })

  it('reports a count the mounted tool set contradicts', () => {
    const readme = 'line one\n- `@deepseek-ai/dsh-patent-tools` — 2 model-facing tools: the two.'
    expect(findToolCountViolations(COUNT_CATALOG, [corpusOf('a', PATENT_TOOLS_PRESET, '', readme)])).toEqual([
      'presets/a.md:2: states 2 tools for @deepseek-ai/dsh-patent-tools, but preset a mounts 3',
    ])
  })

  it('reports a count for a package the preset does not mount', () => {
    const readme = '- `@deepseek-ai/dsh-patent-tools` — 3 model-facing tools: the three.'
    expect(findToolCountViolations(COUNT_CATALOG, [corpusOf('a', FS_PRESET, '', readme)])).toEqual([
      'presets/a.md:1: states a tool count for @deepseek-ai/dsh-patent-tools, which preset a does not mount',
    ])
  })

  it('counts only the tools a config switch leaves mounted', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-web'",
      '      config:',
      '        fetch: false',
      '',
    ].join('\n')
    const readme = '- `@deepseek-ai/dsh-tool-web` — 1 model-facing tool: search.'
    expect(findToolCountViolations(COUNT_CATALOG, [corpusOf('a', preset, '', readme)])).toEqual([])
  })

  it('counts registered names, not shipped aliases', () => {
    const preset = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-subagent'",
      '',
    ].join('\n')
    const readme = '- `@deepseek-ai/dsh-tool-subagent` — 1 model-facing tools: delegation.'
    expect(findToolCountViolations(CATALOG, [corpusOf('a', preset, '', readme)])).toEqual([])
  })
})

describe('findTemplateCountViolations', () => {
  const IDS = ['patentability-opinion', 'search-report', 'oa-response']

  it('accepts a stated count equal to the registry ids', () => {
    const catalog = templateCatalog('Template id to render (one of the three shipped patent templates).', IDS)
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([])
  })

  it('checks the count stated in the tool description too', () => {
    const catalog = templateCatalog(
      'Template id to render (one of the three shipped patent templates).',
      IDS,
      'All three templates accept a controlled draft.',
    )
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([])
  })

  it('reads a capitalized phrase and a digit count', () => {
    const catalog = templateCatalog(
      'Template id to render (One of the 3 shipped patent templates).',
      IDS,
      'All three templates accept a controlled draft.',
    )
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([])
  })

  it('reports a stated count the registry contradicts', () => {
    const catalog = templateCatalog('Template id to render (one of the eleven shipped patent templates).', IDS)
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([
      'docs/tool-catalog.md: `render_patent_document` states "one of the eleven shipped patent templates", but the shipped registry carries 3 templates',
    ])
  })

  it('reports a count in the main description the registry contradicts', () => {
    const catalog = templateCatalog(
      'Template id to render (one of the three shipped patent templates).',
      IDS,
      'All eleven templates accept a controlled draft.',
    )
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([
      'docs/tool-catalog.md: `render_patent_document` states "All eleven templates accept", but the shipped registry carries 3 templates',
    ])
  })

  it('reports a description that no longer states a total count', () => {
    const catalog = templateCatalog('Template id to render (one of the shipped patent templates).', IDS)
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([
      'docs/tool-catalog.md: `render_patent_document` no longer states the shipped template count',
    ])
  })

  it('reports an enum that differs from the registry ids', () => {
    const catalog = templateCatalog('Template id to render (one of the three shipped patent templates).', [
      'a',
      'b',
      'c',
    ])
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([
      'docs/tool-catalog.md: `render_patent_document` enumerates template ids that differ from the shipped registry (missing patentability-opinion, search-report, oa-response; unexpected a, b, c)',
    ])
  })

  it('reports a section that carries no template enum', () => {
    const catalog = ['### `render_patent_document`', '', 'All three templates accept a draft.', ''].join('\n')
    expect(findTemplateCountViolations(catalog, IDS)).toEqual([
      'docs/tool-catalog.md: `render_patent_document` carries no template enum',
    ])
  })

  it('reports a catalog with no such section', () => {
    expect(findTemplateCountViolations('# no tools', IDS)).toEqual([
      'docs/tool-catalog.md: no `render_patent_document` section to check',
    ])
  })
})

describe('findTemplateStatementViolations', () => {
  it('reads a hyphenated count', () => {
    expect(findTemplateStatementViolations('One of the twenty-one shipped patent templates.', 21, 'probe.ts:')).toEqual([])
  })

  it('fails a text that states no count', () => {
    expect(findTemplateStatementViolations('No count here.', 13, 'probe.ts:')).toEqual([
      'probe.ts: no longer states the shipped template count',
    ])
  })

  it('reports a phrase that names no known number', () => {
    expect(findTemplateStatementViolations('One of the umpteen shipped patent templates.', 13, 'probe.ts:')).toEqual([
      'probe.ts: states "One of the umpteen shipped patent templates", which names no count, while the shipped registry carries 13 templates',
    ])
  })
})

describe('declaredCountTotal', () => {
  it('totals the counts the READMEs state', () => {
    const readme = '- `@deepseek-ai/dsh-patent-tools` — 3 model-facing tools: the three.'
    expect(declaredCountTotal([corpusOf('a', PATENT_TOOLS_PRESET, '', readme)])).toBe(1)
  })

  it('fails loud when a README corpus states no count', () => {
    expect(() => declaredCountTotal([corpusOf('a', PATENT_TOOLS_PRESET, '', 'No counts.')])).toThrow(
      /state no tool counts/,
    )
  })

  it('accepts a corpus without READMEs', () => {
    expect(declaredCountTotal([corpusOf('a', PATENT_TOOLS_PRESET)])).toBe(0)
  })
})


describe('toolReferences', () => {
  it('keeps only backticked snake_case names carrying an underscore, with line numbers', () => {
    expect(toolReferences('use `read` and `foo_bar`\nthen `ls` or `x_y`')).toEqual([
      { line: 1, name: 'foo_bar' },
      { line: 2, name: 'x_y' },
    ])
  })
})

describe('findToolRefViolations', () => {
  it('accepts a reference the preset mounts and a cataloged alias', () => {
    const preset = [FS_PRESET, "    - name: '@deepseek-ai/dsh-tool-subagent'", ''].join('\n')
    const violations = findToolRefViolations(CATALOG, [corpusOf('a', preset, 'use `read` and `subagent_fork`')])
    expect(violations).toEqual([])
  })

  it('reports a backticked name no mounted tool carries', () => {
    const violations = findToolRefViolations(CATALOG, [corpusOf('a', FS_PRESET, 'use `foo_bar`')])
    expect(violations).toEqual(['skills/a/probe/SKILL.md:1: `foo_bar` is not a tool preset a mounts'])
  })

  it('reports a reference to a tool whose preset row is disabled', () => {
    const preset = ['- insert:', "    - name: '@deepseek-ai/dsh-tool-subagent'", '      disabled: true', ''].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('a', preset, 'use `subagent_fork`')])).toEqual([
      'skills/a/probe/SKILL.md:1: `subagent_fork` is not a tool preset a mounts',
    ])
  })

  it('reports a tool another preset mounts but this one does not', () => {
    const corpus = [
      corpusOf('a', FS_PRESET, 'use `read_image`'),
      corpusOf('b', ['- insert:', "    - name: '@deepseek-ai/dsh-tool-subagent'", ''].join('\n'), 'use `read_image`'),
    ]
    expect(findToolRefViolations(CATALOG, corpus)).toEqual([
      'skills/b/probe/SKILL.md:1: `read_image` is not a tool preset b mounts',
    ])
  })

  it('accepts an explicitly exempted name and still reports the rest', () => {
    const violations = findToolRefViolations(
      CATALOG,
      [corpusOf('a', FS_PRESET, '`source_path` and `foo_bar`')],
      new Map([['source_path', 'patent evidence field']]),
    )
    expect(violations).toEqual(['skills/a/probe/SKILL.md:1: `foo_bar` is not a tool preset a mounts'])
  })

  it('accepts a workflow stage id and still reports an invented stage', () => {
    // Skill text names stages to say which part of a manifest a member verifies,
    // so a declared stage is not a tool reference. The set comes from the
    // manifests, which is what keeps a dropped stage from staying exempt.
    const declared = findToolRefViolations(CATALOG, [corpusOf('a', FS_PRESET, 'verify `draft_review` next')])
    expect(declared).toEqual([])
    expect(findToolRefViolations(CATALOG, [corpusOf('a', FS_PRESET, 'verify `draft_reviw` next')])).toEqual([
      'skills/a/probe/SKILL.md:1: `draft_reviw` is not a tool preset a mounts',
    ])
  })

  it('reports a reference to a tool the preset config turned off', () => {
    const presetSource = [
      '- insert:',
      "    - name: '@deepseek-ai/dsh-tool-web'",
      '      config:',
      '        fetch: false',
      '',
    ].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('document', presetSource, 'call `web_fetch` here')]))
      .toEqual(['skills/document/probe/SKILL.md:1: `web_fetch` is not a tool preset document mounts'])
  })

  it('scans the preset YAML itself, not only its skills', () => {
    const preset = [FS_PRESET, '# call `foo_bar` here', ''].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('a', preset)])).toEqual([
      'presets/a.patch.yml:4: `foo_bar` is not a tool preset a mounts',
    ])
  })

  it('scans the preset README pair too', () => {
    expect(findToolRefViolations(CATALOG, [corpusOf('a', FS_PRESET, '', 'call `foo_bar` here')])).toEqual([
      'presets/a.md:1: `foo_bar` is not a tool preset a mounts',
    ])
  })

  it('reports a gate prerequisite no mounted package registers', () => {
    // A prerequisite that names nothing denies the guarded call in every session
    // while the declaration still reads as valid YAML, so it resolves here too.
    const preset = [
      FS_PRESET,
      "    - name: '@deepseek-ai/dsh-patent-document'",
      "    - name: '@deepseek-ai/dsh-patent-rule'",
      '      config:',
      '        deliveryGate:',
      "          - tool: 'render_patent_document'",
      '            requires: [write, matter_log_appends]',
      '',
    ].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('a', preset)])).toEqual([
      'presets/a.patch.yml: deliveryGate.requires names matter_log_appends, which preset a does not mount',
    ])
  })

  it('accepts a gate whose guarded tool and prerequisites are all mounted', () => {
    const preset = [
      FS_PRESET,
      "    - name: '@deepseek-ai/dsh-patent-document'",
      "    - name: '@deepseek-ai/dsh-patent-rule'",
      '      config:',
      '        deliveryGate:',
      "          - tool: 'render_patent_document'",
      '            requires: [write, edit]',
      '',
    ].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('a', preset)])).toEqual([])
  })

  it('ignores a gate a row the preset disables declares', () => {
    // A disabled row contributes no tools and no gate: the plugin never applies,
    // so judging its declaration would report a gate that cannot exist.
    const preset = [
      FS_PRESET,
      "    - name: '@deepseek-ai/dsh-patent-rule'",
      '      disabled: true',
      '      config:',
      '        deliveryGate:',
      "          - tool: 'render_patent_document'",
      '            requires: [write]',
      '',
    ].join('\n')
    expect(findToolRefViolations(CATALOG, [corpusOf('a', preset)])).toEqual([])
  })

  it('fails loud on an empty catalog package map', () => {
    expect(() => findToolRefViolations('# no rows', [corpusOf('a', FS_PRESET)])).toThrow(/carries no package rows/)
  })
})

describe('loadPresetCorpus', () => {
  it('pairs each preset with its README pair and the skill files under its directory', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-preset-tool-refs-'))
    tempRoots.push(tempRoot)
    const presetRoot = join(tempRoot, 'packages/bundle/web-app/presets')
    const skillDir = join(tempRoot, 'packages/bundle/web-app/skills/a/probe')
    mkdirSync(presetRoot, { recursive: true })
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(presetRoot, 'a.patch.yml'), FS_PRESET)
    writeFileSync(join(presetRoot, 'a.md'), 'English README')
    writeFileSync(join(presetRoot, 'a.zh.md'), '中文 README')
    writeFileSync(join(skillDir, 'SKILL.md'), 'use `read`')
    const corpus = loadPresetCorpus(tempRoot)
    expect(corpus.map(entry => entry.preset)).toEqual(['a'])
    expect(corpus[0]?.readmeFiles.map(file => file.path)).toEqual([
      'packages/bundle/web-app/presets/a.md',
      'packages/bundle/web-app/presets/a.zh.md',
    ])
    expect(corpus[0]?.skillFiles.map(file => file.path)).toEqual(['packages/bundle/web-app/skills/a/probe/SKILL.md'])
  })

  it('fails loud on a skills directory without a preset', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-preset-tool-refs-'))
    tempRoots.push(tempRoot)
    mkdirSync(join(tempRoot, 'packages/bundle/web-app/presets'), { recursive: true })
    mkdirSync(join(tempRoot, 'packages/bundle/web-app/skills/orphan'), { recursive: true })
    expect(() => loadPresetCorpus(tempRoot)).toThrow(/without a preset: orphan/)
  })

  it('fails loud on a README without a preset', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-preset-tool-refs-'))
    tempRoots.push(tempRoot)
    const presetRoot = join(tempRoot, 'packages/bundle/web-app/presets')
    mkdirSync(presetRoot, { recursive: true })
    writeFileSync(join(presetRoot, 'a.patch.yml'), FS_PRESET)
    writeFileSync(join(presetRoot, 'orphan.md'), 'English README')
    expect(() => loadPresetCorpus(tempRoot)).toThrow(/README\(s\) without a preset: orphan\.md/)
  })
})

describe('shipped preset corpus', () => {
  it('resolves every backticked tool reference and stated count', () => {
    const corpus = loadPresetCorpus(root)
    expect(corpus.length).toBeGreaterThan(0)
    expect(corpus.filter(entry => entry.skillFiles.length > 0).length).toBeGreaterThan(0)
    expect(corpus.filter(entry => entry.readmeFiles.length > 0).length).toBeGreaterThan(0)
    const catalogSource = readFileSync(resolve(root, 'docs/tool-catalog.md'), 'utf8')
    expect([
      ...findToolRefViolations(catalogSource, corpus),
      ...findToolCountViolations(catalogSource, corpus),
      ...findTemplateCountViolations(catalogSource),
    ]).toEqual([])
  })
})
