/**
 * 宪法规则引擎 — 分层规则包（Rule Pack）装配器。
 *
 * 三层合并式加载：base（全领域通用）→ domains（清单声明顺序）→ overrides（项目私有）。
 * 复用 RuleLoader 的 loadRuleSetDir / mergeRuleSets（后加载按 id 覆盖）。
 *
 * dsh 适配：项目清单仅支持显式 `manifestPath`（无 .sati/rules.yaml 的 cwd/仓库根
 * 自动发现）；内置包名经 packaged assets 解析，可经 `rulesDir` 覆盖项替换基础资产根。
 * 无清单时回退默认行为：仅加载打包的 base 包（零配置可用）。
 * @module @deepseek-ai/dsh-patent-rule/runtime/rule-pack
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { RuleSet, RuleSetValidationIssue } from '@deepseek-ai/dsh-patent-core'
import { assetRulesRoot, candidatePackDirs } from '../asset-location.ts'
import { loadRuleSetDir, mergeRuleSets } from './RuleLoader.ts'

const PACK_MANIFEST_FILE = 'pack.yaml'

/** 项目侧规则包清单（`.sati/rules.yaml` 形态）。 */
export type RulePackManifest = {
  /** 内置包名（如 "base"）或绝对路径（外部包）。 */
  base: string
  /** domain 包名列表（按声明顺序加载）。 */
  domains: string[]
  /** 项目私有规则目录（相对清单所在目录或绝对路径）。 */
  overrides?: string
}

/** 分层规则包加载结果。 */
export type RulePackLoadResult = {
  ruleSet: RuleSet
  sources: string[]
  warnings: string[]
  /** 每条规则来自哪层（ruleId → 层名），供诊断/审计。 */
  layers: Map<string, string>
  /** 实际使用的清单路径；无清单时为 null。 */
  manifestPath: string | null
  /** 清单文件 mtime（毫秒）；无清单时为 null。供调用方做缓存失效判断。 */
  manifestMtimeMs: number | null
}

/** 包清单（pack.yaml）校验问题。 */
export type PackManifestIssue = { field: string; message: string }

/**
 * 定位项目清单：显式路径存在即返回，否则 null（无 cwd/仓库根自动发现）。
 * @param explicitPath - 显式清单路径。
 * @returns 命中的清单路径，未找到为 null。
 */
export function resolveRulePackManifestPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const p = resolve(explicitPath)
    return existsSync(p) ? p : null
  }
  return null
}

/**
 * 解析项目清单；结构非法抛错（由调用方记 warning 降级）。
 * @param yamlText - 清单 YAML 文本。
 * @returns 解析出的清单。
 */
export function parseRulePackManifest(yamlText: string): RulePackManifest {
  const doc = parseDocument(yamlText)
  if (doc.errors.length > 0) {
    /* v8 ignore next -- yaml parse errors always carry a message. */
    throw new Error(`清单 YAML 解析失败: ${doc.errors[0]?.message ?? 'unknown'}`)
  }
  const root: unknown = doc.toJS()
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('清单顶层必须是对象')
  }
  const record = root as Record<string, unknown>
  const base = typeof record.base === 'string' && record.base.trim() !== '' ? record.base.trim() : null
  if (base === null) throw new Error('清单缺少 base 字段（内置包名或绝对路径）')
  let domains: string[] = []
  if (record.domains !== undefined) {
    if (!Array.isArray(record.domains) || record.domains.some(d => typeof d !== 'string')) {
      throw new Error('清单 domains 必须是字符串数组')
    }
    domains = record.domains as string[]
  }
  const overrides =
    typeof record.overrides === 'string' && record.overrides.trim() !== '' ? record.overrides.trim() : undefined
  return { base, domains, ...(overrides !== undefined ? { overrides } : {}) }
}

/**
 * 校验包清单（pack.yaml）；与 assets/rules/pack.schema.json 保持同步。
 * 返回问题列表（空 = 通过）。
 * @param raw - 待校验的清单对象。
 * @param opts - 可选校验选项（requireDomain 要求领域包声明 domain）。
 * @returns 校验问题列表（空 = 通过）。
 */
