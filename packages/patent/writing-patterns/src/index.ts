/**
 * Function plugin registering `query_writing_patterns` and the writing-pattern
 * system-prompt section over the pattern corpus packaged with this plugin.
 *
 * The corpus is read and validated at plugin load, so a missing or invalid
 * asset fails the deployment instead of leaving the model with an empty
 * pattern library or a section that silently drops patterns.
 * @module @deepseek-ai/dsh-writing-patterns
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadPatternStore, type PatternStore } from './pattern-store.ts'
import { renderWritingSkillsSection, WRITING_PATTERNS_SECTION_NAME } from './prompt.ts'
import { compileWritingPatternIndex, compileWritingSkills } from './skill-compiler.ts'
import { createQueryWritingPatternsTool } from './tool/query-writing-patterns.ts'
import { PATTERN_CATEGORIES, type PatternCategory, type WritingPattern, WritingPatternError } from './types.ts'

// Public library API: the pattern corpus, its lexical selection, the compiled
// skill text, and the tool factory.
export { PATTERN_FILE_SUFFIXES, patternDir } from './asset-location.ts'
export {
  loadPatternCorpus,
  loadPatternStore,
  parsePatternFile,
  PatternStore,
  patternKeywords,
  type PatternMatchSpec,
  type PatternSearchSpec,
} from './pattern-store.ts'
export { compileWritingPatternIndex, compileWritingSkills, escapeXmlText } from './skill-compiler.ts'
export {
  renderWritingSkillsSection,
  WRITING_PATTERNS_PROMPT_TEXT,
  WRITING_PATTERNS_SECTION_NAME,
} from './prompt.ts'
export {
  createQueryWritingPatternsTool,
  renderQueryWritingPatterns,
  type QueryWritingPatternsInput,
  type QueryWritingPatternsMode,
  type QueryWritingPatternsOutput,
  type QueryWritingPatternsToolOptions,
  type WritingPatternView,
} from './tool/query-writing-patterns.ts'
export {
  DEFAULT_PATTERN_QUALITY,
  isPatternCategory,
  PATTERN_CATEGORIES,
  PATTERN_CATEGORY_LABELS,
  PatternAssetError,
  WritingPatternError,
  type PatternCategory,
  type PatternExample,
  type PatternPrinciple,
  type PatternStep,
  type WritingPattern,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'writing-patterns'

/** Services the plugin requires before registration. */
export const inject = ['tools', 'systemPrompt']

/** Result cap applied when a call omits its own limit; the Go source capped a match at 5. */
const DEFAULT_MATCH_LIMIT = 5

/** Position of the injected section, next to the patent-domain TRIZ section at 111. */
const DEFAULT_SECTION_ORDER = 112

/** Model-facing writing-pattern plugin configuration. */
export interface Config {
  /** Directory holding the pattern YAML files; defaults to the packaged corpus. */
  patternDir?: string
  /**
   * Result cap applied when a search, feature-match, or category call omits its
   * own limit. An argument-free listing always returns the whole library.
   */
  matchLimit?: number
  /** Register the always-on writing-patterns system-prompt section. Defaults to true. */
  registerSection?: boolean
  /** Categories whose patterns the section indexes; an empty list injects the guidance alone. */
  sectionCategories?: PatternCategory[]
  /** Position of the injected section in the assembled system prompt. */
  sectionOrder?: number
  /**
   * Pattern ids each workflow stage's prompt receives, keyed by stage id. Every
   * stage lists 3 to 5 pattern ids that exist in the loaded corpus; an atom
   * reads its stage's patterns through the `writingPatterns` service.
   */
  stagePatterns?: Record<string, string[]>
}

/** Schemastery configuration: corpus override, result cap, and section policy. */
export const Config: z<Config> = z.object({
  patternDir: z.string(),
  matchLimit: z.natural().min(1).default(DEFAULT_MATCH_LIMIT),
  registerSection: z.boolean().default(true),
  sectionCategories: z.array(z.union(PATTERN_CATEGORIES)).default([...PATTERN_CATEGORIES]),
  sectionOrder: z.natural().default(DEFAULT_SECTION_ORDER),
  stagePatterns: z.dict(z.array(z.string().min(1)).min(3).max(5)),
})

/**
 * The writing-pattern capability seam: the patterns each workflow stage
 * declared in `stagePatterns`, resolved against the loaded corpus at plugin
 * load. An atom reads its stage's patterns here instead of reaching into the
 * store, so the deployment's stage policy stays in `cordis.yml`.
 */
export class WritingPatternsService extends Service {
  private readonly byStage: ReadonlyMap<string, readonly WritingPattern[]>

