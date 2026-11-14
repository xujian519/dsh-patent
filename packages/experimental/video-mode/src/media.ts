/**
 * The experimental media runtime (`ctx.media`): one provider registry and one
 * execution path for image, video, and speech generation. Providers own their
 * transport; the runtime owns selection, bounded waits, task retention, and the
 * normalized failure vocabulary.
 *
 * The shipped synthetic provider produces deterministic fixtures so the whole
 * video pipeline can run without credentials. Cloud providers register the
 * same interface; no consumer changes.
 * @module @deepseek-ai/dsh-video-mode/media
 */

import { setTimeout as delay } from 'node:timers/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import {
  COMFYUI_IMAGE_MODEL,
  COMFYUI_VIDEO_MODEL,
  ComfyUiMediaProvider,
  type ComfyUiSettings,
} from './comfyui.ts'
import {
  MINIMAX_ASPECT_RATIOS,
  MINIMAX_VIDEO_MODEL,
  MiniMaxMediaProvider,
  type MiniMaxResolution,
  type MiniMaxSettings,
} from './minimax.ts'
import {
  MINIMAX_SPEECH_EMOTIONS,
  MINIMAX_SPEECH_MODEL,
  MINIMAX_SPEECH_VOICE,
  MiniMaxSpeechProvider,
  type MiniMaxSpeechEmotion,
  type MiniMaxSpeechSettings,
} from './minimax-speech.ts'
import {
  SILICONFLOW_IMAGE_SIZES,
  SILICONFLOW_VIDEO_MODEL,
  SiliconFlowMediaProvider,
  type SiliconFlowSettings,
} from './siliconflow.ts'
import { FAKE_MP4_BASE64 } from './fixture-mp4.ts'
import { colorFor, silentWav, solidPng } from './fixture-bytes.ts'
import { requestOfTask } from './store.ts'
import { createAssembleTool } from './tools/assemble.ts'
import { createDeliverTool } from './tools/deliver.ts'
import { createMediaTool } from './tools/media.ts'
import { createProjectTool } from './tools/project.ts'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaCost,
  type MediaCurrency,
  type MediaEstimate,
  type MediaKind,
  type MediaModel,
  type MediaProvider,
  type MediaRequest,
  type MediaSubtitleCue,
  type MediaTask,
  type MediaTaskRecord,
  type MediaTaskStatus,
} from './types.ts'

/** Provider id of the deterministic synthetic backend. */
export const SYNTHETIC_PROVIDER_ID = 'synthetic'

/** Default image model id of the synthetic backend. */
export const SYNTHETIC_IMAGE_MODEL = 'synthetic/image'

/** Default video model id of the synthetic backend. */
export const SYNTHETIC_VIDEO_MODEL = 'synthetic/video'

/** Default speech model id of the synthetic backend. */
export const SYNTHETIC_SPEECH_MODEL = 'synthetic/speech'

/** Task states after which no provider poll changes the task. */
const TERMINAL: ReadonlySet<MediaTaskStatus> = new Set(['succeeded', 'failed', 'cancelled'])

/** ComfyUI video settings a deployment may override. */
export interface ComfyUiVideoConfig {
  /** Model id reported to consumers. */
  readonly model?: string
  /** API-format workflow file; empty uses the bundled Wan 2.2 graph. */
  readonly workflowPath?: string
  /** UNET file name under `models/diffusion_models`. */
  readonly checkpoint?: string
  /** Text encoder file name under `models/text_encoders`. */
  readonly textEncoder?: string
  /** VAE file name under `models/vae`. */
  readonly vae?: string
  /** Short side of the canvas, as a `<n>p` label. */
  readonly resolution?: string
  /** Frame rate written into the clip. */
  readonly fps?: number
  /** Duration used when a request omits one. */
  readonly defaultDurationSec?: number
  /** Longest accepted request duration. */
  readonly maxDurationSec?: number
  /** Negative prompt used when a request omits one. */
  readonly negativePrompt?: string
}

/** ComfyUI image settings a deployment may override. */
export interface ComfyUiImageConfig {
  /** Model id reported to consumers. */
  readonly model?: string
  /** API-format workflow file; empty uses the bundled Z-Image graph. */
  readonly workflowPath?: string
  /** UNET file name under `models/diffusion_models`. */
  readonly checkpoint?: string
  /** Text encoder file name under `models/text_encoders`. */
  readonly textEncoder?: string
  /** VAE file name under `models/vae`. */
  readonly vae?: string
  /** Long side of a generated image in pixels. */
  readonly size?: number
}

/** MiniMax speech configuration. Credentials and origin inherit from the parent block. */
export interface MiniMaxSpeechConfig {
  /** Register the speech provider. Defaults to false. */
  readonly enabled?: boolean
  /** Speech model id. Defaults to `speech-2.8-turbo`. */
  readonly model?: string
  /** Default system voice id. Defaults to a Mandarin news anchor. */
  readonly voiceId?: string
  /** Speech speed multiplier in `[0.5, 2]`. */
  readonly speed?: number
  /** Volume multiplier in `(0, 10]`. */
  readonly vol?: number
  /** Pitch offset in `[-12, 12]`. */
  readonly pitch?: number
  /** Fixed emotion label; empty lets the model infer it from the text. */
  readonly emotion?: string
}

/** MiniMax cloud video configuration. */
export interface MiniMaxConfig {
  /** Register the provider. Defaults to false. */
  readonly enabled?: boolean
  /** Direct bearer API key for programmatic use; empty when {@link apiKeyEnv} names the credential. */
  readonly apiKey?: string
  /** Credential reference resolved per request through `ctx.credentials`, for example `MINIMAX_API_KEY`. */
  readonly apiKeyEnv?: string
  /** MiniMax API origin. */
  readonly baseUrl?: string
  /** Minimum gap between two status polls for one task. */
  readonly pollMs?: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs?: number
  /** Model id reported to consumers and submitted to the API. */
  readonly model?: string
  /** Resolution used when a request omits one; `768P` or `2K`. */
  readonly resolution?: string
  /** Duration used when a request omits one. */
  readonly defaultDurationSec?: number
  /** Longest accepted request duration. */
  readonly maxDurationSec?: number
  /** Aspect ratio used for text-to-video when the request omits one. */
  readonly aspectRatio?: string
  /** Speech synthesis overrides; omitted leaves the speech provider unregistered. */
  readonly speech?: MiniMaxSpeechConfig
}

