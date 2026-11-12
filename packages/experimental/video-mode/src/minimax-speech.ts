/**
 * Cloud MiniMax speech provider. It sends one synchronous T2A request and
 * settles immediately with the returned MP3 bytes. MiniMax bills per character:
 * one Han character counts as two billing characters, and every other
 * character counts as one. Prices are the published CNY rates per 10,000
 * characters: 2.00 for `speech-2.8-turbo` and 3.50 for `speech-2.8-hd`.
 * @module @deepseek-ai/dsh-video-mode/minimax-speech
 */

import {
  KeyedMiniMaxProvider,
  failureCodeFor,
  isRecord,
  minimaxJsonHeaders,
  parseJson,
  rejectionMessage,
  resolveMiniMaxKey,
  type MiniMaxFetchLike,
  type MiniMaxKeyResolver,
} from './minimax-common.ts'
import {
  MediaFailure,
  type MediaArtifact,
  type MediaEstimate,
  type MediaKind,
  type MediaRequest,
  type MediaSubtitleCue,
  type MediaTask,
} from './types.ts'

/** Registered provider id of the MiniMax speech backend. */
export const MINIMAX_SPEECH_PROVIDER_ID = 'minimax-speech'

/** Speech model this provider submits by default. */
export const MINIMAX_SPEECH_MODEL = 'speech-2.8-turbo'

/** Default Mandarin voice used when a request names none. */
export const MINIMAX_SPEECH_VOICE = 'Chinese (Mandarin)_News_Anchor'

/** Emotion labels the T2A API accepts. */
export const MINIMAX_SPEECH_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
] as const

/** One accepted speech emotion label. */
export type MiniMaxSpeechEmotion = typeof MINIMAX_SPEECH_EMOTIONS[number]

/** Speech settings after defaults. */
export interface MiniMaxSpeechSettings {
  /** Direct bearer API key; empty when the deployment names a credential ref instead. */
  readonly apiKey: string
  /** Credential reference resolved per request through `ctx.credentials`. */
  readonly apiKeyEnv?: string
  /** API origin, for example `https://api.minimax.cn`. */
  readonly baseUrl: string
  /** Speech model id reported to consumers and submitted to the API. */
  readonly model: string
  /** Default system voice id. */
  readonly voiceId: string
  /** Speech speed multiplier in `[0.5, 2]`. */
  readonly speed: number
  /** Volume multiplier in `(0, 10]`. */
  readonly vol: number
  /** Pitch offset in `[-12, 12]`. */
  readonly pitch: number
  /** Fixed emotion, or undefined to let the model infer it from the text. */
  readonly emotion?: MiniMaxSpeechEmotion
  /** Largest accepted artifact size in bytes, inherited from the media runtime. */
  readonly maxArtifactBytes: number
}

/** Published MiniMax T2A price in fen per 10,000 billing characters. */
const PRICE_PER_10K_CHARS_MINOR: Readonly<Record<string, number>> = {
  'speech-2.8-hd': 350,
  'speech-2.8-turbo': 200,
  'speech-2.6-hd': 350,
  'speech-2.6-turbo': 200,
  'speech-02-hd': 350,
  'speech-02-turbo': 200,
  'speech-01-hd': 350,
  'speech-01-turbo': 200,
}

/** MP3 encoding used by the assembler's decoder. */
const SAMPLE_RATE_HZ = 32_000
const BITRATE = 128_000

/** Bound on the subtitle-download request so a stalled object store cannot hold the tool open. */
const SUBTITLE_FETCH_TIMEOUT_MS = 30_000

/**
 * Longest caption line before a hard break, in characters. Thirteen Han
 * characters at the assembler's burn-in font size (4.3% of canvas height) stay
 * inside a 720-pixel-wide 9:16 frame.
 */
const MAX_CUE_CHARS = 13

/** Shortest run that may close at a comma, in characters. */
const MIN_COMMA_CUE_CHARS = 12

/** Sentence terminators that close one caption line. */
const SENTENCE_END: ReadonlySet<string> = new Set(['。', '！', '？', '!', '?', '；', ';', '…'])

/** Clause separators that may close a caption line once it is long enough. */
const CLAUSE_END: ReadonlySet<string> = new Set(['，', ',', '、', '：', ':'])

/** Closing marks that belong to the sentence they follow. */
const CLOSERS: ReadonlySet<string> = new Set(['”', '"', '』', '」', '）', ')', '】', '》'])

/** One word-level timestamp from the subtitle file. */
interface TimedWord {
  /** Spoken token, often one Han character. */
  readonly text: string
  /** Start offset in seconds. */
  readonly startSec: number
  /** End offset in seconds. */
  readonly endSec: number
}

/** One Han character bills as two characters; every other character bills as one. */
const HAN_CHARACTER = /\p{Script=Han}/u

