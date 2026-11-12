/**
 * In-process serialization for read-modify-write files. Two tool calls in one
 * host can otherwise publish the same document twice; a lock chain per key
 * makes the mutation sequence atomic within the process.
 * @module @deepseek-ai/dsh-video-mode/lock
 */

/** Tail of each key's chain; resolved promises only, so a failure cannot poison later work. */
const chains = new Map<string, Promise<void>>()

/**
 * Run one task after every earlier task for the same key.
 * @param key - lock identity, normally the resolved file path.
 * @param task - work to run with exclusive in-process access.
 * @returns the task result.
 */
export function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(task)
  const tracked = run.then(() => undefined, () => undefined)
  chains.set(key, tracked)
  return run.finally(() => {
    if (chains.get(key) === tracked) chains.delete(key)
  })
}