/** SiliconFlow cloud video configuration. */
export interface SiliconFlowConfig {
  /** Register the provider. Defaults to false. */
  readonly enabled?: boolean
  /** Direct bearer API key for programmatic use; empty when {@link apiKeyEnv} names the credential. */
  readonly apiKey?: string
  /** Credential reference resolved per request through `ctx.credentials`, for example `SILICONFLOW_API_KEY`. */
  readonly apiKeyEnv?: string
  /** SiliconFlow API origin, including the `/v1` prefix. */
  readonly baseUrl?: string
  /** Minimum gap between two status polls for one task. */
  readonly pollMs?: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs?: number
  /** Model id reported to consumers and submitted to the API. */
  readonly model?: string
  /** Aspect ratio used when the request omits one. */
  readonly aspectRatio?: string
  /** Price of one completed video in major currency units. */
  readonly pricePerVideo?: number
  /** Currency of {@link pricePerVideo}; the mainland site bills CNY and the international site USD. */
  readonly currency?: MediaCurrency
}

/** Local ComfyUI backend configuration. */
export interface ComfyUiConfig {
  /** Register the provider. Defaults to false. */
  readonly enabled?: boolean
  /** ComfyUI HTTP origin. */
  readonly baseUrl?: string
  /** Minimum gap between two history polls for one task. */
  readonly pollMs?: number
  /** Failure deadline measured from submission. */
  readonly timeoutMs?: number
  /** Output subdirectory prefix the server writes into. */
  readonly outputPrefix?: string
  /** Video overrides. */
  readonly video?: ComfyUiVideoConfig
  /** Image overrides. */
  readonly image?: ComfyUiImageConfig
}

/** ComfyUI defaults; file names match the Comfy-Org repackaged weights. */
const COMFYUI_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  pollMs: 2_000,
  timeoutMs: 3_600_000,
  outputPrefix: 'dsh',
  video: {
    model: COMFYUI_VIDEO_MODEL,
    workflowPath: '',
    checkpoint: 'wan2.2_ti2v_5B_fp16.safetensors',
    textEncoder: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: 'wan2.2_vae.safetensors',
    resolution: '480p',
    fps: 24,
    defaultDurationSec: 5,
    maxDurationSec: 10,
    negativePrompt: 'blurry, low quality, watermark, text, subtitles',
  },
  image: {
    model: COMFYUI_IMAGE_MODEL,
    workflowPath: '',
    checkpoint: 'z_image_turbo_bf16.safetensors',
    textEncoder: 'qwen_3_4b.safetensors',
    vae: 'ae.safetensors',
    size: 1024,
  },
} as const

/** MiniMax defaults; the published H3 rates cover 768P and 2K. */
const MINIMAX_DEFAULTS = {
  baseUrl: 'https://api.minimax.cn',
  pollMs: 10_000,
  timeoutMs: 3_600_000,
  model: MINIMAX_VIDEO_MODEL,
  resolution: '768P' as MiniMaxResolution,
  defaultDurationSec: 5,
  maxDurationSec: 15,
  aspectRatio: '9:16',
} as const

/** MiniMax speech defaults; the turbo model keeps voiceover cost low. */
const MINIMAX_SPEECH_DEFAULTS = {
  model: MINIMAX_SPEECH_MODEL,
  voiceId: MINIMAX_SPEECH_VOICE,
  speed: 1,
  vol: 1,
  pitch: 0,
} as const

/** SiliconFlow defaults; the mainland site bills 2.00 CNY per completed video. */
const SILICONFLOW_DEFAULTS = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  pollMs: 10_000,
  timeoutMs: 3_600_000,
  model: SILICONFLOW_VIDEO_MODEL,
  aspectRatio: '9:16',
  pricePerVideo: 2,
  currency: 'CNY' as MediaCurrency,
} as const

/** Deployment configuration of the media runtime and the video tools. */
export interface MediaRuntimeConfig {
  /** Mount the synthetic provider. Defaults to true for the experimental slice. */
  readonly fakeProvider?: boolean
  /** Default image model id. */
  readonly imageModel?: string
  /** Default video model id. */
  readonly videoModel?: string
  /** Default speech model id. */
  readonly speechModel?: string
  /** Longest `media generate` wait before it returns a running task id. */
  readonly waitMs?: number
  /** Poll interval while waiting for a task. */
  readonly pollMs?: number
  /** Largest accepted artifact size in bytes. */
  readonly maxArtifactBytes?: number
  /** Retained task records; the oldest settled record is evicted first. */
  readonly maxTasks?: number
  /** ffmpeg executable name or path. */
  readonly ffmpegPath?: string
  /** ffprobe executable name or path. */
  readonly ffprobePath?: string
  /** Synthetic provider delay before it settles a task. */
  readonly syntheticLatencyMs?: number
  /** Subtitle font family passed to the burn-in filter; empty selects ffmpeg's default. */
  readonly subtitleFont?: string
  /** Single-generation cost above which the media tool requires explicit confirmation, in CNY. */
  readonly approvalThresholdCny?: number
  /** Local ComfyUI backend; omitted leaves it unregistered. */
  readonly comfyui?: ComfyUiConfig
  /** MiniMax cloud video backend; omitted leaves it unregistered. */
  readonly minimax?: MiniMaxConfig
  /** SiliconFlow cloud video backend; omitted leaves it unregistered. */
  readonly siliconflow?: SiliconFlowConfig
}

/** Media runtime configuration after defaults. */
export interface ResolvedMediaConfig {
  readonly fakeProvider: boolean
  readonly imageModel: string
  readonly videoModel: string
  readonly speechModel: string
  readonly waitMs: number
  readonly pollMs: number
  readonly maxArtifactBytes: number
  readonly maxTasks: number
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly syntheticLatencyMs: number
  readonly subtitleFont: string
  readonly approvalThresholdCny: number
  /** Resolved ComfyUI backend; present only when the config enables it. */
  readonly comfyui?: ComfyUiSettings
  /** Resolved MiniMax backend; present only when the config enables it. */
  readonly minimax?: MiniMaxSettings
  /** Resolved MiniMax speech backend; present only when the config enables it. */
  readonly minimaxSpeech?: MiniMaxSpeechSettings
  /** Resolved SiliconFlow backend; present only when the config enables it. */
  readonly siliconflow?: SiliconFlowSettings
}

/**
 * Apply deployment defaults to the user-supplied media configuration.
 * @param config - partial configuration from the Loader row or a test.
 * @returns the complete configuration.
 * @throws When a numeric bound is not a positive integer.
 */
