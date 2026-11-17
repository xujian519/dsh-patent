/**
 * Read an invalidity conclusion out of canonical JSON or a domain object.
 * Missing lists become empty. An item that is not the expected kind is dropped.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/invalidity-json
 */

import type {
  ClaimAlternative,
  ClaimNoveltyCoverage,
  ClaimRefIssue,
  DependentClaimPathIssue,
  InvalidityConclusion,
} from '@deepseek-ai/dsh-patent-core'
import { numberList, recordFlag, recordList, recordNumberOr, recordString, recordText, recordValue, textList } from './json-read.ts'

function readAlternative(value: unknown): ClaimAlternative {
  const missingReferredClaims = numberList(recordValue(value, 'missingReferredClaims'))
  return {
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    covered: recordFlag(value, 'covered'),
    missing: textList(recordValue(value, 'missing')),
    ...(missingReferredClaims.length > 0 ? { missingReferredClaims } : {}),
  }
}

function readNoveltyClaim(value: unknown): ClaimNoveltyCoverage {
  const missingReferredClaims = numberList(recordValue(value, 'missingReferredClaims'))
  const alternatives = recordList(value, 'alternatives').map(readAlternative)
  return {
    claimNo: recordNumberOr(value, 'claimNo', 0),
    covered: recordFlag(value, 'covered'),
    missing: textList(recordValue(value, 'missing')),
    includesReferredClaims: recordFlag(value, 'includesReferredClaims'),
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    ...(missingReferredClaims.length > 0 ? { missingReferredClaims } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  }
}

function readDistinguishingAlternative(value: unknown): { referredClaimNos: number[]; elementIds: string[] } {
  return {
    referredClaimNos: numberList(recordValue(value, 'referredClaimNos')),
    elementIds: textList(recordValue(value, 'elementIds')),
  }
}

function readClaimRefIssue(value: unknown): ClaimRefIssue | undefined {
  const kind = recordString(value, 'kind')
  if (kind === 'self-reference') return { kind, claimNo: recordNumberOr(value, 'claimNo', 0) }
  if (kind === 'missing-reference' || kind === 'later-reference') {
    return { kind, claimNo: recordNumberOr(value, 'claimNo', 0), refersTo: numberList(recordValue(value, 'refersTo')) }
  }
  if (kind === 'reference-cycle') return { kind, claimNos: numberList(recordValue(value, 'claimNos')) }
  return undefined
}

function readDependentIssue(value: unknown): DependentClaimPathIssue | undefined {
  if (recordString(value, 'kind') !== 'additional-features-only') return undefined
  return {
    kind: 'additional-features-only',
    claimNo: recordNumberOr(value, 'claimNo', 0),
    referredClaimNo: recordNumberOr(value, 'referredClaimNo', 0),
    targetId: recordText(value, 'targetId'),
    detail: recordText(value, 'detail'),
  }
}

/**
 * Project one JSON conclusion into the renderer input.
 * A non-object becomes an empty conclusion, which the renderer reports as
 * "not computed" rather than throwing on a replayed value.
 * @param value - the tool field `invalidity_conclusion`.
 * @returns the conclusion the shared renderer accepts.
 */
export function readInvalidityConclusion(value: unknown): InvalidityConclusion {
  const primaryTargetId = recordString(value, 'primaryTargetId')
  return {
    ...(primaryTargetId !== undefined ? { primaryTargetId } : {}),
    novelty: recordList(value, 'novelty').map((entry) => {
      const title = recordString(entry, 'title')
      return {
        targetId: recordText(entry, 'targetId'),
        ...(title !== undefined ? { title } : {}),
        claims: recordList(entry, 'claims').map(readNoveltyClaim),
      }
    }),
    distinguishing: recordList(value, 'distinguishing').map((entry) => {
      const alternatives = recordList(entry, 'alternatives').map(readDistinguishingAlternative)
      return {
        claimNo: recordNumberOr(entry, 'claimNo', 0),
        elementIds: textList(recordValue(entry, 'elementIds')),
        ...(alternatives.length > 0 ? { alternatives } : {}),
      }
    }),
    dependentClaimIssues: recordList(value, 'dependentClaimIssues').flatMap((entry) => {
      const issue = readDependentIssue(entry)
      return issue === undefined ? [] : [issue]
    }),
    claimRefIssues: recordList(value, 'claimRefIssues').flatMap((entry) => {
      const issue = readClaimRefIssue(entry)
      return issue === undefined ? [] : [issue]
    }),
  }
}