/**
 * Count the characters MiniMax bills for one text.
 * @param text - synthesis text.
 * @returns the billing character count.
 */
export function billingCharsOf(text: string): number {
  let total = 0
  for (const character of text) total += HAN_CHARACTER.test(character) ? 2 : 1
  return total
}

/**
 * Price one request from its billing characters and published rate.
 * @param chars - billing characters.
 * @param pricePer10k - fen per 10,000 characters.
 * @returns the prorated cost in fen, never below one.
 */
function costMinorOf(chars: number, pricePer10k: number): number {
  return Math.max(1, Math.ceil(chars * pricePer10k / 10_000))
}

/**
 * Decode the hex audio field MiniMax returns.
 * @param value - hex-encoded MP3 bytes.
 * @returns the decoded bytes.
 * @throws {@link MediaFailure} `MEDIA_ARTIFACT_INVALID` for an empty or malformed value.
 */
function decodeAudio(value: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
    throw new MediaFailure('MiniMax speech returned malformed audio data', 'MEDIA_ARTIFACT_INVALID')
  }
  return new Uint8Array(Buffer.from(value, 'hex'))
}

/**
 * Map a MiniMax business status to a stable failure code.
 * @param status - `base_resp.status_code` from the response.
 * @returns the failure code.
 */
function businessCodeFor(status: number): MediaFailure['code'] {
  if (status === 1004) return 'MEDIA_PROVIDER_UNAVAILABLE'
  if (status === 1008) return 'MEDIA_BUDGET_EXCEEDED'
  return 'MEDIA_TASK_FAILED'
}

/**
 * Group character timestamps into caption lines. MiniMax returns one segment
 * with per-character timing, so line breaks come from the text: a sentence
 * terminator always closes a line, a comma closes one that is long enough, and
 * a line reaching {@link MAX_CUE_CHARS} breaks at the current token.
 * @param words - timed tokens in playback order.
 * @returns caption lines with their measured offsets.
 */
function cuesOf(words: readonly TimedWord[]): MediaSubtitleCue[] {
  // Merge a closing mark into the terminator it follows so the sentence keeps it.
  const merged: TimedWord[] = []
  for (const word of words) {
    const previous = merged.at(-1)
    if (previous !== undefined && CLOSERS.has(word.text.trim()) && SENTENCE_END.has(previous.text.trim())) {
      merged[merged.length - 1] = { text: previous.text + word.text, startSec: previous.startSec, endSec: word.endSec }
      continue
    }
    merged.push(word)
  }

  const cues: MediaSubtitleCue[] = []
  let text = ''
  let start = 0
  let end = 0
  const flush = (): void => {
    const line = text.trim()
    text = ''
    if (line.length === 0 || !/[\p{L}\p{N}]/u.test(line)) return
    cues.push({ text: line, startSec: start, endSec: Math.max(end, start + 0.001) })
  }
  for (const word of merged) {
    if (text.length === 0) start = word.startSec
    text += word.text
    end = word.endSec
    // A token that starts with punctuation closes the line it ends; merged
    // closing marks keep the terminator at the front of the token.
    const symbol = word.text.trim().charAt(0)
    const closesLine = SENTENCE_END.has(symbol) || (CLAUSE_END.has(symbol) && text.length >= MIN_COMMA_CUE_CHARS)
    if (closesLine || text.length >= MAX_CUE_CHARS) flush()
  }
  flush()
  return cues
}

/**
 * Read one finite offset, in seconds.
 * @param value - millisecond field from the subtitle file.
 * @returns the offset, or undefined when the value is not a finite number.
 */
function secondsOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read MiniMax's word-level subtitle file.
 * @param text - downloaded file body.
 * @returns caption lines.
 * @throws {@link MediaFailure} `MEDIA_ARTIFACT_INVALID` when the file is not the expected JSON.
 */