export function resolveMediaConfig(config: MediaRuntimeConfig = {}): ResolvedMediaConfig {
  const minimax = config.minimax
  const resolved: ResolvedMediaConfig = {
    fakeProvider: config.fakeProvider ?? true,
    imageModel: config.imageModel ?? SYNTHETIC_IMAGE_MODEL,
    videoModel: config.videoModel ?? SYNTHETIC_VIDEO_MODEL,
    speechModel: config.speechModel ?? SYNTHETIC_SPEECH_MODEL,
    waitMs: config.waitMs ?? 30_000,
    pollMs: config.pollMs ?? 250,
    maxArtifactBytes: config.maxArtifactBytes ?? 512 * 1024 * 1024,
    maxTasks: config.maxTasks ?? 64,
    ffmpegPath: config.ffmpegPath ?? 'ffmpeg',
    ffprobePath: config.ffprobePath ?? 'ffprobe',
    syntheticLatencyMs: config.syntheticLatencyMs ?? 0,
    subtitleFont: config.subtitleFont ?? '',
    approvalThresholdCny: config.approvalThresholdCny ?? 10,
  }
  for (const [name, value] of [
    ['waitMs', resolved.waitMs],
    ['pollMs', resolved.pollMs],
    ['maxArtifactBytes', resolved.maxArtifactBytes],
    ['maxTasks', resolved.maxTasks],
    ['syntheticLatencyMs', resolved.syntheticLatencyMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`video mode: ${name} must be a non-negative integer`)
    }
  }
  if (resolved.waitMs === 0 || resolved.pollMs === 0 || resolved.maxTasks === 0) {
    throw new Error('video mode: waitMs, pollMs, and maxTasks must be positive')
  }
  if (!Number.isFinite(resolved.approvalThresholdCny) || resolved.approvalThresholdCny < 0) {
    throw new Error('video mode: approvalThresholdCny must be a non-negative number')
  }
  return {
    ...resolved,
    ...config.comfyui?.enabled === true
      ? { comfyui: resolveComfyUi(config.comfyui, resolved.maxArtifactBytes) }
      : {},
    ...minimax?.enabled === true
      ? { minimax: resolveMiniMax(minimax, resolved.maxArtifactBytes) }
      : {},
    ...minimax !== undefined && minimax.speech?.enabled === true
      ? { minimaxSpeech: resolveMiniMaxSpeech(minimax, resolved.maxArtifactBytes) }
      : {},
    ...config.siliconflow?.enabled === true
      ? { siliconflow: resolveSiliconFlow(config.siliconflow, resolved.maxArtifactBytes) }
      : {},
  }
}

/**
 * Apply defaults to the ComfyUI configuration and validate its bounds.
 * @param config - partial ComfyUI configuration.
 * @param maxArtifactBytes - artifact cap inherited from the media runtime.
 * @returns the complete provider settings.
 * @throws When a bound or label is invalid.
 */
export function resolveComfyUi(config: ComfyUiConfig, maxArtifactBytes: number): ComfyUiSettings {
  const settings: ComfyUiSettings = {
    baseUrl: config.baseUrl ?? COMFYUI_DEFAULTS.baseUrl,
    pollMs: config.pollMs ?? COMFYUI_DEFAULTS.pollMs,
    timeoutMs: config.timeoutMs ?? COMFYUI_DEFAULTS.timeoutMs,
    outputPrefix: config.outputPrefix ?? COMFYUI_DEFAULTS.outputPrefix,
    maxArtifactBytes,
    video: { ...COMFYUI_DEFAULTS.video, ...config.video },
    image: { ...COMFYUI_DEFAULTS.image, ...config.image },
  }
  if (settings.baseUrl.trim().length === 0) throw new Error('video mode: comfyui.baseUrl must not be empty')
  if (!Number.isSafeInteger(settings.pollMs) || settings.pollMs <= 0) {
    throw new Error('video mode: comfyui.pollMs must be a positive integer')
  }
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('video mode: comfyui.timeoutMs must be a positive integer')
  }
  if (settings.outputPrefix.trim().length === 0) throw new Error('video mode: comfyui.outputPrefix must not be empty')
  if (!Number.isFinite(settings.video.fps) || settings.video.fps <= 0 || settings.video.fps > 120) {
    throw new Error('video mode: comfyui.video.fps must be between 0 and 120')
  }
  if (!/^\d+p$/.test(settings.video.resolution)) {
    throw new Error('video mode: comfyui.video.resolution must be a label such as 480p or 720p')
  }
  if (!(settings.video.defaultDurationSec > 0)) {
    throw new Error('video mode: comfyui.video.defaultDurationSec must be positive')
  }
  if (!(settings.video.maxDurationSec >= settings.video.defaultDurationSec)) {
    throw new Error('video mode: comfyui.video.maxDurationSec must be at least defaultDurationSec')
  }
  if (!Number.isSafeInteger(settings.image.size) || settings.image.size < 256) {
    throw new Error('video mode: comfyui.image.size must be an integer of at least 256')
  }
  return settings
}

/**
 * Apply defaults to the MiniMax configuration and validate its bounds. An empty
 * key is valid configuration: the provider registers unavailable, so a preset
 * that also carries a local provider still boots without cloud credentials.
 * @param config - partial MiniMax configuration.
 * @param maxArtifactBytes - artifact cap inherited from the media runtime.
 * @returns the complete provider settings.
 * @throws When a bound, resolution, or ratio is invalid.
 */
export function resolveMiniMax(config: MiniMaxConfig, maxArtifactBytes: number): MiniMaxSettings {
  const resolution = config.resolution ?? MINIMAX_DEFAULTS.resolution
  if (resolution !== '768P' && resolution !== '2K') {
    throw new Error('video mode: minimax.resolution must be 768P or 2K')
  }
  const apiKeyEnv = (config.apiKeyEnv ?? '').trim()
  const settings: MiniMaxSettings = {
    apiKey: (config.apiKey ?? '').trim(),
    ...apiKeyEnv.length === 0 ? {} : { apiKeyEnv },
    baseUrl: (config.baseUrl ?? MINIMAX_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    pollMs: config.pollMs ?? MINIMAX_DEFAULTS.pollMs,
    timeoutMs: config.timeoutMs ?? MINIMAX_DEFAULTS.timeoutMs,
    maxArtifactBytes,
    model: config.model ?? MINIMAX_DEFAULTS.model,
    resolution,
    defaultDurationSec: config.defaultDurationSec ?? MINIMAX_DEFAULTS.defaultDurationSec,
    maxDurationSec: config.maxDurationSec ?? MINIMAX_DEFAULTS.maxDurationSec,
    aspectRatio: config.aspectRatio ?? MINIMAX_DEFAULTS.aspectRatio,
  }
  if (settings.baseUrl.length === 0) throw new Error('video mode: minimax.baseUrl must not be empty')
  if (settings.model !== MINIMAX_VIDEO_MODEL) {
    throw new Error(`video mode: minimax.model must be ${MINIMAX_VIDEO_MODEL}`)
  }
  if (!Number.isSafeInteger(settings.pollMs) || settings.pollMs <= 0) {
    throw new Error('video mode: minimax.pollMs must be a positive integer')
  }
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('video mode: minimax.timeoutMs must be a positive integer')
  }
  if (!Number.isInteger(settings.defaultDurationSec) || settings.defaultDurationSec < 4 || settings.defaultDurationSec > 15) {
    throw new Error('video mode: minimax.defaultDurationSec must be an integer from 4 to 15')
  }
  if (!Number.isInteger(settings.maxDurationSec) || settings.maxDurationSec < settings.defaultDurationSec || settings.maxDurationSec > 15) {
    throw new Error('video mode: minimax.maxDurationSec must be an integer from defaultDurationSec to 15')
  }
  if (!(MINIMAX_ASPECT_RATIOS as readonly string[]).includes(settings.aspectRatio)) {
    throw new Error(`video mode: minimax.aspectRatio must be one of ${MINIMAX_ASPECT_RATIOS.join(', ')}`)
  }
  return settings
}

