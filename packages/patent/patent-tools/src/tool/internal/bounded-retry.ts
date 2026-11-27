/**
 * Bounded retry for the patent lookups' transient upstream failures: the nuo
 * engine answers timeouts and dropped connections under load, so a short
 * backoff turns them into a slower answer instead of a failed lookup.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/bounded-retry
 */

/**
 * Wait for the given delay, ending early when the caller aborts.
 *
 * A plain `setTimeout` would keep the caller waiting out the whole backoff after
 * it cancelled, which contradicts the contract below.
 * @param ms - backoff duration.
 * @param signal - caller cancellation; an already-aborted signal resolves at once.
 * @returns a promise that settles at the deadline or on abort.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run `attempt` until its result is not retryable, the bounded backoff is
 * exhausted, or the caller aborts.
 * @param attempt - one attempt at the upstream call.
 * @param retryable - whether a settled result is worth another attempt.
 * @param retryDelaysMs - backoff before each repeat attempt; its length caps the retries.
 * @param signal - aborts the retry loop; omitted means the loop never aborts.
 * @returns the last result and the total attempts made.
 */
export async function retryBounded<T>(
  attempt: () => Promise<T>,
  retryable: (result: T) => boolean,
  retryDelaysMs: readonly number[],
  signal?: AbortSignal,
): Promise<{ result: T; attempts: number }> {
  let result = await attempt()
  let attempts = 1
  for (const delayMs of retryDelaysMs) {
    if (!retryable(result) || isAborted(signal)) break
    await delay(delayMs, signal)
    // 退避期间被取消：不再发起这次尝试。
    if (isAborted(signal)) break
    result = await attempt()
    attempts += 1
  }
  return { result, attempts }
}

/**
 * Read the abort state again after an `await`.
 *
 * A direct `signal?.aborted === true` after the first check is narrowed to
 * `false` by the type checker, which then rejects the re-read as impossible —
 * but the abort can arrive while the backoff is pending.
 * @param signal - the caller's cancellation signal.
 * @returns whether it is aborted now.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
