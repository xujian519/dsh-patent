/* jscpd:ignore-start -- deliberate mirror of tool-pwsh-persistent (persistent-pty note 2026-08-11-pwsh-persistent-pty):
   both persistent shell tools tell the model the same facts about command timeouts and terminal scrollback. */
/**
 * Model-facing timeout and clipping notices for the persistent bash tool.
 * @module @deepseek-ai/dsh-tool-bash-persistent
 */

/**
 * State that only part of a command's output is present, including output the
 * terminal already dropped from its bounded scrollback.
 */
export const TRUNCATED_NOTICE = '<response clipped><NOTE>Only part of this command output is shown. The persistent shell keeps a bounded amount of output, and older lines can already be gone from the terminal scrollback. Re-run a narrower command (filter or page the output inside the command) to see the rest.</NOTE>'

/** State that the earliest retained output follows a dropped prefix. */
export const LOST_PREFIX_NOTICE = '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n'

/**
 * Report a command that ran into its configured wall-clock limit.
 * @param timeoutMs - Wall-clock limit configured for the command.
 * @returns The first line of the timeout result.
 */
export function timeoutNotice(timeoutMs: number): string {
  return `Your command timed out after ${Math.round(timeoutMs / 1000)} seconds. Below is partial output:`
}
/* jscpd:ignore-end */