/**
 * Apply defaults to the MiniMax speech configuration and validate its bounds.
 * Credentials and the API origin inherit from the parent MiniMax block, so a
 * speech-only deployment configures one key and one origin.
 * @param config - partial MiniMax configuration carrying the parent credentials.
 * @param maxArtifactBytes - artifact cap inherited from the media runtime.
 * @returns the complete speech provider settings.
 * @throws When a bound, voice id, or emotion label is invalid.
 */
export function resolveMiniMaxSpeech(config: MiniMaxConfig, maxArtifactBytes: number): MiniMaxSpeechSettings {
  const speech = config.speech ?? {}
  const apiKeyEnv = (config.apiKeyEnv ?? '').trim()
  const emotion = speechEmotionOf(speech.emotion)
  const settings: MiniMaxSpeechSettings = {
    apiKey: (config.apiKey ?? '').trim(),
    ...apiKeyEnv.length === 0 ? {} : { apiKeyEnv },
    baseUrl: (config.baseUrl ?? MINIMAX_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: (speech.model ?? MINIMAX_SPEECH_DEFAULTS.model).trim(),
    voiceId: (speech.voiceId ?? MINIMAX_SPEECH_DEFAULTS.voiceId).trim(),
    speed: speech.speed ?? MINIMAX_SPEECH_DEFAULTS.speed,
    vol: speech.vol ?? MINIMAX_SPEECH_DEFAULTS.vol,
    pitch: speech.pitch ?? MINIMAX_SPEECH_DEFAULTS.pitch,
    ...emotion === undefined ? {} : { emotion },
    maxArtifactBytes,
  }
  if (settings.baseUrl.length === 0) throw new Error('video mode: minimax.baseUrl must not be empty')
  if (settings.model.length === 0) throw new Error('video mode: minimax.speech.model must not be empty')
  if (settings.voiceId.length === 0) throw new Error('video mode: minimax.speech.voiceId must not be empty')
  if (!(settings.speed >= 0.5 && settings.speed <= 2)) {
    throw new Error('video mode: minimax.speech.speed must be between 0.5 and 2')
  }
  if (!(settings.vol > 0 && settings.vol <= 10)) {
    throw new Error('video mode: minimax.speech.vol must be greater than 0 and at most 10')
  }
  if (!Number.isInteger(settings.pitch) || settings.pitch < -12 || settings.pitch > 12) {
    throw new Error('video mode: minimax.speech.pitch must be an integer from -12 to 12')
  }
  return settings
}

/**
 * Apply defaults to the SiliconFlow configuration and validate its bounds. An
 * empty key is valid configuration: the provider registers unavailable, so a
 * preset that also carries a local provider still boots without cloud
 * credentials.
 * @param config - partial SiliconFlow configuration.
 * @param maxArtifactBytes - artifact cap inherited from the media runtime.
 * @returns the complete provider settings.
 * @throws When a bound, model, ratio, price, or currency is invalid.
 */
export function resolveSiliconFlow(config: SiliconFlowConfig, maxArtifactBytes: number): SiliconFlowSettings {
  const apiKeyEnv = (config.apiKeyEnv ?? '').trim()
  const currency = config.currency ?? SILICONFLOW_DEFAULTS.currency
  const pricePerVideo = config.pricePerVideo ?? SILICONFLOW_DEFAULTS.pricePerVideo
  const settings: SiliconFlowSettings = {
    apiKey: (config.apiKey ?? '').trim(),
    ...apiKeyEnv.length === 0 ? {} : { apiKeyEnv },
    baseUrl: (config.baseUrl ?? SILICONFLOW_DEFAULTS.baseUrl).trim().replace(/\/+$/, ''),
    pollMs: config.pollMs ?? SILICONFLOW_DEFAULTS.pollMs,
    timeoutMs: config.timeoutMs ?? SILICONFLOW_DEFAULTS.timeoutMs,
    maxArtifactBytes,
    model: config.model ?? SILICONFLOW_DEFAULTS.model,
    aspectRatio: config.aspectRatio ?? SILICONFLOW_DEFAULTS.aspectRatio,
    priceMinor: Math.round(pricePerVideo * 100),
    currency,
  }
  if (settings.baseUrl.length === 0) throw new Error('video mode: siliconflow.baseUrl must not be empty')
  if (settings.model !== SILICONFLOW_VIDEO_MODEL) {
    throw new Error(`video mode: siliconflow.model must be ${SILICONFLOW_VIDEO_MODEL}`)
  }
  if (!(settings.aspectRatio in SILICONFLOW_IMAGE_SIZES)) {
    throw new Error(`video mode: siliconflow.aspectRatio must be one of ${Object.keys(SILICONFLOW_IMAGE_SIZES).join(', ')}`)
  }
  if (!Number.isSafeInteger(settings.pollMs) || settings.pollMs <= 0) {
    throw new Error('video mode: siliconflow.pollMs must be a positive integer')
  }
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('video mode: siliconflow.timeoutMs must be a positive integer')
  }
  if (!Number.isFinite(pricePerVideo) || pricePerVideo < 0) {
    throw new Error('video mode: siliconflow.pricePerVideo must be a non-negative number')
  }
  return settings
}

/**
 * Read one optional emotion label.
 * @param value - configured label.
 * @returns the validated label, or undefined when empty.
 * @throws When the label is not part of the T2A vocabulary.
 */
function speechEmotionOf(value: string | undefined): MiniMaxSpeechEmotion | undefined {
  const emotion = (value ?? '').trim()
  if (emotion.length === 0) return undefined
  if (!(MINIMAX_SPEECH_EMOTIONS as readonly string[]).includes(emotion)) {
    throw new Error(`video mode: minimax.speech.emotion must be one of ${MINIMAX_SPEECH_EMOTIONS.join(', ')}`)
  }
  return emotion as MiniMaxSpeechEmotion
}

