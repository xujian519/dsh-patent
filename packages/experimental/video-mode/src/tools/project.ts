/**
 * The model-facing `video_project` tool: create, read, and mutate the durable
 * project document. Every mutation validates the complete document before it
 * is written, so a malformed shot cannot reach the workspace or the studio.
 * @module @deepseek-ai/dsh-video-mode/tools/project
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  mutateProjectFile,
  newProject,
  projectCost,
  projectPathFor,
  readProject,
  readProjectText,
  recordRender,
  removeShot,
  upsertShot,
  withProjectLock,
  writeProject,
} from '../project.ts'
import { MediaFailure, type VideoProject, type VideoShot } from '../types.ts'
import { workingDirectoryOf } from './shared.ts'

/** Model-visible result of one `video_project` call. */
interface ProjectToolValue {
  readonly action: string
  readonly path: string
  readonly message: string
}

/**
 * Render a compact project summary for the model.
 * @param project - current project.
 * @param path - project file path.
 * @returns a human-readable summary.
 */
function summarize(project: VideoProject, path: string): string {
  const cost = projectCost(project)
  const lines = [
    `Project ${project.id} at ${path}: ${project.shots.length} shots, ${project.renders.length} renders, `
    + `${cost.toFixed(2)}/${project.budgetCny.toFixed(2)} CNY, target ${project.targetSeconds}s ${project.aspect}.`,
  ]
  for (const shot of project.shots) {
    lines.push(`${String(shot.index).padStart(2, '0')} ${shot.id} [${shot.status}] ${shot.durationSec}s ${shot.prompt.slice(0, 100)}`)
  }
  return lines.join('\n')
}

/**
 * Apply one mutation under the in-process project lock and publish it only
 * when no other writer changed the document since it was read.
 * @param ctx - tool context.
 * @param path - project path.
 * @param cwd - Session working directory.
 * @param signal - caller cancellation.
 * @param apply - pure mutation.
 * @returns the written project.
 */
async function mutateProject(
  ctx: Context,
  path: string,
  cwd: string,
  signal: AbortSignal,
  apply: (project: VideoProject) => VideoProject,
): Promise<VideoProject> {
  const target = await ctx.fs.resolve(path, { cwd })
  return withProjectLock(ctx.fs.processPath(target), () => mutateProjectFile({
    path,
    read: () => readProjectText(ctx, path, cwd, signal),
    write: async (text) => { await ctx.fs.writeText(target, text, undefined, signal) },
  }, apply))
}

/**
 * Convert one model-supplied shot into the stored shape.
 * @param value - validated tool argument.
 * @returns the shot document.
 */
function shotFrom(value: {
  id: string
  index: number
  prompt: string
  duration_sec: number
  status: VideoShot['status']
  keyframe_path?: string
  clip_path?: string
  provider?: string
  model?: string
  cost_cny?: number
}): VideoShot {
  return {
    id: value.id,
    index: value.index,
    prompt: value.prompt,
    durationSec: value.duration_sec,
    status: value.status,
    ...value.keyframe_path === undefined ? {} : { keyframePath: value.keyframe_path },
    ...value.clip_path === undefined ? {} : { clipPath: value.clip_path },
    ...value.provider === undefined ? {} : { provider: value.provider },
    ...value.model === undefined ? {} : { model: value.model },
    ...value.cost_cny === undefined ? {} : { costCny: value.cost_cny },
  }
}

/**
 * Create the `video_project` tool.
 * @param ctx - plugin context.
 * @returns the registry-ready tool.
 */
