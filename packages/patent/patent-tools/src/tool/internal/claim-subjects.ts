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
 * The subject read from a claim the parser did not classify: the clause before
 * the first punctuation, without the「一种」that opens a Chinese claim. The
 * parser only reads a subject after「一种」, so a claim written「治疗糖尿病的
 * 方法，其特征在于…」would otherwise be skipped and its defect never reported.
 * @param text - the claim text without its number.
 * @returns the fallback subject; empty when the claim has no leading clause.
 */
function fallbackSubject(text: string): string {
  const [head = ''] = text.split(/[，,；;。]/)
  return head.replace(/^一种/, '').trim()
}

/**
 * The independent claims whose subject could be read, in claim order. A
 * dependent claim's subject is read after「所述」(「所述方法」), so it repeats the
 * independent claim's subject instead of introducing its own; checking it again
 * would report one defect twice. A claim whose subject was not found is
 * skipped rather than reported, because its subject says nothing about the
 * defect — except for an independent claim written without「一种」, whose leading
 * clause is read instead so its subject-matter checks still run.
 * @param claims - the claims text, already known to be non-blank.
 * @returns one entry per independent claim with a non-empty subject.
 */
export function claimSubjects(claims: string): ClaimSubject[] {
  const subjects: ClaimSubject[] = []
  for (const claim of parseClaimDocument(claims).claims) {
    if (!claim.independent) continue
    const subject = claim.subject.trim() || fallbackSubject(claim.text)
    if (subject.length === 0) continue
    subjects.push({ number: claim.number, subject, text: claim.text })
  }
  return subjects
}
