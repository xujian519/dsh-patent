/**
 * 法律域证据规则集的 YAML 解析与校验。
 *
 * 把 `legal-evidence-rules.yaml` 的文本解析成 `LegalEvidenceRuleSet`（权重表 + 规则条目）。
 * 容错面向资产作者：单个坏规则只累积一条警告并跳过，不阻塞整体加载，引擎随后
 * 用默认权重与已解析的规则子集继续判定。
 */

import { parseDocument } from 'yaml'
import type { LegalEvidenceRule, LegalEvidenceRuleSet, LegalEvidenceType } from './types.ts'
import { LEGAL_EVIDENCE_TYPES } from './types.ts'

/** 三维度权重缺省值：资产未给出权重，或给出的不是数值时逐字段回退到本表。 */
export const DEFAULT_LEGAL_WEIGHTS = { relevance: 0.35, legality: 0.3, authenticity: 0.35 }

/** 字段是否填写了非空白内容。 */
function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** 安全取字符串。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 取数组中的字符串项。 */
function asStringArray(value: readonly unknown[]): string[] {
  return value.filter((v): v is string => typeof v === 'string')
}

/** 安全取对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 读取一个三维权重。
 *
 * 未声明该字段时静默使用默认值（资产只改了部分权重是合法配置）；声明了但不是
 * 数值时告警后回退——引号写成的 `"0.35"` 会让门槛悄悄变化，不能无痕。
 * @param raw - 资产的 weights 记录，缺省为 null。
 * @param field - 权重字段。
 * @param warnings - 累积警告。
 * @param source - 资产路径，仅用于警告文本。
 * @returns 该字段的生效权重。
 */
function readWeight(
  raw: Record<string, unknown> | null,
  field: keyof typeof DEFAULT_LEGAL_WEIGHTS,
  warnings: string[],
  source: string,
): number {
  const value = raw?.[field]
  if (value === undefined) return DEFAULT_LEGAL_WEIGHTS[field]
  if (typeof value === 'number') return value
  warnings.push(
    `法律证据权重 ${field} 必须为数值，收到 ${JSON.stringify(value)}，使用默认值 ${String(DEFAULT_LEGAL_WEIGHTS[field])}（${source}）`,
  )
  return DEFAULT_LEGAL_WEIGHTS[field]
}

/**
 * 读取一条规则的 severity；缺省为 warning，声明了非法值时告警后按 warning 处理。
 * @param record - 规则条目。
 * @param warnings - 累积警告。
 * @param source - 资产路径，仅用于警告文本。
 * @returns 生效严重度。
 */
function readSeverity(
  record: Record<string, unknown>,
  warnings: string[],
  source: string,
): 'critical' | 'warning' | 'info' {
  const value = record.severity
  if (value === undefined) return 'warning'
  if (value === 'critical' || value === 'warning' || value === 'info') return value
  warnings.push(
    `法律证据规则 ${String(record.id)} 的 severity ${JSON.stringify(value)} 非法，按 warning 处理（${source}）`,
  )
  return 'warning'
}

/**
 * 解析法律域证据规则集。
 * @param yamlText - `legal-evidence-rules.yaml` 的全文。
 * @param source - 资产路径，仅用于警告文本。
 * @returns 解析出的规则集（顶层不是对象时为 null）与累积警告。
 */
export function parseLegalRuleSet(yamlText: string, source: string): { ruleSet: LegalEvidenceRuleSet | null; warnings: string[] } {
  const warnings: string[] = []
  const doc = parseDocument(yamlText)
  if (doc.errors.length > 0) {
    warnings.push(`法律证据规则 YAML 解析失败 ${source}: ${doc.errors.map(error => error.message).join('; ')}`)
    return { ruleSet: null, warnings }
  }
  const root = asRecord(doc.toJS())
  if (root === null) {
    warnings.push(`法律证据规则文件顶层必须是对象 ${source}`)
    return { ruleSet: null, warnings }
  }
  const weightsRaw = asRecord(root.weights)
  const weights = {
    relevance: readWeight(weightsRaw, 'relevance', warnings, source),
    legality: readWeight(weightsRaw, 'legality', warnings, source),
    authenticity: readWeight(weightsRaw, 'authenticity', warnings, source),
  }
  const rules: LegalEvidenceRule[] = []
  const rawRules = root.rules
  if (Array.isArray(rawRules)) {
    for (const item of rawRules) {
      const record = asRecord(item)
      if (record === null || typeof record.id !== 'string' || typeof record.description !== 'string') {
        warnings.push(`法律证据规则条目缺少 id/description ${source}`)
        continue
      }
      const evidenceTypeRaw = asString(record.evidence_type) ?? asString(record.evidenceType)
      if (evidenceTypeRaw === undefined) {
        warnings.push(`法律证据规则 ${record.id} 缺少 evidence_type，跳过`)
        continue
      }
      const evidenceType = evidenceTypeRaw as LegalEvidenceType | 'general'
      if (evidenceType !== 'general' && !LEGAL_EVIDENCE_TYPES.includes(evidenceType)) {
        warnings.push(`法律证据规则 ${record.id} 未知证据类型 "${evidenceTypeRaw}"，跳过`)
        continue
      }
      const severity = readSeverity(record, warnings, source)
      const check = asString(record.check)
      if (check === undefined) {
        warnings.push(`法律证据规则 ${record.id} 缺少 check，跳过`)
        continue
      }
      rules.push({
        id: record.id,
        description: record.description,
        evidenceType,
        check,
        severity,
        ...(hasText(record.legalBasis) ? { legalBasis: record.legalBasis as string } : {}),
        ...(Array.isArray(record.conditions) ? { conditions: asStringArray(record.conditions) } : {}),
      })
    }
  } else {
    warnings.push(`法律证据规则文件缺少 rules 数组 ${source}`)
  }
  return { ruleSet: { weights, rules }, warnings }
}
