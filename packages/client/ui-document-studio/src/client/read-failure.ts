/** Localized reporting for a preview read failure. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentStudioKey } from './locales.ts'

/** One read failure, kept with the Host code so its message can be localized. */
export interface ReadFailure {
  /** The Host wire code, or `undefined` for a client-side decode failure. */
  readonly code: string | undefined
  /** The Host's message, or the client's decode note. */
  readonly message: string
}

/**
 * The failure message one read reports, localized by the Host's wire code.
 * @param failure - the read failure.
 * @param t - the studio dictionaries.
 * @returns the localized line.
 */
export function readFailureText(failure: ReadFailure, t: Translate<DocumentStudioKey>): string {
  switch (failure.code) {
    case 'workspace-file/not-found':
    case 'workspace-file/not-regular-file':
      return t('studio.error.notFound')
    case 'workspace-file/outside-workspace':
      return t('studio.error.denied')
    default:
      // A client-side decode failure carries no wire code: the bytes were not
      // UTF-8, which is the same "no text preview" outcome.
      return failure.code === undefined
        ? t('studio.error.notText')
        : t('studio.error.generic', { message: failure.message })
  }
}