/** Schemastery face for the Loader row. */
export const Config: z<MediaRuntimeConfig> = z.object({
  fakeProvider: z.boolean().default(true),
  imageModel: z.string().default(SYNTHETIC_IMAGE_MODEL),
  videoModel: z.string().default(SYNTHETIC_VIDEO_MODEL),
  speechModel: z.string().default(SYNTHETIC_SPEECH_MODEL),
  waitMs: z.natural().min(1).default(30_000),
  pollMs: z.natural().min(1).default(250),
  maxArtifactBytes: z.natural().min(1).default(512 * 1024 * 1024),
  maxTasks: z.natural().min(1).default(64),
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  syntheticLatencyMs: z.natural().default(0),
  subtitleFont: z.string().default(''),
  approvalThresholdCny: z.number().min(0).default(10),
  comfyui: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(COMFYUI_DEFAULTS.baseUrl),
    pollMs: z.natural().min(1).default(COMFYUI_DEFAULTS.pollMs),
    timeoutMs: z.natural().min(1).default(COMFYUI_DEFAULTS.timeoutMs),
    outputPrefix: z.string().default(COMFYUI_DEFAULTS.outputPrefix),
    video: z.object({
      model: z.string().default(COMFYUI_DEFAULTS.video.model),
      workflowPath: z.string().default(''),
      checkpoint: z.string().default(COMFYUI_DEFAULTS.video.checkpoint),
      textEncoder: z.string().default(COMFYUI_DEFAULTS.video.textEncoder),
      vae: z.string().default(COMFYUI_DEFAULTS.video.vae),
      resolution: z.string().default(COMFYUI_DEFAULTS.video.resolution),
      fps: z.number().min(1).max(120).default(COMFYUI_DEFAULTS.video.fps),
      defaultDurationSec: z.number().min(1).default(COMFYUI_DEFAULTS.video.defaultDurationSec),
      maxDurationSec: z.number().min(1).default(COMFYUI_DEFAULTS.video.maxDurationSec),
      negativePrompt: z.string().default(COMFYUI_DEFAULTS.video.negativePrompt),
    }),
    image: z.object({
      model: z.string().default(COMFYUI_DEFAULTS.image.model),
      workflowPath: z.string().default(''),
      checkpoint: z.string().default(COMFYUI_DEFAULTS.image.checkpoint),
      textEncoder: z.string().default(COMFYUI_DEFAULTS.image.textEncoder),
      vae: z.string().default(COMFYUI_DEFAULTS.image.vae),
      size: z.natural().min(256).default(COMFYUI_DEFAULTS.image.size),
    }),
  }),
  minimax: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(''),
    baseUrl: z.string().default(MINIMAX_DEFAULTS.baseUrl),
    pollMs: z.natural().min(1).default(MINIMAX_DEFAULTS.pollMs),
    timeoutMs: z.natural().min(1).default(MINIMAX_DEFAULTS.timeoutMs),
    model: z.string().default(MINIMAX_DEFAULTS.model),
    resolution: z.string().default(MINIMAX_DEFAULTS.resolution),
    defaultDurationSec: z.natural().min(1).default(MINIMAX_DEFAULTS.defaultDurationSec),
    maxDurationSec: z.natural().min(1).default(MINIMAX_DEFAULTS.maxDurationSec),
    aspectRatio: z.string().default(MINIMAX_DEFAULTS.aspectRatio),
    speech: z.object({
      enabled: z.boolean().default(false),
      model: z.string().default(MINIMAX_SPEECH_DEFAULTS.model),
      voiceId: z.string().default(MINIMAX_SPEECH_DEFAULTS.voiceId),
      speed: z.number().min(0.5).max(2).default(MINIMAX_SPEECH_DEFAULTS.speed),
      vol: z.number().min(0).max(10).default(MINIMAX_SPEECH_DEFAULTS.vol),
      pitch: z.number().min(-12).max(12).default(MINIMAX_SPEECH_DEFAULTS.pitch),
      emotion: z.string().default(''),
    }),
  }),
  siliconflow: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(''),
    baseUrl: z.string().default(SILICONFLOW_DEFAULTS.baseUrl),
    pollMs: z.natural().min(1).default(SILICONFLOW_DEFAULTS.pollMs),
    timeoutMs: z.natural().min(1).default(SILICONFLOW_DEFAULTS.timeoutMs),
    model: z.string().default(SILICONFLOW_DEFAULTS.model),
    aspectRatio: z.string().default(SILICONFLOW_DEFAULTS.aspectRatio),
    pricePerVideo: z.number().min(0).default(SILICONFLOW_DEFAULTS.pricePerVideo),
    currency: z.union(['CNY', 'USD'] as const).default(SILICONFLOW_DEFAULTS.currency),
  }),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Media generation selection, execution, and task retention. */
    media: MediaRuntime
  }
}

/** One resolved provider/model pair for a request. */
interface Selection {
  readonly provider: MediaProvider
  readonly model: MediaModel
}

/**
 * The media capability service. Registration is effect-scoped; selection
 * resolves at execution time and never depends on registration order.
 */
export class MediaRuntime extends Service {
  /** Loader configuration schema. */
  static Config = Config

  private readonly providers = new Map<string, MediaProvider>()
  private readonly tasks = new Map<string, MediaTask>()
  /** Estimated cost captured at submission, keyed by task id. */
  private readonly costs = new Map<string, MediaCost>()
  private counter = 0
  private readonly config: ResolvedMediaConfig

  /**
   * @param ctx - owning plugin context.
   * @param config - deployment configuration; omitted fields use defaults.
   */
  constructor(ctx: Context, config: MediaRuntimeConfig = {}) {
    super(ctx, 'media')
    this.config = resolveMediaConfig(config)
  }

  /** Configuration after defaults, read by the tools this package registers. */
  get settings(): ResolvedMediaConfig {
    return this.config
  }

  protected [Service.init](): void {
    if (this.config.fakeProvider) this.register(new SyntheticMediaProvider(this.config.syntheticLatencyMs))
    if (this.config.comfyui !== undefined) this.register(new ComfyUiMediaProvider(this.config.comfyui))
    if (this.config.minimax !== undefined) {
      this.register(new MiniMaxMediaProvider(this.config.minimax, fetch, ref => this.resolveCredential(ref)))
    }
    if (this.config.minimaxSpeech !== undefined) {
      this.register(new MiniMaxSpeechProvider(this.config.minimaxSpeech, fetch, ref => this.resolveCredential(ref)))
    }
    if (this.config.siliconflow !== undefined) {
      this.register(new SiliconFlowMediaProvider(this.config.siliconflow, fetch, ref => this.resolveCredential(ref)))
    }
    this.ctx.inject(['tools', 'fs', 'subprocess'], (scope) => {
      scope.tools.register(createMediaTool(scope, this))
      scope.tools.register(createProjectTool(scope))
      scope.tools.register(createAssembleTool(scope, this))
      scope.tools.register(createDeliverTool(scope, this))
    })
  }