export function validatePackManifest(raw: unknown, opts: { requireDomain?: boolean } = {}): PackManifestIssue[] {
  const issues: PackManifestIssue[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ field: '(root)', message: 'pack.yaml 顶层必须是对象' })
    return issues
  }
  const record = raw as Record<string, unknown>
  const knownFields = new Set(['id', 'version', 'description', 'domain'])
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) issues.push({ field: key, message: `未知字段 "${key}"` })
  }
  if (typeof record.id !== 'string' || !/^sati-rules-[a-z0-9-]+$/.test(record.id)) {
    issues.push({ field: 'id', message: 'id 必填且须形如 sati-rules-<slug>' })
  }
  if (typeof record.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.version)) {
    issues.push({ field: 'version', message: 'version 必填且须为 semver（x.y.z）' })
  }
  if (typeof record.description !== 'string' || record.description.trim() === '') {
    issues.push({ field: 'description', message: 'description 必填且非空' })
  }
  if (record.domain !== undefined && (typeof record.domain !== 'string' || record.domain.trim() === '')) {
    issues.push({ field: 'domain', message: 'domain 若非空须为字符串' })
  }
  if (opts.requireDomain === true && (typeof record.domain !== 'string' || record.domain.trim() === '')) {
    issues.push({ field: 'domain', message: '领域包清单必须声明 domain' })
  }
  return issues
}

/**
 * 定位内置包目录；未找到返回 null。绝对路径引用直接返回（若存在）。
 * @param nameOrPath - 内置包名或绝对路径。
 * @param rulesDir - 可选的规则根目录覆盖。
 * @returns 命中的包目录路径，未找到为 null。
 */
export function resolvePackDir(nameOrPath: string, rulesDir?: string): string | null {
  if (isAbsolute(nameOrPath)) {
    return existsSync(nameOrPath) ? nameOrPath : null
  }
  for (const dir of candidatePackDirs(nameOrPath, rulesDir)) {
    if (existsSync(dir)) return dir
  }
  return null
}

/** 校验包目录内的 pack.yaml；问题记 warning（不阻塞规则加载）。 */
function checkPackManifest(dir: string, layerName: string, warnings: string[]): void {
  const manifestPath = join(dir, PACK_MANIFEST_FILE)
  /* v8 ignore next -- loadLayer only calls checkPackManifest after an existsSync hit. */
  if (!existsSync(manifestPath)) {
    warnings.push(`规则包 ${layerName} 缺少 pack.yaml 清单（${manifestPath}）`)
    return
  }
  try {
    const doc = parseDocument(readFileSync(manifestPath, 'utf8'))
    if (doc.errors.length > 0) {
      /* v8 ignore next -- yaml parse errors always carry a message. */
      warnings.push(`规则包 ${layerName} 清单解析失败: ${doc.errors[0]?.message ?? 'unknown'}`)
      return
    }
    // 领域包须声明 domain（按层语义判断，而非目录路径）
    const isDomainPack = layerName.startsWith('domain:')
    const issues = validatePackManifest(doc.toJS(), { requireDomain: isDomainPack })
    for (const issue of issues) {
      warnings.push(`规则包 ${layerName} 清单非法（${issue.field}）: ${issue.message}`)
    }
  } catch (error) {
    warnings.push(`规则包 ${layerName} 清单读取失败: ${(error as Error).message}`)
  }
}

/**
 * 加载分层规则包。
 *
 * 同名 id 的覆盖一律记 warning：同一层内两个文件、跨层的 domain/overrides 覆盖 base，
 * 都只保留后加载的那条，静默覆盖会让一条规则从未生效而无人察觉。
 * @param options - 显式清单路径与可选规则根目录覆盖；缺省按打包 base 包加载。
 * @returns 分层规则包加载结果。
 */