function parseSubtitleFile(text: string): MediaSubtitleCue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new MediaFailure(`MiniMax speech subtitle file is not JSON: ${String(error)}`, 'MEDIA_ARTIFACT_INVALID', { cause: error })
  }
  if (!Array.isArray(parsed)) {
    throw new MediaFailure('MiniMax speech subtitle file is not a JSON array', 'MEDIA_ARTIFACT_INVALID')
  }
  const words: TimedWord[] = []
  for (const segment of parsed) {
    if (!isRecord(segment)) {
      throw new MediaFailure('MiniMax speech subtitle segment is not an object', 'MEDIA_ARTIFACT_INVALID')
    }
    const timed = segment.timestamped_words
    if (timed === undefined) continue
    if (!Array.isArray(timed)) {
      throw new MediaFailure('MiniMax speech subtitle segment has no word list', 'MEDIA_ARTIFACT_INVALID')
    }
    for (const word of timed) {
      if (!isRecord(word) || typeof word.word !== 'string') {
        throw new MediaFailure('MiniMax speech subtitle word lacks text or timing', 'MEDIA_ARTIFACT_INVALID')
      }
      const startSec = secondsOf(word.time_begin)
      const endSec = secondsOf(word.time_end)
      if (startSec === undefined || endSec === undefined) {
        throw new MediaFailure('MiniMax speech subtitle word lacks text or timing', 'MEDIA_ARTIFACT_INVALID')
      }
      words.push({ text: word.word, startSec: startSec / 1000, endSec: endSec / 1000 })
    }
  }
  if (words.length === 0) {
    throw new MediaFailure('MiniMax speech subtitle file has no timed words', 'MEDIA_ARTIFACT_INVALID')
  }
  const cues = cuesOf(words)
  if (cues.length === 0) {
    throw new MediaFailure('MiniMax speech subtitle file produced no caption lines', 'MEDIA_ARTIFACT_INVALID')
  }
  return cues
}

/**
 * MiniMax speech provider. `submit` performs the synchronous T2A request and
 * returns a succeeded task with inline MP3 bytes; `poll` and `cancel` are
 * idempotent because the task never leaves the provider.
 */
export class MiniMaxSpeechProvider extends KeyedMiniMaxProvider {
  /** Registered provider id. */
  readonly id = MINIMAX_SPEECH_PROVIDER_ID

  /** Capability this provider serves. */
  readonly capabilities: readonly MediaKind[] = ['speech']

  private readonly pricePer10k: number | undefined
  private counter = 0

  /**
   * @param settings - resolved provider settings.
   * @param fetchImpl - fetch implementation; tests inject a stub.
   * @param resolveApiKey - credential resolver for `apiKeyEnv`; omitted reads the process environment.
   */
  constructor(
    private readonly settings: MiniMaxSpeechSettings,
    private readonly fetchImpl: MiniMaxFetchLike = fetch,
    private readonly resolveApiKey?: MiniMaxKeyResolver,
  ) {
    const pricePer10k = PRICE_PER_10K_CHARS_MINOR[settings.model]
    super(settings, [{
      id: settings.model,
      kind: 'speech',
      provider: MINIMAX_SPEECH_PROVIDER_ID,
      ...pricePer10k === undefined
        ? {}
        : { price: { amountMinor: Math.ceil(pricePer10k / 10), currency: 'CNY', unit: '1000-chars' } },
    }])
    this.pricePer10k = pricePer10k
  }

  /**
   * Estimate one speech request from the published per-character rate.
   * @param request - requested generation.
   * @returns the prorated cost, or unknown for non-speech kinds.
   */
  override estimate(request: MediaRequest): MediaEstimate {
    if (request.kind !== 'speech') return { confidence: 'unknown' }
    if (this.pricePer10k === undefined) return { confidence: 'unknown' }
    return {
      cost: { amountMinor: costMinorOf(billingCharsOf(request.prompt), this.pricePer10k), currency: 'CNY' },
      confidence: 'exact',
    }
  }

