/**
 * PatSnap P020（`/basic-patent-data/pdf-data`）响应的纯函数：号码形态校验、
 * 错误码分类、请求号与响应条目的对齐。
 *
 * 通道负责 HTTP、期限与取消；这里只做无副作用的判定，便于单测覆盖
 * 「批量里混入无效号」「同族替代」「整批无 PDF」这些边界。
 * @module @deepseek-ai/dsh-patent-data/patsnap-receipt
 */

import type { PatsnapFailureCode, PatsnapItemCode, PatsnapPdfLinkItem } from './types.ts'

/** PatSnap 的公开号形态：两位局代码 + 至少 5 位字母数字（`CN115690481A`、`EP2458380B1`）。 */
const PATSNAP_NUMBER_PATTERN = /^[A-Z]{2}[A-Z0-9]{5,}$/

/** 响应里代表「该号没有 PDF」的业务码；整批只含这类号时不按通道失败处理。 */
const NO_PDF_ERROR_CODE = 68300008

/** 一次响应读取的结果：对齐后的条目，或一个通道级失败。 */
export interface PatsnapPayloadRead {
  /** 按请求顺序对齐的条目。 */
  items: PatsnapPdfLinkItem[]
  /** 通道级失败；存在时 `items` 为空。 */
  failure?: { code: PatsnapFailureCode; message: string }
}

/**
 * 归一号码：去空白、连字符、冒号与斜杠，统一大写。
 * @param value - 原始号码。
 * @returns 归一后的号码。
 */
export function normalizePatsnapNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s\-:/]/g, '')
}

/**
 * 判断号码是否值得发给 PatSnap：形态不对的号直接判失败，避免浪费积分。
 * @param value - 原始号码。
 * @returns 形态是否合法。
 */
export function isPatsnapNumber(value: string): boolean {
  return PATSNAP_NUMBER_PATTERN.test(normalizePatsnapNumber(value))
}

/**
 * 把 PatSnap 业务错误码映射成通道分类。
 * @param code - 响应里的 `error_code`。
 * @returns 通道失败分类；`no_pdf` 表示整批号都没有 PDF，应作为逐号结果处理。
 */
export function classifyPatsnapErrorCode(code: number): PatsnapFailureCode | 'no_pdf' {
  switch (code) {
    case 67200002:
      return 'rate_limited'
    case 67200003:
    case 67200008:
      return 'auth_failed'
    case 67200004:
      return 'permission_denied'
    case 67200005:
      return 'quota_exhausted'
    case 67200012:
    case 68300004:
      return 'bad_request'
    case NO_PDF_ERROR_CODE:
      return 'no_pdf'
    default:
      return 'upstream_error'
  }
}

/** 逐号失败条目。 */
function itemFailure(number: string, code: PatsnapItemCode, error: string): PatsnapPdfLinkItem {
  return { number, code, error }
}

/**
 * 读取 P020 响应并对齐到请求号。
 *
 * 成功响应按 `pn` 匹配；请求了但响应没返回的号记 `not_found`（PatSnap 对不存在的号
 * 静默省略，且不计费）。整批都无 PDF 时服务端回 `68300008`，此时每个请求号都记
 * `not_found`，不把整批判成通道故障。
 * @param payload - 已解析的 JSON 响应体。
 * @param requested - 本次请求的号码（已归一、去重）。
 * @returns 对齐后的条目或通道级失败。
 */
export function readPatsnapPdfPayload(payload: unknown, requested: readonly string[]): PatsnapPayloadRead {
  if (payload === null || typeof payload !== 'object') {
    return { items: [], failure: { code: 'invalid_response', message: 'PatSnap 响应不是 JSON 对象' } }
  }
  const record = payload as Record<string, unknown>
  if (typeof record.status !== 'boolean') {
    return { items: [], failure: { code: 'invalid_response', message: 'PatSnap 响应缺少 status 字段' } }
  }
  if (!record.status) {
    const rawCode = record.error_code
    const code = typeof rawCode === 'number' ? rawCode : Number.NaN
    const message = typeof record.error_msg === 'string' && record.error_msg.length > 0
      ? record.error_msg
      : `错误码 ${String(rawCode)}`
    const classified = Number.isNaN(code) ? 'invalid_response' : classifyPatsnapErrorCode(code)
    if (classified === 'no_pdf') {
      return { items: requested.map(number => itemFailure(number, 'not_found', 'PatSnap 没有该号的 PDF')) }
    }
    return { items: [], failure: { code: classified, message } }
  }

  const byNumber = new Map<string, { pdfUrl?: string; resolvedNumber?: string }>()
  const data = record.data
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const pn = typeof item.pn === 'string' ? normalizePatsnapNumber(item.pn) : ''
      if (pn.length === 0) continue
      const pdf = item.pdf
      const path = pdf !== null && typeof pdf === 'object' ? (pdf as Record<string, unknown>).path : undefined
      const resolved = typeof item.pn_related === 'string' ? normalizePatsnapNumber(item.pn_related) : undefined
      byNumber.set(pn, {
        ...(typeof path === 'string' && path.length > 0 ? { pdfUrl: path } : {}),
        ...(resolved !== undefined && resolved.length > 0 ? { resolvedNumber: resolved } : {}),
      })
    }
  }

  const items = requested.map((raw): PatsnapPdfLinkItem => {
    const number = normalizePatsnapNumber(raw)
    const hit = byNumber.get(number)
    if (hit === undefined) return itemFailure(number, 'not_found', 'PatSnap 未返回该号')
    if (hit.pdfUrl === undefined) return itemFailure(number, 'no_pdf', 'PatSnap 记录没有 PDF')
    return {
      number,
      pdfUrl: hit.pdfUrl,
      ...(hit.resolvedNumber === undefined ? {} : { resolvedNumber: hit.resolvedNumber }),
    }
  })
  return { items }
}
