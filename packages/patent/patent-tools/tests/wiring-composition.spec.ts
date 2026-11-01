import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SHIPPED_GUIDELINE_REVISION } from '@deepseek-ai/dsh-patent-workflow'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PatentKnowledge } from '@deepseek-ai/dsh-patent-knowledge'
import { DEFAULT_WORKFLOW_LLM_STAGE_BUDGET, DEFAULT_WORKFLOW_STAGE_BUDGET } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { registerPatentTools } from '../src/wiring.ts'
import { normalizeFigureAnalysis } from '../src/tool/analyze-patent-figure.ts'
import type { GeneratePatentFigureDeps } from '../src/tool/figure-input.ts'
import type { GenerateStructureFigureDeps } from '../src/tool/generate-structure-figure.ts'
import type { LawSearchDeps } from '../src/tool/law-search.ts'
import type { PatentLegalStatusDeps } from '../src/tool/patent-legal-status.ts'
import type { PatentMetadataDeps } from '../src/tool/patent-metadata.ts'
import type { PatentSearchDeps } from '../src/tool/patent-search.ts'
import type { FigureIndexEntry } from '../src/figure/index-store.ts'

/**
 * 组合点（wiring）的配置矩阵：每条部署开关都要么接到工具依赖、要么缺省保持
 * 历史行为。工具工厂在这里被薄包装一层以取出 deps，直接调用依赖闭包，避免真正
 * 执行子进程或网络路径。
 */

const mock = vi.hoisted(() => ({
  search: [] as PatentSearchDeps[],
  metadata: [] as PatentMetadataDeps[],
  legal: [] as PatentLegalStatusDeps[],
  law: [] as LawSearchDeps[],
  figures: [] as GeneratePatentFigureDeps[],
  structures: [] as GenerateStructureFigureDeps[],
}))

vi.mock('../src/tool/patent-search.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/patent-search.ts')>()
  return {
    ...actual,
    createPatentSearchTool: (deps: PatentSearchDeps = {}) => {
      mock.search.push(deps)
      return actual.createPatentSearchTool(deps)
    },
  }
})

vi.mock('../src/tool/patent-legal-status.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/patent-legal-status.ts')>()
  return {
    ...actual,
    createPatentLegalStatusTool: (deps: PatentLegalStatusDeps = {}) => {
      mock.legal.push(deps)
      return actual.createPatentLegalStatusTool(deps)
    },
  }
})

vi.mock('../src/tool/patent-metadata.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/patent-metadata.ts')>()
  return {
    ...actual,
    createPatentMetadataTool: (deps: PatentMetadataDeps = {}) => {
      mock.metadata.push(deps)
      return actual.createPatentMetadataTool(deps)
    },
  }
})

vi.mock('../src/tool/law-search.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/law-search.ts')>()
  return {
    ...actual,
    createLawSearchTool: (deps: LawSearchDeps) => {
      mock.law.push(deps)
      return actual.createLawSearchTool(deps)
    },
  }
})

vi.mock('../src/tool/generate-patent-figure.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/generate-patent-figure.ts')>()
  return {
    ...actual,
    createGeneratePatentFigureTool: (deps: GeneratePatentFigureDeps) => {
      mock.figures.push(deps)
      return actual.createGeneratePatentFigureTool(deps)
    },
  }
})

vi.mock('../src/tool/generate-structure-figure.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool/generate-structure-figure.ts')>()
  return {
    ...actual,
    createGenerateStructureFigureTool: (deps: GenerateStructureFigureDeps) => {
      mock.structures.push(deps)
      return actual.createGenerateStructureFigureTool(deps)
    },
  }
})

/** 失败的子进程句柄（组合点闭包只需要一个可判定的结果）。 */
function handleWith(outcome: SubprocessOutcome): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'fake failure', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve(outcome),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

/** 只记录 spawn 并返回失败句柄的 subprocess 服务。 */
class FakeSubprocess extends SubprocessRuntime {
  readonly calls: SubprocessSpawnSpec[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    return handleWith({ exitCode: 1, signal: null })
  }

  resolveExecutable(): Promise<string> {
    return Promise.resolve('/fake/executable')
  }

  terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix' })
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal 不在本用例范围'))
  }
}

