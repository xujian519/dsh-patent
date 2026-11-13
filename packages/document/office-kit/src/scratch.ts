/** Remove expired private conversion directories left in the OS temp directory. */
import type { Dirent } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Names `mkdtemp(join(tmpdir(), 'dsh-office-kit-'))` generates: the prefix plus six alphanumeric characters. */
const SCRATCH_DIRECTORY = /^dsh-office-kit-[A-Za-z0-9]{6}$/u

/**
 * Remove real scratch directories under `root` that this provider names and that are older than `olderThanMs`.
 * Links, junctions, files, and every other name stay in place. A removal failure is reported and does not reject the sweep.
 * @param root - directory that contains scratch directories; production passes the OS temp directory.
 * @param olderThanMs - minimum age. A younger directory may still belong to a live conversion.
 * @param warn - receives one contained removal failure.
 * @returns completion after every candidate has been removed or reported.
 */
export async function sweepScratchDirectories(
  root: string, olderThanMs: number, warn: (message: string) => void,
): Promise<void> {
  const cutoff = Date.now() - olderThanMs
  const entries = await readdir(root, { withFileTypes: true }).catch((_missing: unknown) => [] as Dirent[])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SCRATCH_DIRECTORY.test(entry.name)) continue
    const path = join(root, entry.name)
    try {
      if ((await lstat(path)).mtimeMs >= cutoff) continue
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      warn(`office-kit: could not sweep scratch ${path}: ${String(error)}`)
    }
  }
}
