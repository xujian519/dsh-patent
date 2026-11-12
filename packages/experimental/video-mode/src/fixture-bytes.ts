/**
 * Deterministic binary fixtures for the synthetic provider: a solid-color PNG
 * encoder, a silent PCM WAV writer, and a stable color derived from a prompt.
 * These keep the end-to-end tests independent of network providers and image
 * tooling while still exercising real container validation.
 * @module @deepseek-ai/dsh-video-mode/fixture-bytes
 */

import { deflateSync } from 'node:zlib'

/** PNG signature shared by every encoded fixture. */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Lazily built CRC-32 lookup table for PNG chunks. */
let crcTable: Uint32Array | undefined

/**
 * Return the shared CRC-32 table, building it on first use.
 * @returns the 256-entry lookup table.
 */
function crcTableOf(): Uint32Array {
  if (crcTable !== undefined) return crcTable
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  crcTable = table
  return table
}

/**
 * Compute the CRC-32 of a byte sequence.
 * @param bytes - bytes to digest.
 * @returns the unsigned 32-bit checksum.
 */
function crc32(bytes: Uint8Array): number {
  const table = crcTableOf()
  let value = 0xffffffff
  for (const byte of bytes) {
    const index = (value ^ byte) & 0xff
    value = (table[index] as number) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Build one PNG chunk: length, type, payload, and CRC over type plus payload.
 * @param type - four-character ASCII chunk type.
 * @param data - chunk payload.
 * @returns the complete chunk.
 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const chunk = new Uint8Array(8 + body.length + 4)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(body, 4)
  view.setUint32(4 + body.length, crc32(body))
  return chunk
}

/**
 * Encode one solid-color 8-bit RGB PNG.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param red - red channel in `[0, 255]`.
 * @param green - green channel in `[0, 255]`.
 * @param blue - blue channel in `[0, 255]`.
 * @returns the complete PNG bytes.
 */
export function solidPng(width: number, height: number, red: number, green: number, blue: number): Uint8Array {
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 4096)) {
    throw new Error('solidPng requires positive integer dimensions up to 4096')
  }
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 2
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = 1 + width * 3
  const raw = new Uint8Array(stride * height)
  for (let row = 0; row < height; row++) {
    const start = row * stride
    raw[start] = 0
    for (let column = 0; column < width; column++) {
      const offset = start + 1 + column * 3
      raw[offset] = red
      raw[offset + 1] = green
      raw[offset + 2] = blue
    }
  }

  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

/**
 * Encode one silent mono 16-bit PCM WAV.
 * @param durationSec - duration in seconds.
 * @param sampleRate - samples per second.
 * @returns the complete WAV bytes.
 */
export function silentWav(durationSec: number, sampleRate = 48_000): Uint8Array {
  if (!(durationSec > 0) || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('silentWav requires a positive duration and integer sample rate')
  }
  const samples = Math.max(1, Math.round(durationSec * sampleRate))
  const dataBytes = samples * 2
  const wav = new Uint8Array(44 + dataBytes)
  const view = new DataView(wav.buffer)
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++) wav[offset + index] = text.charCodeAt(index)
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  return wav
}

/**
 * Derive a stable, visually distinct RGB color from arbitrary prompt text.
 * @param text - prompt or shot id.
 * @returns red, green, and blue channels.
 */
export function colorFor(text: string): readonly [number, number, number] {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return [
    48 + (hash & 0x9f),
    48 + ((hash >>> 8) & 0x9f),
    48 + ((hash >>> 16) & 0x9f),
  ]
}

/**
 * Four-byte media-type signatures used by the artifact validator.
 * @param mediaType - declared artifact media type.
 * @returns a validator for the type, or `undefined` when no signature is checked.
 */
export function signatureOf(mediaType: string): ((bytes: Uint8Array) => boolean) | undefined {
  switch (mediaType) {
    case 'image/png':
      return bytes => bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    case 'image/jpeg':
      return bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/webp':
      return bytes => bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
    case 'video/mp4':
      return bytes => bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'
    case 'audio/wav':
      return bytes => bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE'
    case 'audio/mpeg':
      // MiniMax returns ID3v2-tagged audio; a bare frame sync is the other legal start.
      return bytes => (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
        || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0)
    default:
      return undefined
  }
}
