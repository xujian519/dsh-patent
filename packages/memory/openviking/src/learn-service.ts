/**
 * Deliberate learning: `memlearn` semantics.
 *
 * Routes by capability: `skill` probes and mints/replaces a playbook;
 * `target` appends to an explicit memory URI; neither performs a semantic
 * dedupe against the user-memory library and appends to the best match at or
 * above `minScore`, or reports `no-match` with actionable guidance. Lessons
 * are redacted for common secret shapes before anything touches the wire.
 * @module @deepseek-ai/dsh-openviking/learn-service
 */

import { OpenVikingClient, type SearchItem } from './client.ts'
import { OpenVikingError } from './errors.ts'

/** One deliberate learning request. */
interface LearnRequest {
  readonly lesson: string
  /** `skill` | `target` | omitted semantics. */
  readonly capability?: string | undefined
  /** Explicit memory file URI for the `target` path. */
  readonly target?: string | undefined
  /** Playbook name for the `skill` path. */
  readonly skill?: string | undefined
  /** Merge match threshold for the semantic path (0–1). */
  readonly minScore?: number | undefined
}

/** Outcome of one capture. */
interface LearnResult {
  readonly result: 'stored' | 'merged' | 'no-match' | 'failed'
  readonly uri?: string
  readonly detail: string
}

/** Secret-shaped values redacted before any write. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/(api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*\S+/gi, '$1: [REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [REDACTED]'],
]

/** Replace common secret shapes with a placeholder.
 * @param text - the text to scan for secret shapes.
 * @returns the redacted text.
 */
export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/** Whether the skill name is a safe single-path segment.
 * @param name - the playbook name candidate.
 * @returns true when the name matches the kebab-case grammar.
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/** Whether the target is a bare `viking://` file URI (no query/fragment).
 * @param uri - the target candidate.
 * @returns true when the URI is a bare viking file path.
 */
export function isValidVikingUri(uri: string): boolean {
  return /^viking:\/\/[A-Za-z0-9_\-./]+$/.test(uri)
}

/** Higher-order learning service over the client. */
export class LearnService {
  private readonly client: OpenVikingClient

  /**
 * @param client - OpenViking HTTP client.
 */
  constructor(client: OpenVikingClient) {
    this.client = client
  }

  /**
   * Capture a lesson per the capability routing.
   * @param request - One deliberate learning request.
   * @param signal - Cancellation signal for the request.
   * @returns the capture outcome.
   */
  async capture(request: LearnRequest, signal?: AbortSignal): Promise<LearnResult> {
    const lesson = redactSecrets(request.lesson.trim())
    if (lesson.replace(/\[REDACTED\]/g, '').trim().length === 0) {
      return { result: 'failed', detail: 'The lesson is empty after trimming and redaction.' }
    }

    if (request.capability === 'skill') return this.captureSkill(lesson, request.skill, signal)
    if (request.capability === 'target') return this.captureTarget(lesson, request.target, signal)
    return this.captureSemantic(lesson, request.minScore ?? 0.5, signal)
  }

  private async captureSkill(lesson: string, skill: string | undefined, signal?: AbortSignal): Promise<LearnResult> {
    const name = skill ?? 'runbook'
    if (!isValidSkillName(name)) {
      return { result: 'failed', detail: `Invalid skill name "${name}": kebab-case, max 64 chars (${name.length}).` }
    }
    const body = { name, content: lesson }
    try {
      await this.client.getSkill(name, signal)
      await this.client.putSkill(name, body, signal)
      return { result: 'stored', uri: `viking://user/skills/${name}/`, detail: `Updated playbook ${name}.` }
    } catch (error) {
      if (!(error instanceof OpenVikingError) || error.httpStatus !== 404) throw error
      await this.client.createSkill(body, signal)
      return { result: 'stored', uri: `viking://user/skills/${name}/`, detail: `Minted playbook ${name}.` }
    }
  }

  private async captureTarget(lesson: string, target: string | undefined, signal?: AbortSignal): Promise<LearnResult> {
    if (target === undefined || !isValidVikingUri(target)) {
      return { result: 'failed', detail: 'capability: target requires a viking:// file URI (a memory file, e.g. viking://user/memories/preferences/lesson.md).' }
    }
    await this.client.writeContent(target, `\n${lesson}`, { mode: 'append', signal })
    return { result: 'merged', uri: target, detail: `Appended to ${target}.` }
  }

  private async captureSemantic(lesson: string, minScore: number, signal?: AbortSignal): Promise<LearnResult> {
    const result = await this.client.find({ query: lesson, targetUri: 'viking://user/memories/', limit: 3, scoreThreshold: minScore }, { signal })
    const best = result.memories[0] ?? result.resources[0] ?? result.skills[0]
    if (best === undefined) {
      return {
        result: 'no-match',
        detail: 'No existing memory matched at that threshold. OpenViking has no create-memory endpoint — new memories come from session commits. Use memcommit after the task, or memlearn with capability: skill to mint a playbook.',
      }
    }
    await this.writeAppend(best, lesson, signal)
    return { result: 'merged', uri: best.uri, detail: `Merged into ${best.uri} (score ${best.score.toFixed(2)}).` }
  }

  private async writeAppend(hit: SearchItem, lesson: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.writeContent(hit.uri, `\n${lesson}`, { mode: 'append', signal })
    } catch (error) {
      // A memory `.abstract.md` is not a write target; the parent file is.
      if (!(error instanceof OpenVikingError) || (error.httpStatus !== 400 && error.httpStatus !== 404)) throw error
      const parent = `${hit.uri.replace(/\/[^/]+$/, '')}/`
      await this.client.writeContent(parent, `\n${lesson}`, { mode: 'append', signal })
    }
  }
}