  /**
   * Register one provider. A duplicate id is rejected and the fiber owns the
   * registration's disposal.
   * @param provider - provider implementation.
   * @returns a disposer that removes the provider.
   * @throws When the id is already registered.
   */
  register(provider: MediaProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new MediaFailure(`media provider ${JSON.stringify(provider.id)} is already registered`, 'MEDIA_PROVIDER_AMBIGUOUS')
    }
    this.providers.set(provider.id, provider)
    // A duplicate id is rejected above, so this map can only hold this instance
    // until its registration is disposed.
    const release = this.ctx.effect(() => () => {
      this.providers.delete(provider.id)
    })
    return () => { void release() }
  }

  /**
   * Resolve one credential reference through the credentials service, or the
   * process environment when the service is absent.
   * @param ref - credential reference such as `MINIMAX_API_KEY`.
   * @returns the non-empty secret, or undefined while unconfigured.
   */
  private async resolveCredential(ref: string): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    const value = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      : process.env[ref]
    return value !== undefined && value.length > 0 ? value : undefined
  }

  /**
   * List models, optionally narrowed to one capability.
   * @param kind - capability filter.
   * @returns every model of every available provider.
   */
  models(kind?: MediaKind): readonly MediaModel[] {
    const models: MediaModel[] = []
    for (const provider of this.providers.values()) {
      if (!provider.available()) continue
      for (const model of provider.models()) {
        if (kind === undefined || model.kind === kind) models.push(model)
      }
    }
    return models
  }

  /**
   * Estimate one request without starting work.
   * @param request - requested generation.
   * @returns the selected provider's estimate.
   * @throws {@link MediaFailure} when no provider or model serves the request.
   */
  estimate(request: MediaRequest): MediaEstimate {
    const selection = this.resolve(request)
    return selection.provider.estimate({ ...request, model: selection.model.id })
  }

  /**
   * Submit one request without waiting for settlement.
   * @param request - requested generation.
   * @param signal - caller cancellation, forwarded to the provider.
   * @returns the task snapshot immediately after submission.
   * @throws {@link MediaFailure} for selection, validation, and provider failures.
   */
  async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    const selection = this.resolve(request)
    const normalized: MediaRequest = { ...request, model: selection.model.id }
    const cost = selection.provider.estimate(normalized).cost
    let task: MediaTask
    try {
      task = await selection.provider.submit(normalized, signal)
    } catch (error) {
      if (error instanceof MediaFailure) throw error
      throw new MediaFailure(`media provider ${selection.provider.id} failed to submit: ${messageOf(error)}`, 'MEDIA_TASK_FAILED', { cause: error })
    }
    if (cost !== undefined) this.costs.set(task.id, cost)
    return this.remember(task)
  }

  /**
   * Submit one request and wait up to `waitMs` for settlement.
   * @param request - requested generation.
   * @param signal - caller cancellation, forwarded to the provider.
   * @returns the settled task, or the retained task when `waitMs` expires.
   * @throws {@link MediaFailure} for selection, validation, and provider failures.
   */
  async generate(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    const task = await this.submit(request, signal)
    return this.wait(task, signal)
  }

  /**
   * Wait up to `waitMs` for one submitted task to settle.
   * @param task - submitted task.
   * @param signal - caller cancellation, forwarded to the provider.
   * @returns the settled task, or the retained task when `waitMs` expires.
   * @throws {@link MediaFailure} when the owning provider disappeared.
   */
  async wait(task: MediaTask, signal: AbortSignal): Promise<MediaTask> {
    let current = task
    const deadline = Date.now() + this.config.waitMs
    while (!TERMINAL.has(current.status) && Date.now() < deadline) {
      signal.throwIfAborted()
      await delay(this.config.pollMs, undefined, { signal })
      signal.throwIfAborted()
      if (Date.now() >= deadline) return this.status(current.id)
      const provider = this.providers.get(current.provider)
      if (provider === undefined) {
        throw new MediaFailure(`provider ${current.provider} disappeared while task ${current.id} was running`, 'MEDIA_PROVIDER_UNAVAILABLE')
      }
      const polled = provider.poll(current, signal).then(
        (polledTask): { kind: 'task'; task: MediaTask } => ({ kind: 'task', task: polledTask }),
        (error: unknown): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
      )
      const outcome = await Promise.race([
        polled,
        delay(deadline - Date.now(), { kind: 'timeout' as const }, { signal }),
      ])
      signal.throwIfAborted()
      if (outcome.kind === 'timeout') return this.status(current.id)
      if (outcome.kind === 'error') throw outcome.error
      current = this.remember(outcome.task)
    }
    return current
  }

  /**
   * Rebuild in-flight provider state from a journal record after a restart.
   * @param record - persisted task snapshot and request.
   * @returns the resumed task.
   * @throws {@link MediaFailure} when the provider is gone, cannot resume, or rejects the record.
   */
  resume(record: MediaTaskRecord): MediaTask {
    const existing = this.tasks.get(record.task.id)
    if (existing !== undefined) return existing
    const provider = this.providers.get(record.task.provider)
    if (provider === undefined) {
      throw new MediaFailure(
        `cannot resume ${record.task.id}: provider ${JSON.stringify(record.task.provider)} is not registered`,
        'MEDIA_PROVIDER_UNAVAILABLE',
      )
    }
    if (provider.resume === undefined) {
      throw new MediaFailure(
        `provider ${record.task.provider} cannot resume a task across a restart; resubmit the request`,
        'MEDIA_TASK_NOT_FOUND',
      )
    }
    const resumed = provider.resume(record)
    if (resumed === undefined || resumed.id !== record.task.id) {
      throw new MediaFailure(
        `provider ${record.task.provider} rejected the journal record for ${record.task.id}`,
        'MEDIA_STORE_INVALID',
      )
    }
    const cost = this.estimateOrUndefined(requestOfTask(record.request))?.cost
    if (cost !== undefined) this.costs.set(record.task.id, cost)
    this.remember(resumed)
    return resumed
  }

  /**
   * Estimate a request, tolerating a selection that was reconfigured while a
   * task was durably pending.
   * @param request - requested generation.
   * @returns the estimate, or undefined when the provider or model is gone.
   */
  private estimateOrUndefined(request: MediaRequest): MediaEstimate | undefined {
    try {
      return this.estimate(request)
    } catch (error) {
      if (error instanceof MediaFailure) return undefined
      throw error
    }
  }

  /**
   * Read one retained task.
   * @param taskId - id returned by {@link generate}.
   * @returns the latest known task.
   * @throws {@link MediaFailure} `MEDIA_TASK_NOT_FOUND` for an unknown id.
   */
  status(taskId: string): MediaTask {
    const task = this.tasks.get(taskId)
    if (task === undefined) {
      throw new MediaFailure(`unknown media task ${JSON.stringify(taskId)}; start one with media generate`, 'MEDIA_TASK_NOT_FOUND')
    }
    return task
  }

  /**
   * Poll one retained task once through its provider. Long local generations
   * settle here after `generate` returned a running task.
   * @param taskId - id returned by {@link generate}.
   * @param signal - caller cancellation, forwarded to the provider.
   * @returns the latest task.
   * @throws {@link MediaFailure} `MEDIA_TASK_NOT_FOUND` for an unknown id.
   */
  async refresh(taskId: string, signal: AbortSignal): Promise<MediaTask> {
    const task = this.status(taskId)
    if (TERMINAL.has(task.status)) return task
    const provider = this.providers.get(task.provider)
    if (provider === undefined) {
      throw new MediaFailure(`provider ${task.provider} is no longer registered`, 'MEDIA_PROVIDER_UNAVAILABLE')
    }
    const latest = this.remember(await provider.poll(task, signal))
    return latest
  }

  /**
   * Cancel one task through its provider.
   * @param taskId - id returned by {@link generate}.
   * @returns the cancelled task record.
   * @throws {@link MediaFailure} `MEDIA_TASK_NOT_FOUND` for an unknown id.
   */
  async cancel(taskId: string): Promise<MediaTask> {
    const task = this.status(taskId)
    if (TERMINAL.has(task.status)) return task
    const provider = this.providers.get(task.provider)
    if (provider !== undefined) await provider.cancel(task)
    const cancelled: MediaTask = { ...task, status: 'cancelled' }
    this.remember(cancelled)
    return cancelled
  }

  /**
   * Resolve the provider and model for one request.
   * @param request - requested generation.
   * @returns the selected provider and model.
   * @throws {@link MediaFailure} for missing, ambiguous, unknown, or invalid selections.
   */
  private resolve(request: MediaRequest): Selection {
    if (request.prompt.trim().length === 0) {
      throw new MediaFailure('media request requires a non-empty prompt', 'MEDIA_REQUEST_INVALID')
    }
    const providers = [...this.providers.values()]
    const candidates = providers.filter(provider => provider.available() && provider.capabilities.includes(request.kind))
    if (candidates.length === 0) {
      const unavailable = providers
        .filter(provider => !provider.available() && provider.capabilities.includes(request.kind))
        .map(provider => `${provider.id} (${provider.unavailableReason?.() ?? 'unavailable'})`)
      if (unavailable.length > 0) {
        throw new MediaFailure(
          `no available media provider serves ${request.kind}: ${unavailable.join('; ')}`,
          'MEDIA_PROVIDER_UNAVAILABLE',
        )
      }
      throw new MediaFailure(`no media provider serves ${request.kind}; mount a provider or enable the synthetic one`, 'MEDIA_PROVIDER_UNAVAILABLE')
    }
    const modelId = request.model ?? this.defaultModel(request.kind)
    const matching = candidates.filter(provider => provider.models().some(model => model.id === modelId && model.kind === request.kind))
    if (matching.length === 0) {
      const available = candidates.flatMap(provider =>
        provider.models().filter(model => model.kind === request.kind).map(model => model.id))
      throw new MediaFailure(
        `no ${request.kind} model ${JSON.stringify(modelId)}; available: ${available.join(', ')}`,
        'MEDIA_MODEL_UNKNOWN',
      )
    }
    if (matching.length > 1) {
      throw new MediaFailure(`model ${JSON.stringify(modelId)} is served by multiple providers`, 'MEDIA_PROVIDER_AMBIGUOUS')
    }
    const provider = matching[0] as MediaProvider
    const model = provider.models().find(entry => entry.id === modelId && entry.kind === request.kind)
    if (model === undefined) throw new MediaFailure(`model ${JSON.stringify(modelId)} disappeared during selection`, 'MEDIA_MODEL_UNKNOWN')
    this.validate(request, model)
    return { provider, model }
  }

  /**
   * Return the configured default model id for one capability.
   * @param kind - requested capability.
   * @returns the configured model id.
   */
  private defaultModel(kind: MediaKind): string {
    switch (kind) {
      case 'image': return this.config.imageModel
      case 'video': return this.config.videoModel
      case 'speech': return this.config.speechModel
    }
  }

  /**
   * Reject a request the selected model cannot serve.
   * @param request - requested generation.
   * @param model - selected model.
   * @throws {@link MediaFailure} `MEDIA_REQUEST_INVALID`.
   */
  private validate(request: MediaRequest, model: MediaModel): void {
    if (request.kind === 'video' && request.durationSec !== undefined) {
      if (!(request.durationSec > 0)) throw new MediaFailure('video duration must be positive', 'MEDIA_REQUEST_INVALID')
      if (model.maxDurationSec !== undefined && request.durationSec > model.maxDurationSec) {
        throw new MediaFailure(`model ${model.id} accepts at most ${model.maxDurationSec}s`, 'MEDIA_REQUEST_INVALID')
      }
    }
    if (request.aspectRatio !== undefined && model.aspectRatios !== undefined && !model.aspectRatios.includes(request.aspectRatio)) {
      throw new MediaFailure(`model ${model.id} accepts ${model.aspectRatios.join(', ')}, not ${request.aspectRatio}`, 'MEDIA_REQUEST_INVALID')
    }
    if (request.references !== undefined && model.referenceModes === undefined) {
      throw new MediaFailure(`model ${model.id} accepts no reference inputs`, 'MEDIA_REQUEST_INVALID')
    }
  }

  /**
   * Retain one task record, pricing a successful settlement from the estimate
   * captured at submission when the provider reports no cost, and evicting the
   * oldest settled record at the cap. A cancelled record is not replaced.
   * @param task - latest task snapshot.
   * @returns the retained snapshot, priced when an estimate was recorded.
   */
  private remember(task: MediaTask): MediaTask {
    const previous = this.tasks.get(task.id)
    if (previous?.status === 'cancelled') return previous
    let stored = task
    if (task.status === 'succeeded' && task.cost === undefined) {
      const cost = this.costs.get(task.id)
      if (cost !== undefined) stored = { ...task, cost }
    }
    this.tasks.set(stored.id, stored)
    if (this.tasks.size <= this.config.maxTasks) return stored
    for (const [id, entry] of this.tasks) {
      if (this.tasks.size <= this.config.maxTasks) break
      if (id !== stored.id && TERMINAL.has(entry.status)) {
        this.tasks.delete(id)
        this.costs.delete(id)
      }
    }
    return stored
  }

  /**
   * Allocate the next task id for a provider and capability.
   * @param provider - provider id.
   * @param kind - requested capability.
   * @returns a stable, sortable task id.
   */
  nextTaskId(provider: string, kind: MediaKind): string {
    this.counter += 1
    return `${provider}-${kind}-${this.counter}`
  }
}

