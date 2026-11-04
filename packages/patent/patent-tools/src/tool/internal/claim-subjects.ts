/**
 * Claim subjects read from a claims text, for the specification checks that
 * decide a defect per independent claim.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/claim-subjects
 */

import { parseClaimDocument } from '@deepseek-ai/dsh-patent-core'

/** One independent claim whose subject was read. */
export type ClaimSubject = {
  /** Claim number as written, which need not be sequential. */
  number: number
  /** The subject, trimmed; never empty. */
  subject: string
  /** The claim's full text. */
  text: string
}

/**
 * The independent claims whose subject could be read, in claim order. A
 * dependent claim's subject is read after「所述」(「所述方法」), so it repeats the
 * independent claim's subject instead of introducing its own; checking it again
 * would report one defect twice. A claim whose subject was not found is skipped
 * rather than reported, because its subject says nothing about the defect.
 * @param claims - the claims text, already known to be non-blank.
 * @returns one entry per independent claim with a non-empty subject.
 */
export function claimSubjects(claims: string): ClaimSubject[] {
  const subjects: ClaimSubject[] = []
  for (const claim of parseClaimDocument(claims).claims) {
    if (!claim.independent) continue
    const subject = claim.subject.trim()
    if (subject.length === 0) continue
    subjects.push({ number: claim.number, subject, text: claim.text })
  }
  return subjects
}
