/**
 * Produced-file text reads over the session-scoped `workspaceFiles` Remote.
 *
 * The preview takes one bounded byte window: `readBytes` with a range never
 * fails for a large file, which is what previewing a just-printed deliverable
 * needs. Print takes the complete file through `readBytes` without a range,
 * which refuses a file above the Host's full-file cap instead of returning a
 * silently cut head. Both caps are the Host's `Config`, so this plugin names
 * neither.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'

/** One read's text and whether it is the file's complete text. */
export interface ReadFileText {
  /** UTF-8 text of the read window, or of the complete file. */
  readonly content: string
  /** Whether the read stopped short of the file's end: a window cut, or a refused complete read. */
  readonly truncated: boolean
}

/**
 * A complete read's outcome: the file's text, or the Host cap that refused it.
 *
 * The cap travels with the refusal so the view renders the size the Host
 * reports instead of naming one in copy; a cap raised in `Config` reaches the
 * message with no client change.
 */
export type CompleteReadText =
  | { readonly truncated: false; readonly content: string }
  | { readonly truncated: true; readonly limitBytes: number }

/** The slice of the Client Remote these reads call. */
export interface WorkspaceFilesRemote {
  /**
   * Read one byte window of a workspace file, or its complete bytes when no
   * range is given.
   * @param sessionId - the session whose workspace resolves `path`.
   * @param path - workspace path, absolute or relative to the workspace root.
   * @param options - the window; an absent `range` reads the complete file
   * under the Host's full-file cap, and a range's absent `length` means the
   * Host's configured window cap.
   * @param signal - cancels the call.
   * @returns the window, or the failure the Host declares.
   */
  readBytes(
    sessionId: SessionId,
    path: string,
    options: WorkspaceByteReadOptions,
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileBytes>>
}

/** The produced-file reads the studio view calls, with paths resolved against the Session workspace. */
interface FileReads {
  /**
   * Read the bounded head of one produced file.
   * @param path - produced-file path as the deliverables reported it.
   * @returns the window's text, `truncated` when it stops short of the file's end.
   */
  readonly readFileText: (path: string) => Promise<ReadFileText>
  /**
   * Read one produced file completely.
   * @param path - produced-file path as the deliverables reported it.
   * @returns the complete text, or the Host cap that refused it.
   */
  readonly readFileTextComplete: (path: string) => Promise<CompleteReadText>
}

/**
 * Byte length of the UTF-8 sequence one byte leads.
 * @param lead - a byte that is not a continuation byte.
 * @returns the sequence's length in bytes; `0` when the byte leads no valid sequence.
 */
function sequenceBytes(lead: number): number {
  if ((lead & 0x80) === 0) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 0
}

/**
 * Decode one byte window as UTF-8 text.
 *
 * The Host's byte window is raw by design (no decoding, no binary rejection), so
 * the text contract lives here: a character the window cut in half is dropped
 * whole rather than decoding to replacement glyphs, and invalid UTF-8 throws
 * rather than decoding to them.
 * @param window - the Host's byte window.
 * @returns the decoded text and whether the window is the complete file.
 */
export function decodeByteWindow(window: WorkspaceFileBytes): ReadFileText {
  const bytes = window.data
  let end = bytes.length
  if (!window.eof) {
    // The window is a prefix cut at a byte boundary, so only its final sequence
    // can be incomplete; a UTF-8 sequence is at most four bytes long.
    for (let back = 1; back <= 4 && back <= end; back += 1) {
      const lead = bytes[end - back]
      if (lead === undefined || (lead & 0xc0) === 0x80) continue
      if (sequenceBytes(lead) > back) end -= back
      break
    }
  }
  return {
    content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
    truncated: !window.eof,
  }
}

/**
 * A produced-file read the studio must report.
 *
 * The `code` is the Host's wire code when the read failed there, so the view
 * localizes by code and keeps the raw message for the detail it cannot name;
 * `undefined` marks a client-side decode failure (the bytes are not UTF-8).
 */
export class WorkspaceReadError extends Error {
  /**
   * @param message - the Host's message, or the client's decode note.
   * @param code - the Host wire code when the failure came from a failed read.
   */
  constructor(message: string, readonly code: string | undefined) {
    super(message)
    this.name = 'WorkspaceReadError'
  }
}

/**
 * Bind the produced-file reads to one Client Remote face.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @param sessionId - the Session whose workspace resolves every path.
 * @param resolve - maps a produced-file path to the path the Host receives.
 * @returns the reads the studio view calls.
 */
export function createFileReads(
  remote: WorkspaceFilesRemote,
  sessionId: SessionId,
  resolve: (path: string) => string,
): FileReads {
  const decode = (path: string, window: WorkspaceFileBytes): ReadFileText => {
    try {
      return decodeByteWindow(window)
    } catch {
      // A raw byte window's one decode failure is undecodable text; the view
      // localizes the code and keeps this note as its detail.
      throw new WorkspaceReadError(`not valid UTF-8: ${path}`, undefined)
    }
  }
  return {
    readFileText: async (path: string): Promise<ReadFileText> => {
      const result = await remote.readBytes(sessionId, resolve(path), { range: {} })
      if (!result.ok) throw new WorkspaceReadError(result.error.message, result.error.code)
      return decode(path, result.value)
    },
    readFileTextComplete: async (path: string): Promise<CompleteReadText> => {
      const result = await remote.readBytes(sessionId, resolve(path), {})
      // A range-less read reports `eof: true` on every success, so the window is
      // the complete file whenever the Host admits it.
      if (result.ok) return { truncated: false, content: decode(path, result.value).content }
      // Above the Host's full-file cap the complete read is refused, which is
      // the studio's too-large state rather than an error line.
      if (result.error.code === 'workspace-file/too-large') {
        return { truncated: true, limitBytes: result.error.details.limit }
      }
      throw new WorkspaceReadError(result.error.message, result.error.code)
    },
  }
}
