/**
 * Restricted HTTPS client for catalog traffic: remote catalog payloads are
 * untrusted input, so every request is bounded — HTTPS only, no credentials
 * or fragments, loopback/private/link-local targets blocked before and after
 * DNS resolution, every redirect re-validated, and response size/timeout/
 * redirect depth capped.
 * @module @deepseek-ai/dsh-host-plugin-market/restricted-fetch
 */

import { lookup } from 'node:dns/promises'

/** Closed failure vocabulary for restricted fetches. */
type RestrictedFetchErrorCode =
  | 'unsupported-url'
  | 'blocked-host'
  | 'too-many-redirects'
  | 'too-large'
  | 'timeout'
  | 'network'

/** Typed failure thrown by {@link restrictedFetchJson}. */
export class RestrictedFetchError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param message - operator-facing description.
   */
  constructor(readonly code: RestrictedFetchErrorCode, message: string) {
    super(message)
    this.name = 'RestrictedFetchError'
  }
}

/** Bounds applied to one catalog request. */
export interface RestrictedFetchOptions {
  /** Maximum response body bytes (default 2 MiB). */
  maxBytes?: number
  /** Overall request timeout in milliseconds (default 10s). */
  timeoutMs?: number
  /** Maximum redirects followed (default 3). */
  maxRedirects?: number
}

/** Default bounds for catalog requests. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
/** Default request timeout. */
const DEFAULT_TIMEOUT_MS = 10_000
/** Default redirect cap. */
const DEFAULT_MAX_REDIRECTS = 3

/**
 * An IPv4 dotted-quad parsed to its numeric form, or undefined when malformed.
 * @param ip - the dotted-quad address.
 * @returns the numeric address, or `undefined` when not a valid IPv4 literal.
 */
export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}

/**
 * Whether an IPv4 address falls in a blocked range (private/loopback/link-local/metadata).
 * @param ip - the address to test.
 * @returns whether it is blocked.
 */
export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === undefined) return false // not an IPv4 literal; the hostname layer handles names
  const inRange = (start: number, bits: number): boolean => {
    /* v8 ignore next -- no zero-width range is ever registered below. */
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    return ((value & mask) >>> 0) === start
  }
  return inRange(0x00000000, 8) // 0.0.0.0/8
    || inRange(0x0A000000, 8) // 10.0.0.0/8
    || inRange(0x64400000, 10) // 100.64.0.0/10 CGNAT
    || inRange(0x7F000000, 8) // 127.0.0.0/8 loopback
    || inRange(0xA9FE0000, 16) // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    || inRange(0xAC100000, 12) // 172.16.0.0/12
    || inRange(0xC0A80000, 16) // 192.168.0.0/16
    || inRange(0xC6120000, 15) // 198.18.0.0/15 benchmarking
    || inRange(0xE0000000, 4) // 224.0.0.0/4 multicast
    || inRange(0xF0000000, 4) // 240.0.0.0/4 reserved
}

/**
 * Whether an IPv6 literal is blocked: loopback/unspecified/ULA/link-local/
 * multicast forms, plus IPv4-mapped forms whose embedded IPv4 is itself
 * blocked (`::ffff:127.0.0.1` reaches loopback). Non-mapped forms are matched
 * by their text prefix; exotic spellings of the same prefix (e.g. full
 * `0:0:0:0:0:0:0:1` for loopback) are not canonicalized.
 * @param ip - the IPv6 literal to test.
 * @returns whether it is blocked.
 */
export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower.startsWith('::ffff:')) return isBlockedIpv4(lower.slice('::ffff:'.length))
  return lower === '::1'
    || lower === '::'
    || lower.startsWith('fc') || lower.startsWith('fd') // fc00::/7 ULA
    || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') // fe80::/10
    || lower.startsWith('ff') // ff00::/8 multicast
}

/**
 * Whether a hostname is blocked on sight (local names and literal blocked addresses).
 * @param host - the hostname or literal address to test.
 * @returns whether it is blocked.
 */
export function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '')
  if (lower === 'localhost') return true
  if (lower.includes(':')) return isBlockedIpv6(lower)
  return isBlockedIpv4(lower)
}

