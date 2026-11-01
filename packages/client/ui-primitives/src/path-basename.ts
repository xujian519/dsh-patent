/** Trailing path segment shared by file presenters. @module @deepseek-ai/dsh-client-ui-primitives/path-basename */

/**
 * Trailing path segment for slash- or backslash-separated paths.
 * @param path - File path or already-bare name.
 * @returns The final segment, or the whole string when separator-free.
 */
export function pathBasename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}
