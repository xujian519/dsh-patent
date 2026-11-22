/** Tool-owned path resolution supplied by the existing toolview registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionDirectory } from '@deepseek-ai/dsh-api-session-controller/client/directories'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ToolFileInjected } from '../contract/slots.ts'

/**
 * Bind a toolview's path reader to its originating Session.
 * @param ctx - Tool plugin context.
 * @returns Existing Slot registration's inject callback.
 */
export function toolFileInject(ctx: Context): (sessionId: SessionId) => ToolFileInjected {
  return sessionId => ({
    resolveFilePath: path => resolveWorkspacePath(sessionDirectory(ctx.sessions, sessionId), path),
  })
}
