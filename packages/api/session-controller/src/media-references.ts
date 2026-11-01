/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. Paths and MIME types do not restrict access;
 * the connection service authenticates requests before this handler. A request
 * without the current `v` version is redirected, uncached, to the versioned URL,
 * whose response is cacheable indefinitely. A single `bytes` range is served as
 * a 206 partial response so a media element can seek; a multi-range or
 * malformed header keeps the complete body.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}
const NO_STORE = { ...BASE_HEADERS, 'Cache-Control': 'private, no-store' }
// A versioned URL names one file version, so its response never changes.
const VERSIONED = { ...BASE_HEADERS, 'Cache-Control': 'private, max-age=31536000, immutable' }

/** A parsed `Range` header: absent, malformed (ignored), unsatisfiable, or one range. */
type RangeRequest =
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unsatisfiable'; readonly size: number }
  | undefined

/**
 * Resolve a single-range `Range` header against the file size. A media element
 * seeking in a video asks with one range, so a multi-range request keeps the
 * complete-body response rather than constructing a multipart reply.
 * @param header - the request's `Range` header, or null.
 * @param size - complete file size in bytes, when the filesystem reports one.
 * @returns the inclusive range, a malformed marker, an unsatisfiable marker, or undefined to serve the complete file.
 */
export function parseByteRange(header: string | null, size: number | undefined): RangeRequest {
  if (header === null || size === undefined) return undefined
  const prefix = /^\s*bytes\s*=\s*/iu.exec(header)
  if (prefix === null) return { kind: 'invalid' }
  const spec = header.slice(prefix[0].length).trim()
  const dash = spec.indexOf('-')
  if (dash < 0) return { kind: 'invalid' }
  const startText = spec.slice(0, dash).trim()
  const endText = spec.slice(dash + 1).trim()
  // A comma or any other character in a part makes this a multi-range or
  // malformed header, both served with the complete body.
  if (!/^\d*$/u.test(startText) || !/^\d*$/u.test(endText)) return { kind: 'invalid' }
  if (startText === '' && endText === '') return { kind: 'invalid' }
  if (size === 0) return { kind: 'unsatisfiable', size }
  if (startText === '') {
    const suffix = Number(endText)
    if (suffix <= 0) return { kind: 'unsatisfiable', size }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (start >= size) return { kind: 'unsatisfiable', size }
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1)
  return end < start ? { kind: 'invalid' } : { kind: 'range', start, end }
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: NO_STORE })
  const params = new URL(request.url).searchParams
  const path = params.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const info = await fs.stat(target, request.signal)
    if (info === undefined) return fail(404, 'not found')
    if (info.type !== 'file') return fail(403, 'not a regular file')
    if (info.size !== undefined && info.size > maxBytes) return fail(413, 'file exceeds byte limit')
    if (params.get('v') !== info.version) {
      // Relative to the request URL, so deployment prefixes and the Desktop scheme are kept.
      const location = `?${new URLSearchParams({ path, v: info.version }).toString()}`
      return new Response(null, { status: 302, headers: { ...NO_STORE, Location: location } })
    }
    const headers: Record<string, string> = {
      ...VERSIONED,
      'Content-Type': mime.lookup(target.displayPath) || 'application/octet-stream',
    }
    // Media elements probe this before seeking; the complete body is the
    // fallback when a range cannot be satisfied. A provider that reports no
    // size cannot resolve a range, so it does not advertise them.
    if (info.size !== undefined) headers['Accept-Ranges'] = 'bytes'
    if (request.method === 'HEAD') {
      if (info.size !== undefined) headers['Content-Length'] = String(info.size)
      return new Response(null, { headers })
    }
    const range = parseByteRange(request.headers.get('range'), info.size)
    if (range?.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...NO_STORE, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${range.size}` },
      })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    if (range?.kind !== 'range') {
      headers['Content-Length'] = String(bytes.byteLength)
      return new Response(bytes.slice(), { headers })
    }
    const body = bytes.slice(range.start, range.end + 1)
    headers['Content-Length'] = String(body.byteLength)
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${bytes.byteLength}`
    return new Response(body, { status: 206, headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
  },
}
