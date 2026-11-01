/**
 * Video-project discovery: a turn-scoped node records the resolved path every
 * settled `video_project` call published in its result metadata, and the
 * session-wide view folds those turns into one first-seen list. Media calls
 * bump the same revision, because a settled generation changes the ledger and
 * the task journal beside the project without touching its document.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { isRecord } from '@deepseek-ai/dsh-value'
import type {
  ConversationNodeDefinition, ConversationTimelineSnapshot, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The production tool whose settled results name a project file. */
const VIDEO_PROJECT_TOOL = 'video_project'

/** The media tool whose settlement changes the ledger or the task journal. */
const VIDEO_MEDIA_TOOL = 'media'

/** One project the Session has opened, with the result seq that first named it. */
interface VideoProjectEntry {
  /** Absolute project file path as the Host resolved it. */
  readonly path: string
  /** Result event seq that first named this project. */
  readonly seq: number
}

/** Turn-scoped project facts published under `videoProjects`. */
export interface VideoTurnProjects {
  /** Projects first named by this turn. */
  readonly projects: readonly VideoProjectEntry[]
  /** Highest settled video-tool seq in this turn, or 0 when none settled. */
  readonly revision: number
}

/** Studio discovery snapshot: session-wide projects in first-seen order. */
export interface VideoProjectsSnapshot {
  /** Distinct project paths, first-seen order. */
  readonly projects: readonly string[]
  /** Highest settled video-tool seq across the window; re-read files when it moves. */
  readonly revision: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Projects and the freshness revision accumulated in one Turn. */
    videoProjects: VideoTurnProjects
  }

  interface ConversationViewSnapshotMap {
    /** Session-wide project paths folded from every Turn. */
    videoProjects: VideoProjectsSnapshot
  }
}

/** Stable target key the studio view reads from the session snapshot. */
export const VIDEO_PROJECTS_TARGET = 'videoProjects'

interface CallEntry {
  readonly name: string
}

interface VideoProjectsState extends VideoTurnProjects {
  readonly turn: number
  readonly calls: ReadonlyMap<string, CallEntry>
}

/**
 * Read the Host-resolved project path from one tool result's presentation metadata.
 * @param meta - the `meta` field of a `tool/result` event.
 * @returns the absolute path, or undefined when the result carries none.
 */
export function projectPathOfResult(meta: unknown): string | undefined {
  if (!isRecord(meta) || typeof meta.projectPath !== 'string') return undefined
  return meta.projectPath.trim().length === 0 ? undefined : meta.projectPath
}

/**
 * Whether one settled tool changes the files the studio reads.
 * @param name - the tool name recorded on the call.
 * @returns true for the project document, the media ledger, and the task journal.
 */
export function refreshesStudio(name: string): boolean {
  return name === VIDEO_PROJECT_TOOL || name === VIDEO_MEDIA_TOOL
}

/** Turn-local accumulator; it publishes a view node, never chat content. */
export const videoProjectsDefinition: ConversationNodeDefinition<VideoProjectsState> = {
  kind: 'videoProjects',
  /* jscpd:ignore-start -- turn-local tool-call accumulators share the definition lifecycle */
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('videoProjects start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), projects: [], revision: 0 }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(String(match.event.data.callId), { name: match.event.data.name })
      return { ...context.state, calls }
    }
    /* jscpd:ignore-end */
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.isError === true) return context.state
    const call = context.state.calls.get(String(match.event.data.message.source.callId))
    if (call === undefined || !refreshesStudio(call.name)) return context.state
    const revision = Math.max(context.state.revision, match.event.seq)
    if (call.name !== VIDEO_PROJECT_TOOL) return { ...context.state, revision }
    const path = projectPathOfResult(match.event.data.meta)
    if (path === undefined || context.state.projects.some(entry => entry.path === path)) {
      return { ...context.state, revision }
    }
    return { ...context.state, revision, projects: [...context.state.projects, { path, seq: match.event.seq }] }
  },
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: 'videoProjects',
      value: { projects: context.state.projects, revision: context.state.revision },
    },
}

const EMPTY: VideoProjectsSnapshot = { projects: [], revision: 0 }

function projectsFromTimeline(timeline: ConversationTimelineSnapshot): VideoProjectsSnapshot {
  const projects: string[] = []
  const seen = new Set<string>()
  let revision = 0
  for (const turn of timeline.turns.values()) {
    const data = turn.data.get('videoProjects')
    if (data === undefined) continue
    revision = Math.max(revision, data.revision)
    for (const entry of data.projects) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      projects.push(entry.path)
    }
  }
  return projects.length === 0 && revision === 0 ? EMPTY : { projects, revision }
}

class VideoProjectsBuilder implements ConversationViewBuilder<ConversationViewNode, VideoProjectsSnapshot> {
  readonly empty = EMPTY

  /**
   * Rebuild the session-wide snapshot after a structural change.
   * @param input - current nodes and the folded timeline.
   * @returns distinct project paths and the highest freshness revision.
   */
  replace(input: {
    readonly nodes: readonly ConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): VideoProjectsSnapshot {
    return projectsFromTimeline(input.timeline)
  }

  /**
   * Rebuild after an appended turn; the fold is cheap and order-sensitive.
   * @param input - upserted nodes and the folded timeline.
   * @returns distinct project paths and the highest freshness revision.
   */
  apply(input: {
    readonly upserts: readonly ConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): VideoProjectsSnapshot {
    return projectsFromTimeline(input.timeline)
  }
}

/** Isolated per-session builder registered under {@link VIDEO_PROJECTS_TARGET}. */
export const videoProjectsViewDefinition: ConversationViewDefinition<ConversationViewNode, VideoProjectsSnapshot> = {
  target: VIDEO_PROJECTS_TARGET,
  create: () => new VideoProjectsBuilder(),
}
