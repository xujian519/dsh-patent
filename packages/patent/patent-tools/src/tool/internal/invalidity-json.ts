/**
 * Read an invalidity conclusion out of canonical JSON or a domain object.
 * Missing lists become empty. An item that is not the expected kind is dropped.
 * An item whose `claimNo` is not a positive integer is dropped and reported as
 * a read defect: claim numbers start at 1, so a corrupt or legacy record must
 * not surface as "claim 0" in a model-facing report.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/invalidity-json
 */

import type {
  ClaimAlternative,
  ClaimNoveltyCoverage,
  ClaimRefIssue,
  DependentClaimPathIssue,
  InvalidityConclusion,
} from '@deepseek-ai/dsh-patent-core'
import { numberList, recordFlag, recordList, recordString, recordText, recordValue, textList } from './json-read.ts'

/** 读取时被丢弃的非法条目。 */
export type InvalidityReadDefect = {
  /** 条目位置，如 `novelty[0].claims[1]`。 */
  path: string
  /** 丢弃原因。 */
  reason: string
}

/** 无效宣告结论读取结果：可直接渲染的结论与被丢弃条目。 */
export type InvalidityReadResult = {
  conclusion: InvalidityConclusion
  /** 被丢弃条目的位置与原因；空数组表示输入结构合法。 */
  defects: InvalidityReadDefect[]
}

/**
 * 把读取缺陷渲染成报告行段（无缺陷时为空数组）。
 * @param defects - 读取时丢弃的条目。
 * @returns 以空行开头的小节；无缺陷时为空数组。
 */
export function renderInvalidityReadDefects(defects: readonly InvalidityReadDefect[]): string[] {
  if (defects.length === 0) return []
  return [
    '',
    `## 无效宣告结论读取缺陷（${defects.length} 条）`,
    ...defects.map(defect => `- ${defect.path}：${defect.reason}`),
  ]
}

/** 权利要求序号：从 1 开始的整数。 */
function claimNumber(value: unknown, key: string): number | undefined {
  const raw = recordValue(value, key)
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined
}

/** 记下一条 claimNo 非法（调用方随后丢弃该条目）。 */
function dropForClaimNo(defects: InvalidityReadDefect[], path: string): void {
  defects.push({ path, reason: 'claimNo 缺失或不是正整数，已丢弃该条' })
}

function readAlternative(value: unknown): ClaimAlternative {
  const missingReferredClaims = numberList(recordValue(value, 'missingReferredClaims'))
  return {
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    covered: recordFlag(value, 'covered'),
    missing: textList(recordValue(value, 'missing')),
    ...(missingReferredClaims.length > 0 ? { missingReferredClaims } : {}),
  }
}

