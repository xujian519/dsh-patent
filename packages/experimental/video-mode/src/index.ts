/**
 * Experimental video production mode. One service provides `ctx.media`, a
 * deterministic synthetic provider, a local ComfyUI provider, cloud MiniMax-H3
 * video, MiniMax speech, and SiliconFlow Wan2.2 image-to-video providers, and
 * four model-facing tools: `media`, `video_project`, `video_assemble`, and
 * `video_deliver`. The project document and the EDL are the durable,
 * reproducible contracts; the service owns provider selection and task
 * retention.
 *
 * This package is an evaluated prototype. The provider seam, the project
 * document, and the EDL are designed for promotion into separate `media/` and
 * `video/` packages once a second provider and the Web studio land.
 * @module @deepseek-ai/dsh-video-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import { MediaRuntime, type MediaRuntimeConfig } from './media.ts'

export {
  Config,
  SYNTHETIC_IMAGE_MODEL,
  SYNTHETIC_PROVIDER_ID,
  SYNTHETIC_SPEECH_MODEL,
  SYNTHETIC_VIDEO_MODEL,
  SyntheticMediaProvider,
  estimateCost,
  resolveComfyUi,
  resolveMediaConfig,
  resolveMiniMax,
  resolveMiniMaxSpeech,
  resolveSiliconFlow,
} from './media.ts'
export type {
  ComfyUiConfig,
  ComfyUiImageConfig,
  ComfyUiVideoConfig,
  MediaRuntimeConfig,
  MiniMaxConfig,
  MiniMaxSpeechConfig,
  ResolvedMediaConfig,
  SiliconFlowConfig,
} from './media.ts'
export { MediaRuntime }

/**
 * Plugin entry. It extends the service so the entry file declares the Config
 * the Loader reads and the constructor the config catalog parses.
 */
export default class VideoMode extends MediaRuntime {
  /**
   * @param ctx - owning plugin context.
   * @param config - deployment configuration; omitted fields use defaults.
   */
  constructor(ctx: Context, config: MediaRuntimeConfig = {}) {
    super(ctx, config)
  }
}
export {
  COMFYUI_IMAGE_MODEL,
  COMFYUI_PROVIDER_ID,
  COMFYUI_VIDEO_MODEL,
  ComfyUiMediaProvider,
  attachStartImage,
  canvasFor,
  fillWorkflow,
  frameCountFor,
  loadWorkflow,
  shortSideOf,
} from './comfyui.ts'
export type { ComfyUiImageSettings, ComfyUiSettings, ComfyUiVideoSettings, FetchLike, WorkflowValues } from './comfyui.ts'
export { WAN22_TI2V_WORKFLOW, Z_IMAGE_WORKFLOW } from './comfyui-workflows.ts'
export {
  MINIMAX_ASPECT_RATIOS,
  MINIMAX_PROVIDER_ID,
  MINIMAX_VIDEO_MODEL,
  MiniMaxMediaProvider,
} from './minimax.ts'
export type { MiniMaxFetchLike, MiniMaxResolution, MiniMaxSettings } from './minimax.ts'
export {
  MINIMAX_SPEECH_EMOTIONS,
  MINIMAX_SPEECH_MODEL,
  MINIMAX_SPEECH_PROVIDER_ID,
  MINIMAX_SPEECH_VOICE,
  MiniMaxSpeechProvider,
  billingCharsOf,
} from './minimax-speech.ts'
export type { MiniMaxSpeechEmotion, MiniMaxSpeechSettings } from './minimax-speech.ts'
export {
  SILICONFLOW_DURATION_SEC,
  SILICONFLOW_IMAGE_SIZES,
  SILICONFLOW_PROVIDER_ID,
  SILICONFLOW_VIDEO_MODEL,
  SiliconFlowMediaProvider,
} from './siliconflow.ts'
export type { SiliconFlowSettings } from './siliconflow.ts'
export type { ComfyWorkflow, ComfyWorkflowNode } from './comfyui-workflows.ts'
export { colorFor, silentWav, solidPng } from './fixture-bytes.ts'

export {
  DEFAULT_CANVAS,
  assemble,
  buildFfmpegArgs,
  clipDuration,
  edlDuration,
  parseProbe,
  probeMedia,
  validateEdl,
} from './edl.ts'
export type { AssembleOptions, AssemblyResult, MediaProbe } from './edl.ts'

export {
  PROJECT_SCHEMA_VERSION,
  VIDEO_ROOT,
  missingShotClips,
  mutateProjectFile,
  newProject,
  parseProject,
  projectCost,
  projectPathFor,
  projectSchema,
  readProject,
  readProjectText,
  recordRender,
  removeShot,
  serializeProject,
  slugify,
  upsertShot,
  validateProject,
  withProjectLock,
  writeProject,
} from './project.ts'
export type { NewProject, ProjectFileIo } from './project.ts'

export {
  BUDGET_LEDGER_FILE,
  STORE_SCHEMA_VERSION,
  TASK_JOURNAL_FILE,
  appendLedgerEntry,
  findTaskRecord,
  forgetTask,
  ledgerCost,
  readLedger,
  readTaskRecords,
  recordTask,
  requestOfTask,
  storePathOf,
  taskRequestOf,
  writeTaskRecords,
} from './store.ts'

export { createAssembleTool } from './tools/assemble.ts'
export { createDeliverTool } from './tools/deliver.ts'
export { createMediaTool } from './tools/media.ts'
export { createProjectTool } from './tools/project.ts'

export {
  MediaFailure,
} from './types.ts'
export type {
  Edl,
  EdlAudioClip,
  EdlVisualClip,
  MediaArtifact,
  MediaCost,
  MediaCurrency,
  MediaEstimate,
  MediaFailureCode,
  MediaKind,
  MediaLedgerEntry,
  MediaModel,
  MediaPendingTask,
  MediaPrice,
  MediaProvider,
  MediaReference,
  MediaRequest,
  MediaSubtitleCue,
  MediaTask,
  MediaTaskError,
  MediaTaskRecord,
  MediaTaskRequest,
  MediaTaskStatus,
  VideoProject,
  VideoRender,
  VideoShot,
} from './types.ts'