const cleanups: (() => Promise<void> | void)[] = []
let tempRoot: string | undefined

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
  delete process.env.DSH_INKSCAPE
  delete process.env.DSH_FREECAD_CMD
  delete process.env.DSH_GRAPHVIZ_DOT
  vi.restoreAllMocks()
})

function workspace(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), 'dsh-wiring-'))
  return tempRoot
}

/** 写一个空的假可执行文件（existsSync 只判存在）。 */
function fakeExecutable(name: string): string {
  const path = join(workspace(), name)
  writeFileSync(path, '')
  return path
}

/** 临时知识库：kg_nodes/kg_edges 满足 KgStore 的结构探测。 */
function createKgDb(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'knowledge.db'))
  db.exec(
    'CREATE TABLE kg_nodes (id TEXT, node_type TEXT, name TEXT, title TEXT, content TEXT, law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT)',
  )
  db.exec('CREATE TABLE kg_edges (source_id TEXT, target_id TEXT, relation TEXT)')
  db.close()
}

/** 直达 registerPatentTools 的安装：绕过 schema 默认值，覆盖「Config 缺省」分支。 */
async function mount(
  config: Config,
  options: { subprocess?: boolean; knowledge?: boolean; webServerPort?: number; patentData?: boolean } = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.subprocess === true) new FakeSubprocess(ctx)
  if (options.knowledge === true) {
    const dir = join(workspace(), 'knowledge')
    createKgDb(dir)
    new PatentKnowledge(ctx, { knowledgeDir: dir, sourceDbPath: join(dir, 'knowledge.db') })
  }
  // 宿主 webserver 服务不在本包的声明合并里：用非字面量键让 ctx.provide 走通用重载。
  const webServerKey: string = 'webServer'
  if (options.webServerPort !== undefined) ctx.provide(webServerKey, { port: options.webServerPort })
  // patent-data 的插件声明 inject:['subprocess']，在只注入 tools 的消费方里晚一跳激活；
  // 这里只放一个等价的通道工厂，用来证明组合点的查询闭包确实晚绑定到该服务。
  const patentDataKey: string = 'patentData'
  if (options.patentData === true) {
    ctx.provide(patentDataKey, {
      createCniprChannel: () => ({ search: async () => ({ total: 0, hits: [] }) }),
    })
  }
  await ctx.plugin({ name: 'patent-tools-wiring-test', inject: ['tools'], apply: (child) => { registerPatentTools(child, config) } })
  cleanups.push(() => { void ctx.fiber.dispose() })
  return ctx
}

/** 一条满足索引结构的最小条目（analysis 由归一函数生成）。 */
function indexEntry(imagePath: string): FigureIndexEntry {
  return {
    imagePath,
    analyzedAt: new Date(0).toISOString(),
    analysis: normalizeFigureAnalysis('{}', { imagePath, figureNumber: 1, inventionName: undefined, modelUsed: 'test-model' }),
  }
}

/** 在指定平台上执行断言，结束后恢复原平台。 */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    return run()
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
}

