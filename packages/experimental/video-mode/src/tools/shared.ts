/**
 * Shared helpers for the video mode tools: resolve the Session working
 * directory, write one artifact through `ctx.fs`, and reject bytes whose
 * declared media type the signature contradicts.
 * @module @deepseek-ai/dsh-video-mode/tools/shared
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { signatureOf } from '../fixture-bytes.ts'
import { MediaFailure, type MediaArtifact } from '../types.ts'

/**
 * Resolve the directory relative tool paths use. A model call belongs to an
 * Agent and therefore its Session working directory; a programmatic call
 * without an Agent falls back to the process directory.
 * @param ctx - tool context.
 * @param exec - current execution.
 * @returns an absolute working directory.
 */
export async function workingDirectoryOf(ctx: Context, exec: ToolRunContext): Promise<string> {
  if (exec.agent === undefined) return process.cwd()
  const working = ctx.get('workingDirectory')
  if (working === undefined) return process.cwd()
  return working.ensure(exec.agent, exec.signal)
}

/**
 * Resolve a Session-relative file to the host path a local provider reads.
 * @param ctx - tool context.
 * @param path - Session-relative path.
 * @param cwd - Session working directory.
 * @returns the absolute process path.
 */
export async function hostPathOf(ctx: Context, path: string, cwd: string): Promise<string> {
  const target = await ctx.fs.resolve(path, { cwd })
  return ctx.fs.processPath(target)
}

/**
 * Insert a numeric suffix before a path's extension.
 * @param path - declared output path.
 * @param index - zero-based artifact index; zero keeps the path unchanged.
 * @returns the derived path.
 */
export function derivedPath(path: string, index: number): string {
  if (index === 0) return path
  const extension = extname(path)
  return extension.length === 0
    ? `${path}-${index + 1}`
    : `${path.slice(0, -extension.length)}-${index + 1}${extension}`
}

/**
 * Derive the caption sidecar path for one audio artifact.
 * @param path - declared audio path.
 * @returns the same path with an `.srt` extension.
 */
export function subtitlePathOf(path: string): string {
  const extension = extname(path)
  return `${extension.length === 0 ? path : path.slice(0, -extension.length)}.srt`
}

/**
 * Write one artifact through the Session filesystem after checking its size and
 * signature. Provider-declared media types are not trusted: a mislabeled HTML
 * or SVG payload must fail instead of landing as an image.
 * @param ctx - tool context.
 * @param artifact - produced artifact.
 * @param path - declared output path, relative to `cwd`.
 * @param cwd - Session working directory.
 * @param maxBytes - deployment artifact cap.
 * @param signal - caller cancellation.
 * @returns the absolute written path and byte count.
 * @throws {@link MediaFailure} for a missing payload, an oversized artifact, or a signature mismatch.
 */
export async function writeArtifact(
  ctx: Context,
  artifact: MediaArtifact,
  path: string,
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly path: string; readonly bytes: number }> {
  const bytes = artifact.bytes
  if (bytes === undefined) {
    throw new MediaFailure(
      `provider returned ${artifact.id} as a URL only; the provider must download its artifact before settling`,
      'MEDIA_ARTIFACT_INVALID',
    )
  }
  if (bytes.length === 0) {
    throw new MediaFailure(`artifact ${artifact.id} is empty`, 'MEDIA_ARTIFACT_INVALID')
  }
  if (bytes.length > maxBytes) {
    throw new MediaFailure(
      `artifact ${artifact.id} is ${bytes.length} bytes, above the configured ${maxBytes}-byte cap`,
      'MEDIA_ARTIFACT_TOO_LARGE',
    )
  }
  const signature = signatureOf(artifact.mediaType)
  if (signature !== undefined && !signature(bytes)) {
    throw new MediaFailure(
      `artifact ${artifact.id} declares ${artifact.mediaType} but its bytes are not that format`,
      'MEDIA_ARTIFACT_INVALID',
    )
  }
  const target = await ctx.fs.resolve(path, { cwd })
  await ctx.fs.writeBytes(target, bytes, undefined, signal)
  return { path: ctx.fs.processPath(target), bytes: bytes.length }
}