/**
 * Resolve a hostname to every candidate address (the default resolver).
 * @param host - the hostname to resolve.
 * @returns every candidate address.
 */
async function resolveHostname(host: string): Promise<readonly string[]> {
  const addresses = await lookup(host, { all: true })
  return addresses.map(entry => entry.address)
}

/**
 * Validate a catalog URL before and after every redirect hop: HTTPS only, no
 * embedded credentials, no fragment, and the target must not be blocked.
 * @param url - the absolute URL to validate.
 * @returns the normalized URL.
 * @throws {RestrictedFetchError} on any violation.
 */
export function validateCatalogUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RestrictedFetchError('unsupported-url', `malformed URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new RestrictedFetchError('unsupported-url', `only https is allowed, got ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RestrictedFetchError('unsupported-url', 'URL credentials are not allowed')
  }
  if (parsed.hash !== '') {
    throw new RestrictedFetchError('unsupported-url', 'URL fragments are not allowed')
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new RestrictedFetchError('blocked-host', `host ${parsed.hostname} is blocked`)
  }
  return parsed
}

/**
 * Fetch one JSON document over the restricted channel: validated URL, DNS
 * resolution re-checked against the blocklist, manual redirects re-validated,
 * and size/timeout/depth bounded.
 * @param url - the HTTPS URL to fetch.
 * @param options - bounds overrides.
 * @param resolve - DNS resolver (defaults to {@link resolveHostname}); injectable for tests.
 * @param fetchImpl - fetch implementation (defaults to the global fetch); injectable for tests.
 * @returns the parsed JSON document.
 * @throws {RestrictedFetchError} on any violation.
 */
export async function restrictedFetchJson(
  url: string,
  options: RestrictedFetchOptions = {},
  resolve: (host: string) => Promise<readonly string[]> = resolveHostname,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  return fetchJsonHop(url, maxBytes, timeoutMs, maxRedirects, 0, resolve, fetchImpl)
}

async function fetchJsonHop(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  maxRedirects: number,
  hops: number,
  resolve: (host: string) => Promise<readonly string[]>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const target = validateCatalogUrl(url)
  let addresses: readonly string[]
  try {
    addresses = await resolve(target.hostname)
  } catch (error) {
    /* v8 ignore next -- DNS resolution rejects with Error instances only. */
    throw new RestrictedFetchError('network', `DNS resolution failed for ${target.hostname}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (addresses.some(address => isBlockedHostname(address))) {
    throw new RestrictedFetchError('blocked-host', `resolved address of ${target.hostname} is blocked`)
  }
  let response: Response
  try {
    response = await fetchImpl(target.href, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    /* v8 ignore next -- fetch rejects with Error instances only. */
    const message = error instanceof Error ? error.message : String(error)
    throw new RestrictedFetchError('network', `fetch failed: ${message}`)
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (hops >= maxRedirects) {
      throw new RestrictedFetchError('too-many-redirects', `more than ${maxRedirects} redirects`)
    }
    const location = response.headers.get('location')
    if (location === null) throw new RestrictedFetchError('network', `redirect ${response.status} without a location`)
    return fetchJsonHop(new URL(location, target).href, maxBytes, timeoutMs, maxRedirects, hops + 1, resolve, fetchImpl)
  }
  if (!response.ok) {
    throw new RestrictedFetchError('network', `HTTP ${response.status} ${response.statusText}`)
  }
  const text = await readBounded(response, maxBytes, timeoutMs)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RestrictedFetchError('network', 'response body is not valid JSON')
  }
}

/** Read a response body up to `maxBytes`, aborting past the bound or the deadline. */
async function readBounded(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new RestrictedFetchError('timeout', `request exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    // The timer is unref'd so a settled read does not keep the process alive.
    timer.unref()
  })
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      received += value.length
      if (received > maxBytes) {
        throw new RestrictedFetchError('too-large', `response exceeds ${maxBytes} bytes`)
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // The read outcome is already the caller's; a failed stream cancel has no
    // other observer and must not replace it.
    void reader.cancel().catch(() => {})
  }
  return text
}
