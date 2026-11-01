/**
 * Read-only workspace probes for the studio's empty state and its stale-verdict
 * marker.
 *
 * Both probes answer questions the session log cannot: which deliverable-shaped
 * files sit in the workspace *without* a registration, and whether a registered
 * file's bytes still match the ones its check verdict described. Neither polls:
 * the empty state probes once per request and the version comparison runs when
 * the produced list changes.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceDirectoryListing, WorkspaceFileStat,
} from '@deepseek-ai/dsh-api-workspace-files/types'

/** Extensions the document workline delivers; the probe reports only these. */
const DELIVERABLE_EXTENSIONS = ['.md', '.html', '.htm', '.pdf', '.docx', '.pptx'] as const

/**
 * Directories the empty-state probe never descends into: package caches and
 * version-control metadata hold no deliverable and would drown the real ones.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.dsh', 'dist', 'build', '.cache'])

/** How deep below the workspace root the probe looks for deliverables. */
const MAX_DEPTH = 2

/** Upper bound on directories the probe lists, so one request stays bounded. */
const MAX_DIRECTORIES = 24

/** Upper bound on reported candidates, so a cluttered workspace cannot flood the panel. */
const MAX_CANDIDATES = 40

/** The slice of the Client Remote these probes call. */
export interface WorkspaceProbeRemote {
  /**
   * Stat one workspace file.
   * @param sessionId - Session whose workspace resolves `path`.
   * @param path - workspace path, absolute or relative to the workspace root.
   * @param signal - cancels the call.
   * @returns the target's metadata, or the failure the Host declares.
   */
  stat(
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileStat>>
  /**
   * List one workspace directory's direct children.
   * @param sessionId - Session whose workspace resolves `path`.
   * @param path - workspace directory path; '' is the workspace root.
   * @param signal - cancels the call.
   * @returns the listing, or the failure the Host declares.
   */
  list(
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<WorkspaceDirectoryListing>>
}

/**
 * One produced file as the probes need it: its declared spelling and, when the
 * log recorded one, its canonical identity.
 */
export interface KnownPath {
  /** The path as the tool declared it. */
  readonly path: string
  /** Host-resolved canonical path, when the log recorded one. */
  readonly identity?: string
}

/** The workspace facts the studio reads, with paths resolved against the Session workspace. */
interface WorkspaceProbe {
  /**
   * Read the current freshness token of each path.
   * @param paths - produced-file paths as the deliverables reported them.
   * @returns a version per path the Host could stat; unreadable paths are absent.
   */
  readonly statVersions: (paths: readonly string[]) => Promise<Readonly<Record<string, string>>>
  /**
   * List deliverable-shaped files that no registration recorded.
   * @param known - produced files the session log already lists.
   * @returns workspace-relative candidate paths, in listing order.
   */
  readonly unregisteredDeliverables: (known: readonly KnownPath[]) => Promise<readonly string[]>
}

/**
 * Compare one produced file with one listed path.
 *
 * Both sides go through the same `resolve`, because they arrive in different
 * spaces: the listing is workspace-relative and a canonical identity is
 * absolute. A leading `./` is spelling, not location, so it is stripped before
 * resolving — that keeps every legacy record comparable with or without one.
 * Either key may match: the identity names the bytes however the log spelled
 * them, and the declared path still answers for a record whose identity this
 * console cannot resolve. Matching on both never reports a registered file as
 * unregistered when the declared path alone already matched.
 * @param known - one produced file the log already lists.
 * @param listed - one workspace-relative path from the listing.
 * @param resolve - maps a produced-file path to the path the Host receives.
 * @returns whether the two name the same file.
 */
function samePath(known: KnownPath, listed: string, resolve: (path: string) => string): boolean {
  const joined = (value: string): string => resolve(value.replace(/^\.\//, ''))
  const target = joined(listed)
  if (joined(known.path) === target) return true
  return known.identity !== undefined && joined(known.identity) === target
}

/** Whether a listing entry name carries a deliverable extension. */
function isDeliverableName(name: string): boolean {
  const lower = name.toLowerCase()
  return DELIVERABLE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

/** Join a workspace directory path with one child name. */
function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`
}

/** Segment depth of one listed directory, with the workspace root at 0. */
function depthOf(directory: string): number {
  return directory === '' ? 0 : directory.split('/').length
}

/**
 * Bind the workspace probes to one Client Remote face.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @param sessionId - the Session whose workspace resolves every path.
 * @param resolve - maps a produced-file path to the path the Host receives.
 * @returns the probes the studio view calls.
 */
export function createWorkspaceProbe(
  remote: WorkspaceProbeRemote,
  sessionId: SessionId,
  resolve: (path: string) => string,
): WorkspaceProbe {
  const statVersions = async (paths: readonly string[]): Promise<Readonly<Record<string, string>>> => {
    const signal = new AbortController().signal
    const versions: Record<string, string> = {}
    for (const path of paths) {
      const result = await remote.stat(sessionId, resolve(path), signal)
      if (result.ok) versions[path] = result.value.version
    }
    return versions
  }

  const unregisteredDeliverables = async (known: readonly KnownPath[]): Promise<readonly string[]> => {
    const signal = new AbortController().signal
    // Breadth-first from the workspace root, listing at most MAX_DIRECTORIES
    // directories: the root is always listed first, so its files never depend
    // on how many subdirectories a workspace happens to hold.
    const pending: string[] = ['']
    let listed = 0
    const candidates: string[] = []
    // An array iterator re-reads `length` on every step, so the directories
    // appended below are visited after the ones already queued.
    for (const directory of pending) {
      if (listed >= MAX_DIRECTORIES) break
      listed += 1
      const result = await remote.list(sessionId, directory, signal)
      // A workspace root that cannot be listed is a failed probe, not an empty
      // workspace: the view distinguishes the two rather than claiming "none".
      if (!result.ok) throw new Error(result.error.message)
      for (const entry of result.value.entries) {
        const path = joinPath(directory, entry.name)
        if (entry.type === 'directory') {
          if (depthOf(directory) < MAX_DEPTH
            && !entry.name.startsWith('.')
            && !SKIPPED_DIRECTORIES.has(entry.name)) {
            pending.push(path)
          }
          continue
        }
        if (entry.type !== 'file' || !isDeliverableName(entry.name)) continue
        if (known.some(produced => samePath(produced, path, resolve))) continue
        // Every listed path is visited once, so no candidate can repeat.
        candidates.push(path)
        if (candidates.length >= MAX_CANDIDATES) return candidates
      }
    }
    return candidates
  }

  return { statVersions, unregisteredDeliverables }
}