/** Cost helper used by the synthetic provider and tests. */
function costOf(amountMinor: number, currency: MediaCurrency): MediaCost {
  return { amountMinor, currency }
}

/**
 * Derived cost for one request, rounded up to the provider's billing unit.
 * @param model - selected model.
 * @param request - requested generation.
 * @returns the expected cost, or undefined for an unpriced model.
 */
export function estimateCost(model: MediaModel, request: MediaRequest): MediaCost | undefined {
  const price = model.price
  if (price === undefined) return undefined
  switch (price.unit) {
    case 'image':
      return costOf(price.amountMinor, price.currency)
    case 'video':
      return costOf(price.amountMinor, price.currency)
    case 'video-second':
      return costOf(Math.max(1, Math.ceil(request.durationSec ?? 1)) * price.amountMinor, price.currency)
    case '1000-chars':
      return costOf(Math.max(1, Math.ceil(request.prompt.length / 1000)) * price.amountMinor, price.currency)
  }
}

/**
 * Read a thrown value's message without assuming an Error.
 * @param error - caught value.
 * @returns a diagnostic string.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split a prompt into deterministic caption lines spread evenly across a clip.
 * @param prompt - spoken text.
 * @param durationSec - artifact duration the lines divide.
 * @returns caption lines, twelve characters each.
 */