export function createProjectTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'video_project',
    description: 'Create and edit the durable video production document. The project file is the single source of truth '
      + 'for shots, selected clips, renders, and the budget; the video studio reads the same file. '
      + 'Actions: `init` creates `video/<id>/project.json`; `read` returns it; `upsert_shot` adds or replaces one shot; '
      + '`remove_shot` deletes one; `record_render` appends a finished output. '
      + 'Call `init` once, then `upsert_shot` for every storyboard shot before generating media. '
      + 'Every path, including the project file and shot media paths, is relative to the Session working directory.',
    parameters: {
      action: { type: 'string', required: true, enum: ['init', 'read', 'upsert_shot', 'remove_shot', 'record_render'] },
      project_path: { type: 'string', description: 'Project file path. Required for every action except init.' },
      title: { type: 'string', description: 'Display title. Required for init.' },
      id: { type: 'string', description: 'Project id for init; derived from the title when omitted.' },
      aspect: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: 'Output aspect ratio. Defaults to 9:16.' },
      target_seconds: { type: 'number', description: 'Planned duration in seconds. Defaults to 45.' },
      budget_cny: { type: 'number', description: 'Hard budget in CNY. Defaults to 50.' },
      shot: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          index: { type: 'integer', required: true },
          prompt: { type: 'string', required: true },
          duration_sec: { type: 'number', required: true },
          status: { type: 'string', required: true, enum: ['draft', 'ready', 'generating', 'failed'] },
          keyframe_path: { type: 'string' },
          clip_path: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          cost_cny: { type: 'number' },
        },
      },
      shot_id: { type: 'string', description: 'Shot id for remove_shot.' },
      render: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          duration_sec: { type: 'number' },
          cost_cny: { type: 'number' },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          path: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      // The studio discovers productions from settled calls; this is the
      // authoritative resolved path, which a client cannot derive from a title.
      presentationMeta: (_args, value) => ({ projectPath: value.path }),
    },
    async execute(args, exec): Promise<ProjectToolValue> {
      const cwd = await workingDirectoryOf(ctx, exec)
      switch (args.action) {
        case 'init': {
          if (args.title === undefined) throw new MediaFailure('video_project init requires `title`', 'MEDIA_PROJECT_INVALID')
          const project = newProject({
            title: args.title,
            ...args.id === undefined ? {} : { id: args.id },
            ...args.aspect === undefined ? {} : { aspect: args.aspect },
            ...args.target_seconds === undefined ? {} : { targetSeconds: args.target_seconds },
            ...args.budget_cny === undefined ? {} : { budgetCny: args.budget_cny },
          })
          const path = projectPathFor(cwd, project.id)
          const target = await writeProject(ctx, path, project, cwd, exec.signal)
          const resolved = ctx.fs.processPath(target)
          return {
            action: 'init',
            path: resolved,
            message: summarize(project, resolved),
          }
        }
        case 'read': {
          const path = requirePath(args.project_path)
          const project = await readProject(ctx, path, cwd, exec.signal)
          return { action: 'read', path, message: JSON.stringify(project, null, 2) }
        }
        case 'upsert_shot': {
          const path = requirePath(args.project_path)
          if (args.shot === undefined) throw new MediaFailure('video_project upsert_shot requires `shot`', 'MEDIA_PROJECT_INVALID')
          const shot = shotFrom(args.shot)
          const updated = await mutateProject(ctx, path, cwd, exec.signal, project => upsertShot(project, shot))
          return { action: 'upsert_shot', path, message: summarize(updated, path) }
        }
        case 'remove_shot': {
          const path = requirePath(args.project_path)
          const shotId = args.shot_id
          if (shotId === undefined) throw new MediaFailure('video_project remove_shot requires `shot_id`', 'MEDIA_PROJECT_INVALID')
          const updated = await mutateProject(ctx, path, cwd, exec.signal, project => removeShot(project, shotId))
          return { action: 'remove_shot', path, message: summarize(updated, path) }
        }
        case 'record_render': {
          const path = requirePath(args.project_path)
          if (args.render === undefined) throw new MediaFailure('video_project record_render requires `render`', 'MEDIA_PROJECT_INVALID')
          const render = {
            id: args.render.id,
            path: args.render.path,
            createdAt: new Date().toISOString(),
            ...args.render.duration_sec === undefined ? {} : { durationSec: args.render.duration_sec },
            ...args.render.cost_cny === undefined ? {} : { costCny: args.render.cost_cny },
          }
          const updated = await mutateProject(ctx, path, cwd, exec.signal, project => recordRender(project, render))
          return { action: 'record_render', path, message: summarize(updated, path) }
        }
      }
    },
  })
}

/**
 * Require a project path for actions that read an existing document.
 * @param path - model-supplied path.
 * @returns the non-empty path.
 * @throws {@link MediaFailure} when the path is absent.
 */
function requirePath(path: string | undefined): string {
  if (path === undefined || path.trim().length === 0) {
    throw new MediaFailure('video_project requires `project_path` for this action', 'MEDIA_PROJECT_INVALID')
  }
  return path
}