  /**
   * Synthesize one speech request and settle it with the returned MP3.
   * @param request - requested generation.
   * @param signal - caller cancellation.
   * @returns the succeeded task with its audio artifact and actual cost.
   * @throws {@link MediaFailure} for an unknown model, missing credential, rejected request, or malformed audio.
   */
  override async submit(request: MediaRequest, signal: AbortSignal): Promise<MediaTask> {
    if (request.kind !== 'speech') {
      throw new MediaFailure(`MiniMax speech serves speech only, not ${request.kind}`, 'MEDIA_REQUEST_INVALID')
    }
    if ((request.model ?? this.settings.model) !== this.settings.model) {
      throw new MediaFailure(`MiniMax serves no speech model ${JSON.stringify(request.model)}`, 'MEDIA_MODEL_UNKNOWN')
    }
    const requestedVoice = request.voice?.trim() ?? ''
    const voiceId = requestedVoice.length === 0 ? this.settings.voiceId : requestedVoice
    const body = {
      model: this.settings.model,
      text: request.prompt,
      stream: false,
      voice_setting: {
        voice_id: voiceId,
        speed: this.settings.speed,
        vol: this.settings.vol,
        pitch: this.settings.pitch,
        ...this.settings.emotion === undefined ? {} : { emotion: this.settings.emotion },
      },
      audio_setting: {
        sample_rate: SAMPLE_RATE_HZ,
        bitrate: BITRATE,
        format: 'mp3',
        channel: 1,
      },
      subtitle_enable: request.subtitles === true,
      ...request.subtitles === true ? { subtitle_type: 'word' } : {},
    }
    const response = await this.fetchImpl(`${this.settings.baseUrl}/v1/t2a_v2`, {
      method: 'POST',
      headers: minimaxJsonHeaders(await resolveMiniMaxKey(this.settings, this.resolveApiKey)),
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new MediaFailure(
        `MiniMax speech rejected the request: ${rejectionMessage(text, response.statusText)}`,
        failureCodeFor(response.status),
      )
    }
    const parsed = parseJson(text)
    const base = isRecord(parsed) && isRecord(parsed.base_resp) ? parsed.base_resp : undefined
    if (base !== undefined && typeof base.status_code === 'number' && base.status_code !== 0) {
      const reason = typeof base.status_msg === 'string' && base.status_msg.length > 0
        ? base.status_msg
        : 'no diagnostic returned'
      throw new MediaFailure(`MiniMax speech error ${base.status_code}: ${reason}`, businessCodeFor(base.status_code))
    }
    const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : undefined
    if (data === undefined) {
      throw new MediaFailure('MiniMax speech returned no audio', 'MEDIA_ARTIFACT_INVALID')
    }
    const hex = data.audio
    if (typeof hex !== 'string') {
      throw new MediaFailure('MiniMax speech returned no audio', 'MEDIA_ARTIFACT_INVALID')
    }
    const bytes = decodeAudio(hex)
    if (bytes.length > this.settings.maxArtifactBytes) {
      throw new MediaFailure(
        `MiniMax speech returned ${bytes.length} bytes, above the configured ${this.settings.maxArtifactBytes}-byte cap`,
        'MEDIA_ARTIFACT_TOO_LARGE',
      )
    }
    const subtitleFile = data.subtitle_file
    const subtitleUrl = typeof subtitleFile === 'string' && subtitleFile.length > 0 ? subtitleFile : undefined
    const captions = request.subtitles === true ? await this.captionsOf(subtitleUrl, signal) : undefined
    const info = isRecord(parsed) && isRecord(parsed.extra_info) ? parsed.extra_info : undefined
    const audioLength = info !== undefined && typeof info.audio_length === 'number' && Number.isFinite(info.audio_length)
      ? info.audio_length
      : undefined
    const usage = info !== undefined && typeof info.usage_characters === 'number' && Number.isFinite(info.usage_characters)
      ? info.usage_characters
      : undefined
    const costMinor = this.pricePer10k === undefined
      ? undefined
      : costMinorOf(usage ?? billingCharsOf(request.prompt), this.pricePer10k)
    const artifact: MediaArtifact = {
      id: 'speech',
      kind: 'speech',
      mediaType: 'audio/mpeg',
      bytes,
      ...audioLength === undefined || audioLength <= 0 ? {} : { durationSec: audioLength / 1000 },
      ...captions === undefined ? {} : { subtitles: captions },
    }
    this.counter += 1
    return {
      id: `${MINIMAX_SPEECH_PROVIDER_ID}-${this.counter}`,
      provider: this.id,
      model: this.settings.model,
      kind: 'speech',
      status: 'succeeded',
      ...costMinor === undefined ? {} : { cost: { amountMinor: costMinor, currency: 'CNY' } },
      artifacts: [artifact],
    }
  }

  /**
   * Download and group the word-level subtitle file MiniMax returns.
   * @param url - signed subtitle URL from the synthesis response.
   * @param signal - caller cancellation.
   * @returns caption lines.
   * @throws {@link MediaFailure} when the URL is absent, the download fails, the file is oversized, or its format is not the expected JSON.
   */
  private async captionsOf(url: string | undefined, signal: AbortSignal): Promise<readonly MediaSubtitleCue[]> {
    if (url === undefined) {
      throw new MediaFailure('MiniMax speech returned no subtitle file', 'MEDIA_ARTIFACT_INVALID')
    }
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(SUBTITLE_FETCH_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      throw new MediaFailure(
        `MiniMax speech subtitle download failed: ${response.status} ${response.statusText}`.trim(),
        'MEDIA_ARTIFACT_INVALID',
      )
    }
    const text = await response.text()
    const size = Buffer.byteLength(text)
    if (size > this.settings.maxArtifactBytes) {
      throw new MediaFailure(
        `MiniMax speech subtitle file is ${size} bytes, above the configured ${this.settings.maxArtifactBytes}-byte cap`,
        'MEDIA_ARTIFACT_TOO_LARGE',
      )
    }
    return parseSubtitleFile(text)
  }

  /**
   * Return the task unchanged; synthesis settles during submission.
   * @param task - current task.
   * @returns the same task.
   */
  override poll(task: MediaTask): Promise<MediaTask> {
    return Promise.resolve(task)
  }

  /** Cancellation is a no-op because synthesis settles during submission. */
  override cancel(): Promise<void> {
    return Promise.resolve()
  }
}
