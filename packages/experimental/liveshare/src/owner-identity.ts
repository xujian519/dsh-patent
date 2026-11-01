/** Owner identity status the owner host reports to its own browser, and to no one else. */

export type { ClaimOutcome, OwnerIdentityState, OwnerIdentityStatus } from './share-api-types.ts'

/**
 * Label a verified subject that carries no display name.
 *
 * The label comes from the identity itself, so no surface borrows the signed-in viewer's name and
 * none invents one from an unverified display name. The owner host names the owner a reader sees
 * with it when the credential carries no display name of its own.
 * @param subjectId - Verified subject the share belongs to.
 * @returns The trailing part of the subject, long enough to tell two subjects apart by eye.
 */
export function identitySubjectLabel(subjectId: string): string {
  const trimmed = subjectId.trim()
  const tail = trimmed.slice(trimmed.lastIndexOf(':') + 1)
  return tail === '' ? trimmed : tail
}
