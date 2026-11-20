/** Fixture for `dsh-no-shell-string`: the argv form of a child process must not be reported. */

import { execFile } from 'node:child_process'

/**
 * List a directory without a shell.
 * @param directory - path to list.
 * @param done - receives the command outcome.
 */
export function listDirectory(directory: string, done: (error: Error | null) => void): void {
  execFile('ls', [directory], done)
}
