/**
 * 规则资产 YAML 的解析入口：语法失败与顶层非对象归一成同一组判定。
 *
 * 规则集、规则包清单、激活覆盖与同义词表四个加载器共用这里，只在出口处把
 * 失败映射成各自的 issues、抛错或 warning。
 * @module @deepseek-ai/dsh-patent-rule/runtime/yaml-asset
 */

import { asRecord } from '@deepseek-ai/dsh-value'
import { parseDocument } from 'yaml'

/** YAML 资产读取结果。 */
export type YamlRecordRead =
  | { readonly kind: 'record'; readonly record: Record<string, unknown> }
  | { readonly kind: 'parse-error'; readonly message: string }
  | { readonly kind: 'not-record'; readonly value: unknown }

/**
 * 解析 YAML 文本并判定顶层是否为对象。
 * @param text - YAML 原文。
 * @returns 顶层记录；`parse-error` 带解析器消息，`not-record` 带原始值。
 */
export function readYamlRecord(text: string): YamlRecordRead {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    /* v8 ignore next -- yaml parse errors always carry a message. */
    return { kind: 'parse-error', message: doc.errors[0]?.message ?? 'unknown' }
  }
  const value: unknown = doc.toJS()
  const record = asRecord(value)
  if (record === null) return { kind: 'not-record', value }
  return { kind: 'record', record }
}
