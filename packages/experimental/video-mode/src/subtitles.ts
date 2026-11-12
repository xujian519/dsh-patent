/**
 * SubRip formatting for speech captions. Providers report cues in seconds; the
 * media tools write them beside the audio as a `.srt` file the assembler burns
 * in or a player loads.
 * @module @deepseek-ai/dsh-video-mode/subtitles
 */

import type { MediaSubtitleCue } from './types.ts'

/** Render one offset as `HH:MM:SS,mmm`. */
function timestampOf(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const millis = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)},${String(millis).padStart(3, '0')}`
}

/**
 * Format timed cues as a SubRip document.
 * @param cues - caption lines in playback order.
 * @returns the SRT text, one blank line between cues.
 */
export function formatSrt(cues: readonly MediaSubtitleCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${timestampOf(cue.startSec)} --> ${timestampOf(cue.endSec)}\n${cue.text}\n`)
    .join('\n')
}