export function loadRulePack(options: { manifestPath?: string; rulesDir?: string } = {}): RulePackLoadResult {
  const warnings: string[] = []
  const sources: string[] = []
  const layers = new Map<string, string>()
  const layerOrder: Array<{ name: string; ruleSet: RuleSet }> = []

  const manifestPath = resolveRulePackManifestPath(options.manifestPath)
  if (options.manifestPath !== undefined && manifestPath === null) {
    warnings.push(`规则包清单不存在（${options.manifestPath}）；回退仅加载 base 包`)
  }
  let manifest: RulePackManifest = { base: 'base', domains: [] }
  let manifestMtimeMs: number | null = null
  if (manifestPath !== null) {
    try {
      manifest = parseRulePackManifest(readFileSync(manifestPath, 'utf8'))
      manifestMtimeMs = statSync(manifestPath).mtimeMs
    } catch (error) {
      warnings.push(`规则包清单加载失败（${manifestPath}）: ${(error as Error).message}；回退仅加载 base 包`)
    }
  }

  const manifestDir = manifestPath !== null ? dirname(manifestPath) : assetRulesRoot(options.rulesDir)

  const loadLayer = (layerName: string, dirOrPath: string, refType: 'builtin' | 'path'): void => {
    const dir = refType === 'builtin' ? resolvePackDir(dirOrPath, options.rulesDir) : resolve(manifestDir, dirOrPath)
    if (dir === null) {
      warnings.push(`规则包 ${layerName} 未找到（引用: ${dirOrPath}），跳过`)
      return
    }
    if (existsSync(join(dir, PACK_MANIFEST_FILE))) {
      checkPackManifest(dir, layerName, warnings)
    } else if (layerName !== 'overrides') {
      warnings.push(`规则包 ${layerName} 缺少 pack.yaml 清单（${dir}）`)
    }
    const { ruleSets, sources: layerSources, warnings: layerWarnings } = loadRuleSetDir(dir)
    warnings.push(...layerWarnings.map(w => w.message))
    if (layerSources.length === 0 && layerName !== 'overrides') {
      warnings.push(`规则包 ${layerName} 无可加载规则文件（${dir}）`)
    }
    sources.push(...layerSources)
    // 跨层覆盖在下面逐层记录；同一层内两个文件定义同一 id 时同样会后加载覆盖先前的，
    // 那条路径此前完全无声，配错就成了一条规则从未生效而无人察觉。
    const layerIssues: RuleSetValidationIssue[] = []
    const layerRuleSet = mergeRuleSets(ruleSets, layerIssues)
    warnings.push(...layerIssues.map(issue => `规则包 ${layerName} 层内：${issue.message}`))
    layerOrder.push({ name: layerName, ruleSet: layerRuleSet })
  }

  loadLayer('base', manifest.base, isAbsolute(manifest.base) ? 'path' : 'builtin')
  for (const domain of manifest.domains) {
    loadLayer(`domain:${domain}`, domain, isAbsolute(domain) ? 'path' : 'builtin')
  }
  if (manifest.overrides !== undefined) {
    loadLayer('overrides', manifest.overrides, 'path')
  }

  // 逐层合并并记录来源；domain/overrides 覆盖 base 规则时记审计 warning。
  const merged: RuleSet[] = []
  for (const layer of layerOrder) {
    for (const rule of layer.ruleSet.rules) {
      const previous = layers.get(rule.id)
      if (previous !== undefined) {
        warnings.push(`规则 ${rule.id} 被 ${layer.name} 层覆盖（原: ${previous}）`)
      }
      layers.set(rule.id, layer.name)
    }
    merged.push(layer.ruleSet)
  }

  return {
    ruleSet: mergeRuleSets(merged),
    sources,
    warnings,
    layers,
    manifestPath,
    manifestMtimeMs,
  }
}

/**
 * layers 摘要（如 "base 8 + domain:mechanical 1 + overrides 1"），供工具输出。
 * @param layers - ruleId → 层名 映射。
 * @returns 层摘要字符串。
 */
export function summarizeRulePackLayers(layers: Map<string, string>): string {
  const counts = new Map<string, number>()
  for (const layer of layers.values()) {
    counts.set(layer, (counts.get(layer) ?? 0) + 1)
  }
  return [...counts.entries()].map(([layer, count]) => `${layer} ${count}`).join(' + ')
}