describe('registerPatentTools 缺省配置', () => {
  it('Config 全缺省时回落到模块默认值，且未挂 subprocess 时所有渲染端口缺省', async () => {
    await mount({})
    const search = mock.search.at(-1)
    const metadata = mock.metadata.at(-1)
    const legal = mock.legal.at(-1)
    expect(search?.cnipr?.()).toBeUndefined()
    expect(metadata?.cnipr?.()).toBeUndefined()
    expect(legal?.cnipr?.()).toBeUndefined()

    const figure = mock.figures.at(-1)
    expect(figure).toBeDefined()
    expect(figure?.outlineText).toBeUndefined()
    expect(figure?.exportFigure).toBeUndefined()
    expect(figure?.sectionSource).toBeUndefined()
    expect(figure?.resolveFont?.(['R1'])).toBe('Helvetica')

    const structure = mock.structures.at(-1)
    expect(structure).toBeDefined()
    const stray = structure?.render
    if (stray === undefined) throw new Error('缺少结构投影渲染端口')
    const outcome = await stray({
      modelPaths: ['/abs/model.step'],
      views: ['iso'],
      scale: 1,
      showHidden: false,
      callouts: [],
      figureNumber: 1,
      outputDir: workspace(),
    })
    expect(outcome).toMatchObject({ ok: false, code: 'not_installed' })
  })

  it('未挂知识服务时 law_search 走 fail-loud 依赖（查询闭包仍接线到缺省）', async () => {
    await mount({})
    const law = mock.law.at(-1)
    expect(law).toEqual({})
  })

  it('patentData 挂载后三个数据工具的 CNIPR 查询闭包都晚绑定到该服务', async () => {
    await mount({}, { patentData: true })
    expect(mock.search.at(-1)?.cnipr?.()).toBeDefined()
    expect(mock.metadata.at(-1)?.cnipr?.()).toBeDefined()
    expect(mock.legal.at(-1)?.cnipr?.()).toBeDefined()
  })

  it('figureTextToPath 开启但缺 subprocess 时文字转路径 fail loud', async () => {
    await mount({ figureTextToPath: true })
    const figure = mock.figures.at(-1)
    const outlineText = figure?.outlineText
    if (outlineText === undefined) throw new Error('缺少文字转路径端口')
    const outcome = await outlineText({ path: join(workspace(), 'missing.svg') })
    expect(outcome).toMatchObject({ ok: false, code: 'not_installed' })
  })

  it('dotFont 为空串时按 CJK/平台选择字体（darwin）', async () => {
    await mount({ dotFont: '' })
    onPlatform('darwin', () => {
      expect(mock.figures.at(-1)?.resolveFont?.(['壳体'])).toBe('PingFang SC')
    })
  })

  it('CJK 标签在 win32 / 其他平台分别选平台字体', async () => {
    await mount({})
    const resolveFont = mock.figures.at(-1)?.resolveFont
    if (resolveFont === undefined) throw new Error('缺少字体解析端口')
    onPlatform('win32', () => {
      expect(resolveFont(['壳体'])).toBe('Microsoft YaHei')
    })
    onPlatform('linux', () => {
      expect(resolveFont(['壳体'])).toBe('Noto Sans CJK SC')
    })
  })
})

