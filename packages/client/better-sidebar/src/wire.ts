/**
 * Wire helpers for the /sidebar JSON API: bounded body reading, response
 * writing, and the shared error envelope. Every API method returns
 * `{ok: true, value}` on success and `{ok: false, error: {code, message}}`
 * (HTTP 4xx/5xx matching the code) on failure.
 */
import type { SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'
import { GitCommandError } from './git.ts'

/** Machine-readable error codes of the sidebar API. */
type SidebarErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'fs-error'
  | 'git-error'
  | 'not-repo'
  | 'git-worktree'
  | 'pty-error'
  | 'pty-deps-missing'
  | 'job-error'
  | 'sidechat-error'
  | 'subagents-unavailable'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/**
 * Read and parse the JSON request body (bounded; malformed → bad-request).
 * @param req - streaming request whose chunks concatenate into the body.
 * @returns the parsed JSON value, or `{}` for an empty body.
 */
export async function readJsonBody(req: SidebarHttpRequest): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    // The structural request yields string | Uint8Array; Buffer.from accepts
    // both (and the real runtime chunks are node Buffers anyway).
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new SidebarError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SidebarError('bad-request', 'request body is not valid JSON')
  }
}

/**
 * Write a JSON response with the given status.
 * @param res - response to write the head and serialized body onto.
 * @param status - HTTP status code.
 * @param body - value serialized to JSON.
 */
export function writeJson(res: SidebarHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Write the success envelope.
 * @param res - response to write onto.
 * @param value - payload carried in the `{ok: true, value}` envelope.
 */
export function writeOk(res: SidebarHttpResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/**
 * Write the failure envelope for any thrown value (unknown → internal 500).
 * @param res - response to write onto.
 * @param error - thrown value; `SidebarError` keeps code and status, `GitCommandError` its wire code, else `internal` 500.
 */
export function writeError(res: SidebarHttpResponse, error: unknown): void {
  if (error instanceof SidebarError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  // Git layer failures carry a specific wire code (`not-repo`, `git-worktree`,
  // `git-error`); surfacing it distinguishes "outside a repository" from an
  // unexpected server fault.
  if (error instanceof GitCommandError) {
    writeJson(res, 400, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/**
 * Narrow an unknown payload value to a string, else throw bad-request.
 * @param payload - parsed request body.
 * @param key - property to read from the payload.
 * @returns the non-empty string at `key`.
 */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}