function readNoveltyClaim(
  value: unknown,
  path: string,
  defects: InvalidityReadDefect[],
): ClaimNoveltyCoverage | undefined {
  const claimNo = claimNumber(value, 'claimNo')
  if (claimNo === undefined) {
    dropForClaimNo(defects, path)
    return undefined
  }
  const missingReferredClaims = numberList(recordValue(value, 'missingReferredClaims'))
  const alternatives = recordList(value, 'alternatives').map(readAlternative)
  return {
    claimNo,
    covered: recordFlag(value, 'covered'),
    missing: textList(recordValue(value, 'missing')),
    includesReferredClaims: recordFlag(value, 'includesReferredClaims'),
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    ...(missingReferredClaims.length > 0 ? { missingReferredClaims } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  }
}

/** 一条区别特征记录（`InvalidityConclusion['distinguishing']` 的元素）。 */
type DistinguishingEntry = InvalidityConclusion['distinguishing'][number]

/** 区别特征的一项替代方案。 */
type DistinguishingAlternative = NonNullable<DistinguishingEntry['alternatives']>[number]

function readDistinguishingAlternative(value: unknown): DistinguishingAlternative {
  return {
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    elementIds: textList(recordValue(value, 'elementIds')),
  }
}

function readDistinguishing(
  value: unknown,
  path: string,
  defects: InvalidityReadDefect[],
): DistinguishingEntry | undefined {
  const claimNo = claimNumber(value, 'claimNo')
  if (claimNo === undefined) {
    dropForClaimNo(defects, path)
    return undefined
  }
  const alternatives = recordList(value, 'alternatives').map(readDistinguishingAlternative)
  return {
    claimNo,
    elementIds: textList(recordValue(value, 'elementIds')),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  }
}

function readClaimRefIssue(
  value: unknown,
  path: string,
  defects: InvalidityReadDefect[],
): ClaimRefIssue | undefined {
  const kind = recordString(value, 'kind')
  if (kind === 'self-reference') {
    const claimNo = claimNumber(value, 'claimNo')
    if (claimNo === undefined) {
      dropForClaimNo(defects, path)
      return undefined
    }
    return { kind, claimNo }
  }
  if (kind === 'missing-reference' || kind === 'later-reference') {
    const claimNo = claimNumber(value, 'claimNo')
    if (claimNo === undefined) {
      dropForClaimNo(defects, path)
      return undefined
    }
    return { kind, claimNo, refersTo: numberList(recordValue(value, 'refersTo')) }
  }
  if (kind === 'reference-cycle') {
    const raw = numberList(recordValue(value, 'claimNos'))
    const claimNos = raw.filter(claimNo => Number.isInteger(claimNo) && claimNo >= 1)
    if (claimNos.length === 0) {
      defects.push({ path, reason: 'claimNos 不含正整数，已丢弃该条' })
      return undefined
    }
    const dropped = raw.length - claimNos.length
    if (dropped > 0) {
      defects.push({ path, reason: `claimNos 含 ${dropped} 个非正整数，已从环中剔除` })
    }
    return { kind, claimNos }
  }
  return undefined
}

function readDependentIssue(
  value: unknown,
  path: string,
  defects: InvalidityReadDefect[],
): DependentClaimPathIssue | undefined {
  if (recordString(value, 'kind') !== 'additional-features-only') return undefined
  const claimNo = claimNumber(value, 'claimNo')
  const referredClaimNo = claimNumber(value, 'referredClaimNo')
  const invalid: string[] = []
  if (claimNo === undefined) invalid.push('claimNo')
  if (referredClaimNo === undefined) invalid.push('referredClaimNo')
  if (claimNo === undefined || referredClaimNo === undefined) {
    defects.push({ path, reason: `${invalid.join('、')} 缺失或不是正整数，已丢弃该条` })
    return undefined
  }
  return {
    kind: 'additional-features-only',
    claimNo,
    referredClaimNo,
    targetId: recordText(value, 'targetId'),
    detail: recordText(value, 'detail'),
  }
}

/**
 * Project one JSON conclusion into the renderer input.
 * A non-object becomes an empty conclusion, which the renderer reports as
 * "not computed" rather than throwing on a replayed value.
 * @param value - the tool field `invalidity_conclusion`.
 * @returns the conclusion the shared renderer accepts, plus dropped-entry defects.
 */
export function readInvalidityConclusion(value: unknown): InvalidityReadResult {
  const defects: InvalidityReadDefect[] = []
  const primaryTargetId = recordString(value, 'primaryTargetId')
  const conclusion: InvalidityConclusion = {
    ...(primaryTargetId !== undefined ? { primaryTargetId } : {}),
    novelty: recordList(value, 'novelty').map((entry, entryIndex) => {
      const title = recordString(entry, 'title')
      return {
        targetId: recordText(entry, 'targetId'),
        ...(title !== undefined ? { title } : {}),
        claims: recordList(entry, 'claims').flatMap((claim, claimIndex) => {
          const path = `novelty[${entryIndex}].claims[${claimIndex}]`
          const read = readNoveltyClaim(claim, path, defects)
          return read === undefined ? [] : [read]
        }),
      }
    }),
    distinguishing: recordList(value, 'distinguishing').flatMap((entry, index) => {
      const read = readDistinguishing(entry, `distinguishing[${index}]`, defects)
      return read === undefined ? [] : [read]
    }),
    dependentClaimIssues: recordList(value, 'dependentClaimIssues').flatMap((entry, index) => {
      const read = readDependentIssue(entry, `dependentClaimIssues[${index}]`, defects)
      return read === undefined ? [] : [read]
    }),
    claimRefIssues: recordList(value, 'claimRefIssues').flatMap((entry, index) => {
      const read = readClaimRefIssue(entry, `claimRefIssues[${index}]`, defects)
      return read === undefined ? [] : [read]
    }),
  }
  return { conclusion, defects }
}