  /**
   * @param ctx - the plugin context the service registers on.
   * @param store - the loaded corpus; every declared id must exist in it.
   * @param stagePatterns - stage id to declared pattern ids; each stage lists 3 to 5.
   * @throws WritingPatternError when a stage declares an unknown or duplicate id,
   * or a count outside 3 to 5.
   */
  constructor(ctx: Context, store: PatternStore, stagePatterns: Readonly<Record<string, readonly string[]>>) {
    // Resolve and validate before super() registers the service: an invalid
    // stage map must fail without leaving a half-registered ctx.writingPatterns.
    const byStage = resolveStagePatterns(store, stagePatterns)
    super(ctx, 'writingPatterns')
    this.byStage = byStage
  }

  /**
   * The patterns one workflow stage declared, in declaration order.
   * @param stageId - the workflow stage id.
   * @returns the stage's patterns.
   * @throws WritingPatternError when the deployment declared no patterns for the stage.
   */
  patternsForStage(stageId: string): readonly WritingPattern[] {
    const patterns = this.byStage.get(stageId)
    if (patterns === undefined) {
      throw new WritingPatternError(`写作模式未声明阶段 "${stageId}"：请在该插件的 stagePatterns 中配置该阶段`)
    }
    return patterns
  }

  /**
   * The `<writing_skills>` block of one workflow stage's declared patterns.
   * @param stageId - the workflow stage id.
   * @returns the compiled block.
   * @throws WritingPatternError when the deployment declared no patterns for the stage.
   */
  compiledForStage(stageId: string): string {
    return compileWritingSkills(this.patternsForStage(stageId))
  }

  /**
   * Stage ids the deployment declared, in configuration order.
   * @returns the declared stage ids.
   */
  stageIds(): readonly string[] {
    return [...this.byStage.keys()]
  }
}

/**
 * Resolve and validate the stage map at plugin load.
 * @param store - the loaded corpus.
 * @param declared - stage id to declared pattern ids.
 * @returns the resolved patterns per stage.
 * @throws WritingPatternError on a duplicate or unknown id, or a count outside 3 to 5.
 */
function resolveStagePatterns(
  store: PatternStore,
  declared: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<string, readonly WritingPattern[]> {
  const byStage = new Map<string, readonly WritingPattern[]>()
  for (const [stageId, ids] of Object.entries(declared)) {
    if (ids.length < 3 || ids.length > 5) {
      throw new WritingPatternError(`阶段 "${stageId}" 声明了 ${String(ids.length)} 条写作模式：每个阶段应为 3 到 5 条`)
    }
    const seen = new Set<string>()
    const patterns = ids.map((id) => {
      if (seen.has(id)) throw new WritingPatternError(`阶段 "${stageId}" 重复声明写作模式 "${id}"`)
      seen.add(id)
      const pattern = store.get(id)
      if (pattern === undefined) throw new WritingPatternError(`阶段 "${stageId}" 声明了不存在的写作模式 "${id}"`)
      return pattern
    })
    byStage.set(stageId, patterns)
  }
  return byStage
}

/**
 * Register the query_writing_patterns tool, the writingPatterns service, and,
 * by default, the writing-patterns section carrying the compiled pattern index.
 * @param ctx - registrant context carrying the tool registry and system prompt.
 * @param config - corpus location, result cap, and section policy.
 * @throws PatternAssetError when the configured corpus cannot be loaded.
 */
export function apply(ctx: Context, config: Config): void {
  const store = loadPatternStore(config.patternDir)
  new WritingPatternsService(ctx, store, config.stagePatterns ?? {})
  ctx.tools.register(createQueryWritingPatternsTool({
    store,
    matchLimit: config.matchLimit ?? DEFAULT_MATCH_LIMIT,
  }))
  if (config.registerSection === false) return
  const patterns = sectionPatterns(store, config.sectionCategories ?? PATTERN_CATEGORIES)
  ctx.systemPrompt.section({
    name: WRITING_PATTERNS_SECTION_NAME,
    order: config.sectionOrder ?? DEFAULT_SECTION_ORDER,
    text: renderWritingSkillsSection(compileWritingPatternIndex(patterns)),
  })
}

/**
 * Patterns the section injects: the requested categories in the given order,
 * each in id order, with a pattern tagged by two requested categories listed once.
 * @param store - the loaded corpus.
 * @param categories - the categories to inject.
 * @returns the patterns in injection order.
 */
function sectionPatterns(store: PatternStore, categories: readonly PatternCategory[]): readonly WritingPattern[] {
  const seen = new Set<string>()
  const patterns: WritingPattern[] = []
  for (const category of categories) {
    for (const pattern of store.byCategory(category)) {
      if (seen.has(pattern.id)) continue
      seen.add(pattern.id)
      patterns.push(pattern)
    }
  }
  return patterns
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The stage-scoped writing-pattern lookup; present while this plugin is mounted. */
    writingPatterns: WritingPatternsService
  }
}