function syntheticCues(prompt: string, durationSec: number): readonly MediaSubtitleCue[] {
  const characters = Array.from(prompt.trim())
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += 12) {
    const line = characters.slice(index, index + 12).join('').trim()
    if (line.length > 0) lines.push(line)
  }
  return lines.map((text, index) => ({
    text,
    startSec: durationSec * index / lines.length,
    endSec: durationSec * (index + 1) / lines.length,
  }))
}

/** Deterministic synthetic provider used by tests and credential-free demos. */
export class SyntheticMediaProvider implements MediaProvider {
  /** Registered provider id. */
  readonly id = SYNTHETIC_PROVIDER_ID

  /** Capabilities this provider serves. */
  readonly capabilities: readonly MediaKind[] = ['image', 'video', 'speech']

  private readonly modelsById: readonly MediaModel[]

  /**
   * @param latencyMs - delay before `submit` settles a task.
   */
  constructor(private readonly latencyMs = 0) {
    this.modelsById = [
      {
        id: SYNTHETIC_IMAGE_MODEL,
        kind: 'image',
        provider: SYNTHETIC_PROVIDER_ID,
        aspectRatios: ['9:16', '16:9', '1:1'],
        price: { amountMinor: 35, currency: 'CNY', unit: 'image' },
      },
      {
        id: SYNTHETIC_VIDEO_MODEL,
        kind: 'video',
        provider: SYNTHETIC_PROVIDER_ID,
        maxDurationSec: 10,
        aspectRatios: ['9:16', '16:9', '1:1'],
        referenceModes: ['image', 'first-frame', 'last-frame'],
        audio: false,
        price: { amountMinor: 36, currency: 'CNY', unit: 'video-second' },
      },
      {
        id: SYNTHETIC_SPEECH_MODEL,
        kind: 'speech',
        provider: SYNTHETIC_PROVIDER_ID,
        price: { amountMinor: 2, currency: 'CNY', unit: '1000-chars' },
      },
    ]
  }

  /** The synthetic provider is always available. */
  models(): readonly MediaModel[] {
    return this.modelsById
  }

  /** The synthetic provider needs no credentials or local service. */
  available(): boolean {
    return true
  }

  /**
   * Estimate one synthetic request.
   * @param request - requested generation.
   * @returns expected cost and duration.
   */
  estimate(request: MediaRequest): MediaEstimate {
    const model = this.modelsById.find(entry => entry.id === request.model && entry.kind === request.kind)
    if (model === undefined) return { confidence: 'unknown' }
    const cost = estimateCost(model, request)
    return {
      ...cost === undefined ? {} : { cost },
      ...request.kind === 'video' ? { durationSec: request.durationSec ?? 1 } : {},
      confidence: 'exact',
    }
  }

  /**
   * Settle one synthetic task after the configured latency.
   * @param request - requested generation.
   * @param signal - caller cancellation.
   * @returns a succeeded task with deterministic artifacts.
   */
  async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    if (this.latencyMs > 0) await delay(this.latencyMs, undefined, { signal })
    signal.throwIfAborted()
    const model = this.modelsById.find(entry => entry.id === request.model && entry.kind === request.kind)
    if (model === undefined) {
      throw new MediaFailure(`synthetic provider has no model ${JSON.stringify(request.model)}`, 'MEDIA_MODEL_UNKNOWN')
    }
    const id = `synthetic-${request.kind}-${Math.random().toString(36).slice(2, 10)}`
    const cost = estimateCost(model, request)
    return {
      id,
      provider: this.id,
      model: model.id,
      kind: request.kind,
      status: 'succeeded',
      ...cost === undefined ? {} : { cost },
      artifacts: [this.artifact(request)],
    }
  }

  /**
   * Return the task unchanged; synthetic work settles during submission.
   * @param task - current task.
   * @returns the same task.
   */
  poll(task: MediaTask): Promise<MediaTask> {
    return Promise.resolve(task)
  }

  /** Cancellation is a no-op because synthetic work is instantaneous. */
  cancel(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Build the deterministic artifact for one request.
   * @param request - requested generation.
   * @returns the artifact.
   */
  private artifact(request: MediaRequest): MediaArtifact {
    switch (request.kind) {
      case 'image': {
        const [red, green, blue] = colorFor(request.prompt)
        return { id: 'image-1', kind: 'image', mediaType: 'image/png', bytes: solidPng(256, 256, red, green, blue), width: 256, height: 256 }
      }
      case 'video':
        return {
          id: 'video-1',
          kind: 'video',
          mediaType: 'video/mp4',
          bytes: new Uint8Array(Buffer.from(FAKE_MP4_BASE64, 'base64')),
          durationSec: 1,
          width: 64,
          height: 64,
        }
      case 'speech': {
        const durationSec = request.durationSec ?? Math.max(1, Math.ceil(request.prompt.length / 12))
        return {
          id: 'speech-1',
          kind: 'speech',
          mediaType: 'audio/wav',
          bytes: silentWav(durationSec),
          durationSec,
          ...request.subtitles === true ? { subtitles: syntheticCues(request.prompt, durationSec) } : {},
        }
      }
    }
  }
}

export default MediaRuntime
