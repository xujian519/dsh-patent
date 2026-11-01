/** Startup deadline that turns a stalled shell start into a reported failure. */

/**
 * Milliseconds the shell allows the profile transaction and backend to
 * finish. A profile verification pass hashes the packaged seed and the
 * profile's local tarballs, and the backend boots every installed plugin, so
 * the limit covers both on a slow disk while still bounding a stuck start.
 */
const DESKTOP_STARTUP_TIMEOUT_MS = 180_000

/**
 * Reject when one startup stage outlives the deadline.
 *
 * The shell previously waited indefinitely: a stage that never settled left a
 * running process with no window, no backend, and nothing on stderr, which is
 * indistinguishable from a slow start. Naming the stage makes that state
 * reportable through the shell's own startup failure dialog.
 * @param stage - stage description used in the failure message, phrased as a gerund.
 * @param operation - the stage's promise.
 * @param timeoutMs - deadline in milliseconds.
 * @returns the stage result once it settles before the deadline.
 */
export async function withStartupDeadline<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number = DESKTOP_STARTUP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`dsh desktop: startup did not finish ${stage} within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
