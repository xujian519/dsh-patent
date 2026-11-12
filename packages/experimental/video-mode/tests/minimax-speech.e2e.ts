import { describe, expect, it } from 'vitest'
import {
  MediaFailure,
  MINIMAX_SPEECH_MODEL,
  MINIMAX_SPEECH_PROVIDER_ID,
  MINIMAX_SPEECH_VOICE,
  MiniMaxSpeechProvider,
  type MiniMaxSpeechSettings,
} from '@deepseek-ai/dsh-video-mode'

/**
 * Real-API smoke for the MiniMax speech provider. Self-skips without
 * `$MINIMAX_API_KEY` (CI carries no provider secrets), per the with-key e2e
 * policy in docs/testing.md. Each case spends a few fen of the paired account's
 * speech quota, so the suite stays at three requests.
 */
const apiKey = process.env.MINIMAX_API_KEY?.trim()
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

/**
 * Build settings that mirror the shipped preset.
 * @param overrides - fields a case replaces.
 * @returns complete provider settings.
 */
function settings(overrides: Partial<MiniMaxSpeechSettings> = {}): MiniMaxSpeechSettings {
  return {
    apiKey: apiKey ?? '',
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.cn',
    model: MINIMAX_SPEECH_MODEL,
    voiceId: MINIMAX_SPEECH_VOICE,
    speed: 1,
    vol: 1,
    pitch: 0,
    maxArtifactBytes: 32 * 1024 * 1024,
    ...overrides,
  }
}

/**
 * Recognize the MPEG audio signature MiniMax returns.
 * @param bytes - artifact bytes.
 * @returns whether the stream starts with an ID3 tag or an MPEG frame sync.
 */
function isMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  return bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0
}

maybe('MiniMaxSpeechProvider real API', () => {
  it('synthesizes the default Mandarin voice and settles the billed cost', async () => {
    const prompt = '深度求索的视频模式已经接入云端语音合成，这段音频来自真实接口调用。'
    const provider = new MiniMaxSpeechProvider(settings())
    const estimate = provider.estimate({ kind: 'speech', prompt })
    expect(estimate.confidence).toBe('exact')

    const task = await provider.submit({ kind: 'speech', prompt }, new AbortController().signal)

    expect(task.status).toBe('succeeded')
    expect(task.provider).toBe(MINIMAX_SPEECH_PROVIDER_ID)
    expect(task.model).toBe(MINIMAX_SPEECH_MODEL)

    const artifact = task.artifacts?.[0]
    if (artifact?.bytes === undefined) throw new Error('MiniMax speech returned no inline audio')
    expect(artifact.mediaType).toBe('audio/mpeg')
    expect(isMp3(artifact.bytes)).toBe(true)
    expect(artifact.bytes.length).toBeGreaterThan(1_000)
    expect(artifact.durationSec).toBeGreaterThan(0.5)

    if (task.cost === undefined || estimate.cost === undefined) throw new Error('MiniMax speech settled no cost')
    expect(task.cost.currency).toBe('CNY')
    expect(task.cost.amountMinor).toBeGreaterThanOrEqual(1)
    // Usage characters can differ from a local count by punctuation, so the billed
    // price may drift one fen from the estimate; a wider gap means the rate is wrong.
    expect(Math.abs(task.cost.amountMinor - estimate.cost.amountMinor)).toBeLessThanOrEqual(1)
  }, 30_000)

  it('honors a requested voice on the HD model with rate settings', async () => {
    const provider = new MiniMaxSpeechProvider(settings({ model: 'speech-2.8-hd', speed: 1.1, pitch: 1 }))

    const task = await provider.submit(
      { kind: 'speech', prompt: '这是一次音色覆盖测试，用来确认自定义音色、语速和音调都能生效。', voice: 'female-shaonv' },
      new AbortController().signal,
    )

    expect(task.status).toBe('succeeded')
    expect(task.model).toBe('speech-2.8-hd')
    const artifact = task.artifacts?.[0]
    if (artifact?.bytes === undefined) throw new Error('MiniMax speech returned no inline audio')
    expect(isMp3(artifact.bytes)).toBe(true)
    expect(artifact.durationSec).toBeGreaterThan(0.5)
    expect(task.cost?.currency).toBe('CNY')
  }, 30_000)

  it('returns timed captions for a request that asks for them', async () => {
    const prompt = '第一句用于确认字幕。第二句应当单独成行。'
    const provider = new MiniMaxSpeechProvider(settings())

    const task = await provider.submit({ kind: 'speech', prompt, subtitles: true }, new AbortController().signal)

    const artifact = task.artifacts?.[0]
    if (artifact?.subtitles === undefined) throw new Error('MiniMax speech returned no inline audio with captions')
    const cues = artifact.subtitles
    expect(cues.length).toBeGreaterThanOrEqual(2)
    expect(cues.map(cue => cue.text).join('')).toContain('第二句应当单独成行')
    for (const [index, cue] of cues.entries()) {
      expect(cue.endSec).toBeGreaterThan(cue.startSec)
      const previous = cues[index - 1]
      if (previous !== undefined) expect(cue.startSec).toBeGreaterThanOrEqual(previous.endSec - 0.001)
    }
    const last = cues.at(-1)
    if (artifact.durationSec !== undefined && last !== undefined) {
      expect(last.endSec).toBeLessThanOrEqual(artifact.durationSec + 0.05)
    }
  }, 30_000)

  it('reports a rejected credential as a provider-unavailable failure', async () => {
    const provider = new MiniMaxSpeechProvider(settings({ apiKey: 'sk-invalid-e2e-smoke' }))

    const failure = await provider
      .submit({ kind: 'speech', prompt: '测试' }, new AbortController().signal)
      .catch((error: unknown) => error)

    if (!(failure instanceof MediaFailure)) throw new Error(`expected MediaFailure, got ${String(failure)}`)
    expect(failure.code).toBe('MEDIA_PROVIDER_UNAVAILABLE')
  }, 30_000)
})
