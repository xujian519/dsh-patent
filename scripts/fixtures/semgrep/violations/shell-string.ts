/** Fixture: `dsh-no-shell-string` must report the calls below. */

import { exec, execSync } from 'node:child_process'

/**
 * List a directory by interpolating it into a shell command.
 * @param directory - path to list.
 * @param done - receives the command outcome.
 */
export function listDirectory(directory: string, done: (error: Error | null) => void): void {
  exec(`ls ${directory}`, done)
}

/**
 * Read a file by interpolating it into a shell command.
 * @param path - file to read.
 * @returns the command output.
 */
export function readFile(path: string): string {
  return execSync('cat ' + path).toString()
}