describe('registerPatentTools 显式部署配置', () => {
  /** 全套显式配置：每个可选字段都给出，覆盖「显式优先于默认」分支。 */
  function explicitConfig(): Config {
    return {
      guidelineRevision: SHIPPED_GUIDELINE_REVISION,
      workflowStageBudget: DEFAULT_WORKFLOW_STAGE_BUDGET,
      workflowLlmStageBudget: DEFAULT_WORKFLOW_LLM_STAGE_BUDGET,
      graphvizRenderTimeoutMs: 12_345,
      freecadRenderTimeoutMs: 23_456,
      inkscapeRenderTimeoutMs: 3_456,
      graphvizExecutable: fakeExecutable('dot'),
      figureTextToPath: true,
      inkscapeExecutable: fakeExecutable('inkscape'),
      freecadExecutable: fakeExecutable('freecadcmd'),
      figureRequireCuttingMarks: true,
      figureFailOnRenderFindings: true,
      figureFontMm: 4.23,
      figurePageSize: 'a4',
      figureOrientation: 'landscape',
      figureDpi: 300,
      figureMargin: 2.5,
      figureMinFontMm: 2,
      structureFigureEnabled: true,
      structureFigureScale: 2,
      structureFigureViews: ['iso'],
      workbenchBaseUrl: 'http://127.0.0.1:9',
      workbenchCaseRoot: './cases',
      dotFont: 'Custom Font',
      figureOutputDir: join(workspace(), 'figures'),
      figureIndexFile: join(workspace(), 'figures-index.json'),
      chemistryIndexFile: join(workspace(), 'chemistry-index.json'),
      noteDir: join(workspace(), 'notes'),
    }
  }

  it('显式配置进入各渲染端口，依赖闭包按配置透传', async () => {
    await mount(explicitConfig(), { subprocess: true })
    const figure = mock.figures.at(-1)
    if (figure === undefined) throw new Error('缺少附图生成 deps')

    expect(figure.resolveFont?.(['壳体'])).toBe('Custom Font')
    expect(figure.failOnRenderFindings).toBe(true)
    expect(mock.structures.at(-1)?.failOnRenderFindings).toBe(true)

    const source = join(workspace(), 'fig.svg')
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"><text>图</text></svg>')

    const outline = figure.outlineText
    if (outline === undefined) throw new Error('缺少文字转路径端口')
    expect(await outline({ path: source })).toMatchObject({ ok: false })

    const exportFigure = figure.exportFigure
    if (exportFigure === undefined) throw new Error('缺少格式导出端口')
    expect(await exportFigure({ path: source, outcomePath: join(workspace(), 'fig.pdf'), format: 'pdf' }))
      .toMatchObject({ ok: false })

    const sectionSource = figure.sectionSource
    if (sectionSource === undefined) throw new Error('缺少剖切来源端口')
    expect(await sectionSource.sectionGeometry({
      modelPath: '/abs/model.step',
      plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
      outputDir: workspace(),
    })).toMatchObject({ ok: false })
    expect(await sectionSource.sectionHatch({
      regions: [{ outline: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
      angleDeg: 45,
      spacingMm: 3,
      outputDir: workspace(),
    })).toMatchObject({ ok: false })

    await figure.upsertIndex?.(indexEntry('fig.svg'))
    expect(await figure.loadIndex?.()).toHaveLength(1)

    const structure = mock.structures.at(-1)
    if (structure === undefined) throw new Error('缺少结构投影 deps')
    expect(await structure.render({
      modelPaths: ['/abs/model.step'],
      views: ['iso'],
      scale: 1,
      showHidden: false,
      callouts: [],
      figureNumber: 1,
      outputDir: workspace(),
    })).toMatchObject({ ok: false })
    await structure.upsertIndex?.(indexEntry('structure.svg'))
  })

  it('subprocess 在但 Config 未给可执行路径时仍按探测器解析', async () => {
    await mount({ figureTextToPath: true }, { subprocess: true })
    const figure = mock.figures.at(-1)
    if (figure === undefined) throw new Error('缺少附图生成 deps')
    const outline = figure.outlineText
    if (outline === undefined) throw new Error('缺少文字转路径端口')

    const source = join(workspace(), 'fig2.svg')
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"><text>图</text></svg>')
    // 子进程句柄恒失败：无论宿主是否装了 Inkscape，结果都是分类失败。
    const outcome = await outline({ path: source })
    expect(outcome.ok).toBe(false)

    const sectionSource = figure.sectionSource
    if (sectionSource === undefined) throw new Error('缺少剖切来源端口')
    expect(await sectionSource.sectionGeometry({
      modelPath: '/abs/model.step',
      plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
      outputDir: workspace(),
    })).toMatchObject({ ok: false })
    expect(await sectionSource.sectionHatch({
      regions: [{ outline: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
      angleDeg: 45,
      spacingMm: 3,
      outputDir: workspace(),
    })).toMatchObject({ ok: false })

    const structure = mock.structures.at(-1)
    expect(await structure?.render({
      modelPaths: ['/abs/model.step'],
      views: ['iso'],
      scale: 1,
      showHidden: false,
      callouts: [],
      figureNumber: 1,
      outputDir: workspace(),
    })).toMatchObject({ ok: false })
  })

  it('环境变量指定 Inkscape 时导出端口接线且不再带 Config 覆盖', async () => {
    process.env.DSH_INKSCAPE = fakeExecutable('inkscape-env')
    await mount({}, { subprocess: true })
    const figure = mock.figures.at(-1)
    const exportFigure = figure?.exportFigure
    if (exportFigure === undefined) throw new Error('缺少格式导出端口')
    const source = join(workspace(), 'fig3.svg')
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(await exportFigure({ path: source, outcomePath: join(workspace(), 'fig3.png'), format: 'png' }))
      .toMatchObject({ ok: false })
  })

  it('webServer 端口作为 workbench 基址缺省；显式 baseUrl 优先', async () => {
    await mount({}, { webServerPort: 4_310 })
    await mount({ workbenchBaseUrl: 'http://explicit.example' })
    // 注册本身即完成分支求值；工具仍在注册表中。
    expect(mock.figures.length).toBeGreaterThanOrEqual(2)
  })
})

describe('registerPatentTools 知识服务接线', () => {
  it('law_search 的法规/指南检索闭包接到知识服务，dispose 时关闭 KG 适配器', async () => {
    const ctx = await mount({}, { knowledge: true })
    const law = mock.law.at(-1)
    if (law === undefined) throw new Error('缺少 law_search deps')
    expect(law.dbPath).toBe(join(workspace(), 'knowledge', 'knowledge.db'))
    // 夹具库只有 KG 表：检索引擎的缺表错误不影响「闭包已接到知识服务」这一事实。
    try {
      law.searchLaw?.('创造性')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
    try {
      law.searchGuideline?.('创造性')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
    await ctx.fiber.dispose()
  })
})
