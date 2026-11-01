/**
 * 证据规则资产加载器（对齐 src/rule/runtime/patent-compliance.ts 的资产定位）。
 *
 * 资产路径定位（P4.1 由 dsh-patent-rule 提供真实规则包后接线）：
 *   1. 调用方显式传入的 ruleDirs（目录，其下 patent/evidence-rules.yaml）
 * 纯库形态不内置任何规则资产目录解析——SATI_RULES_DIR / cwd/rules/patent /
 * 包根 rules/patent 的定位随 dsh-patent-rule 的 asset-location 一并迁移。
 * 未传 ruleDirs 时返回空规则集 + 警告（不抛错，引擎降级为默认权重）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EvidenceEngine } from './engine.ts'

const EVIDENCE_RULES_FILE = 'evidence-rules.yaml'

/** 证据规则加载结果：引擎 + 命中资产源 + 累积警告。 */
type EvidenceRulesLoadResult = {
  engine: EvidenceEngine
  source: string | null
  warnings: string[]
}

/**
 * 加载内置证据规则集并构造引擎；找不到资产时返回默认引擎 + 警告。
 * @param ruleDirs - 规则资产目录候选（P4.1 由 dsh-patent-rule 注入；纯库默认空）。
 * @returns 引擎 + 命中的资产源路径（未命中为 null）+ 累积警告。
 */
export function loadEvidenceRulesEngine(ruleDirs: readonly string[] = []): EvidenceRulesLoadResult {
  const warnings: string[] = []
  for (const dir of ruleDirs) {
    const path = join(dir, EVIDENCE_RULES_FILE)
    if (!existsSync(path)) continue
    try {
      const engine = new EvidenceEngine(readFileSync(path, 'utf8'), path)
      return { engine, source: path, warnings: [...warnings, ...engine.getWarnings()] }
    } catch (error) {
      warnings.push(`证据规则资产加载失败 ${path}: ${(error as Error).message}`)
    }
  }
  warnings.push(
    '未找到证据规则资产（ruleDirs 未提供或 evidence-rules.yaml 不存在），引擎降级为默认权重',
  )
  return { engine: new EvidenceEngine(), source: null, warnings }
}
