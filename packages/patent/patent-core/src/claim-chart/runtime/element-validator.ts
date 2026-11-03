/**
 * 要素校验（纯函数）：LLM 拆分的要素必须与权利要求原文逐词一致
 * （剥离全部空白后为连续子串，容忍 PDF 提取的换行/多空格折行），
 * 编号（数字+小写字母）唯一且连续无跳号 —— 防幻觉拆分。
 */

import type { ClaimElement } from '../protocol/types.ts'

/** 要素校验结果：成功时返回元素列表，失败时返回错误列表。 */
export type ElementValidationResult = { ok: true; elements: ClaimElement[] } | { ok: false; errors: string[] }

/**
 * 校验权利要求原文的编号结构：权项号唯一、从 1 开始、连续无跳号。
 *
 * 直接扫描原始文本，不经过 `splitClaimSegments` 的 Map.set（Map 会把重复编号
 * 的后者覆盖前者，丢失唯一性信息）。
 *
 * 无编号（单条 claim）时返回空错误列表。
 *
 * @param claimText - 权利要求原文。
 * @returns 错误列表；全部合式时为空数组。
 */
export function validateClaimTextStructure(claimText: string): string[] {
  const errors: string[] = []
  const numberRe = /^\s*(\d+)[.、．]\s*/
  const seen = new Set<number>()
  let firstNo: number | undefined
  for (const line of claimText.split(/\n/)) {
    const m = numberRe.exec(line)
    if (!m) continue
    const no = Number(m[1])
    if (seen.has(no)) errors.push(`权项号 ${no} 重复出现`)
    seen.add(no)
    firstNo ??= no
  }
  if (firstNo === undefined) return errors // 无编号输入（单条 claim）：跳过编号校验
  if (firstNo !== 1) errors.push(`权项号必须从 1 开始，实际首个编号为 ${firstNo}`)
  let previous: number | undefined
  for (const no of [...seen].sort((a, b) => a - b)) {
    if (previous !== undefined && no !== previous + 1) {
      errors.push(`权项号跳号：缺少 ${previous + 1}，直接出现 ${no}`)
      break
    }
    previous = no
  }
  return errors
}

/**
 * 将连续空白折叠为单个空格并去除首尾空白。
 * @param text - 输入文本。
 * @returns 规范化后的文本。
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 剥离全部空白字符。
 * @param text - 输入文本。
 * @returns 不含空白的文本。
 */
export function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

const ELEMENT_ID_RE = /^(\d+)([a-z]+)$/

/**
 * 按行首 "N. / N、 / N．" 切分权利要求文本为 { claimNo → 段落文本 }。
 * 无编号（单条 claim）或非行首编号时返回空 Map，调用方回退全文校验。
 * @param claimText - 权利要求原文（可含多行与编号前缀）。
 * @returns claimNo 到段落文本的映射。
 */
export function splitClaimSegments(claimText: string): Map<number, string> {
  const segments = new Map<number, string>()
  let current: { no: number; lines: string[] } | null = null
  const flush = () => {
    if (current) segments.set(current.no, current.lines.join('\n'))
  }
  for (const line of claimText.split(/\n/)) {
    const m = /^\s*(\d+)[.、．]\s*/.exec(line)
    if (m) {
      flush()
      current = { no: Number(m[1]), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return segments
}

/**
 * 校验拆分要素与权利要求原文的一致性（编号唯一连续、原文连续子串）。
 * @param elements - 待校验的要素列表。
 * @param claimText - 权利要求原文。
 * @returns 校验结果：成功时返回元素，失败时返回错误列表。
 */
export function validateElements(elements: ClaimElement[], claimText: string): ElementValidationResult {
  const errors: string[] = []
  errors.push(...validateClaimTextStructure(claimText))
  const segments = splitClaimSegments(claimText)
  const normalizedClaim = stripWhitespace(claimText)
  if (normalizedClaim.length === 0) {
    errors.push('权利要求原文为空')
    return { ok: false, errors }
  }
  if (elements.length === 0) {
    errors.push('要素列表为空')
    return { ok: false, errors }
  }

  const seen = new Set<string>()
  const byClaim = new Map<number, string[]>()
  for (const el of elements) {
    if (seen.has(el.id)) {
      errors.push(`要素编号重复: ${el.id}`)
      continue
    }
    seen.add(el.id)

    const m = ELEMENT_ID_RE.exec(el.id)
    const claimNoRaw = m?.[1]
    const suffix = m?.[2]
    if (claimNoRaw === undefined || suffix === undefined) {
      errors.push(`要素编号格式非法（应为 数字+小写字母，如 1a）: ${el.id}`)
      continue
    }
    const claimNo = Number(claimNoRaw)
    if (claimNo !== el.claimNo) {
      errors.push(`要素 ${el.id} 的 claimNo(${el.claimNo}) 与编号前缀(${claimNo})不一致`)
    }
    const letters = byClaim.get(claimNo) ?? []
    letters.push(suffix)
    byClaim.set(claimNo, letters)

    const text = stripWhitespace(el.text)
    if (text.length === 0) {
      errors.push(`要素 ${el.id} 文本为空`)
      continue
    }
    // 子串校验按要素归属的 claim 段落进行（claimNo 无对应段时回退全文，
    // 兼容无编号的单条 claim 输入），防止跨 claim 借用他条文本蒙混过关。
    const segment = segments.get(claimNo)
    const scopeText = segment !== undefined ? stripWhitespace(segment) : normalizedClaim
    if (!scopeText.includes(text)) {
      errors.push(`要素 ${el.id} 不是权利要求原文的连续子串（claim ${claimNo} 段内未找到）: "${text.slice(0, 50)}…"`)
    }
  }

  for (const [claimNo, letters] of byClaim) {
    letters.sort()
    for (let i = 0; i < letters.length; i += 1) {
      const expected = String.fromCharCode('a'.charCodeAt(0) + i)
      if (letters[i] !== expected) {
        errors.push(`权利要求 ${claimNo} 要素编号跳号：期望 ${claimNo}${expected}，实际含 ${claimNo}${letters[i]}`)
        break
      }
    }
  }

  return errors.length === 0 ? { ok: true, elements } : { ok: false, errors }
}
