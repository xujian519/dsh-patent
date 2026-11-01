/**
 * 撰写域原子共用的状态读取。
 */

import { getStateString, type PipelineState } from '@deepseek-ai/dsh-patent-core'
import type { PatentType, TechDomain } from '../tool/draft-claims.ts'

const TECH_DOMAINS: readonly TechDomain[] = ['mechanical', 'electrical', 'chemical', 'software', 'general']
const PATENT_TYPES: readonly PatentType[] = ['invention', 'utility_model']

/**
 * 读取第一个 trim 后非空的字符串键。
 * @param state - 阶段执行态。
 * @param keys - 候选键，按优先级排列。
 * @returns 命中值（已 trim）；全部为空时返回空字符串。
 */
export function firstStateString(state: PipelineState, keys: readonly string[]): string {
  for (const key of keys) {
    const value = getStateString(state, key)
    if (value.trim().length > 0) return value.trim()
  }
  return ''
}

/**
 * 解析技术领域参数。
 * @param state - 阶段执行态。
 * @returns 合法技术领域；未声明或未知值返回 undefined。
 */
export function resolveTechDomain(state: PipelineState): TechDomain | undefined {
  const value = getStateString(state, 'tech_domain')
  return TECH_DOMAINS.find(domain => domain === value)
}

/**
 * 解析专利类型参数。
 * @param state - 阶段执行态。
 * @returns 合法专利类型；未声明或未知值返回 undefined。
 */
export function resolvePatentType(state: PipelineState): PatentType | undefined {
  const value = getStateString(state, 'patent_type')
  return PATENT_TYPES.find(type => type === value)
}
