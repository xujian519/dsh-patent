import { describe, expect, it, vi } from 'vitest'
import { PatsnapChannel, PatsnapChannelError } from '../src/patsnap-channel.ts'
import { classifyPatsnapErrorCode, isPatsnapNumber, readPatsnapPdfPayload } from '../src/patsnap-receipt.ts'

/** The URL a fetch stub received, whatever input form the caller used. */
function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input
}

/** Build a JSON response with the billing header the gateway returns. */
function jsonResponse(body: unknown, options: { status?: number; amount?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (options.amount !== undefined) headers.set('x-openapi-amount', String(options.amount))
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers })
}

const OK_PAYLOAD = {
  status: true,
  error_code: 0,
  data: [
    { pn: 'CN115690481A', pdf: { path: 'https://data-pdf.patsnap.com/CN/115690481A.pdf' } },
    { pn: 'US11452699B2', pdf: { path: 'https://data-pdf.patsnap.com/US/11452699B2.pdf' }, pn_related: 'US11452699B1' },
  ],
}

describe('patsnap receipt', () => {
  it('classifies number shapes', () => {
    expect(isPatsnapNumber('CN115690481A')).toBe(true)
    expect(isPatsnapNumber('cn-115690481-a')).toBe(true)
    expect(isPatsnapNumber('EP2458380B1')).toBe(true)
    expect(isPatsnapNumber('CN999')).toBe(false)
    expect(isPatsnapNumber('../evil')).toBe(false)
  })

  it('maps business codes to channel failures', () => {
    expect(classifyPatsnapErrorCode(67200003)).toBe('auth_failed')
    expect(classifyPatsnapErrorCode(67200008)).toBe('auth_failed')
    expect(classifyPatsnapErrorCode(67200005)).toBe('quota_exhausted')
    expect(classifyPatsnapErrorCode(67200002)).toBe('rate_limited')
    expect(classifyPatsnapErrorCode(68300008)).toBe('no_pdf')
    expect(classifyPatsnapErrorCode(123)).toBe('upstream_error')
  })

  it('aligns returned records to the request order and reports missing numbers', () => {
    const read = readPatsnapPdfPayload(OK_PAYLOAD, ['US11452699B2', 'CN115690481A', 'CN111111111A'])
    expect(read.failure).toBeUndefined()
    expect(read.items).toEqual([
      {
        number: 'US11452699B2',
        pdfUrl: 'https://data-pdf.patsnap.com/US/11452699B2.pdf',
        resolvedNumber: 'US11452699B1',
      },
      { number: 'CN115690481A', pdfUrl: 'https://data-pdf.patsnap.com/CN/115690481A.pdf' },
      { number: 'CN111111111A', code: 'not_found', error: 'PatSnap 未返回该号' },
    ])
  })

  it('treats a batch with no PDF at all as per-number misses', () => {
    const read = readPatsnapPdfPayload(
      { status: false, error_code: 68300008, error_msg: 'Failed to get patent pdf !' },
      ['CN999999999Z'],
    )
    expect(read.failure).toBeUndefined()
    expect(read.items[0]?.code).toBe('not_found')
  })
})

describe('PatsnapChannel', () => {
  it('batches numbers into one request and sums the billing header', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), auth: new Headers(init?.headers).get('authorization') })
      return jsonResponse(OK_PAYLOAD, { amount: 2 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl, batchSize: 10 })

    const result = await channel.pdfLinks(['CN115690481A', 'US11452699B2'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('patent_number=CN115690481A,US11452699B2')
    expect(calls[0]?.url).toContain('replace_by_related=1')
    expect(calls[0]?.auth).toBe('Bearer sk-test')
    expect(result.amount).toBe(2)
    expect(result.items.map(item => item.pdfUrl)).toEqual([
      'https://data-pdf.patsnap.com/CN/115690481A.pdf',
      'https://data-pdf.patsnap.com/US/11452699B2.pdf',
    ])
  })

  it('chunks by batchSize and keeps the request order', async () => {
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests += 1
      return jsonResponse({ status: true, data: [] }, { amount: 1 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl, batchSize: 2 })
    const result = await channel.pdfLinks(['CN111111111A', 'CN222222222A', 'CN333333333A'])
    expect(requests).toBe(2)
    expect(result.amount).toBe(2)
    expect(result.items.every(item => item.code === 'not_found')).toBe(true)
  })

  it('does not send invalid numbers and still serves the valid ones', async () => {
    const sent: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      sent.push(requestUrl(input))
      return jsonResponse(OK_PAYLOAD, { amount: 1 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    const result = await channel.pdfLinks(['CN999', 'CN115690481A'])
    expect(sent).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ number: 'CN999', code: 'invalid_number' })
    expect(result.items[1]?.pdfUrl).toContain('CN/115690481A.pdf')
  })

  it('deduplicates repeated numbers on the wire', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return jsonResponse(OK_PAYLOAD, { amount: 1 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    const result = await channel.pdfLinks(['CN115690481A', 'CN115690481A'])
    expect(calls).toBe(1)
    expect(result.items).toHaveLength(2)
    expect(result.items[1]?.pdfUrl).toBe(result.items[0]?.pdfUrl)
  })

  it('maps an auth failure and a quota failure to distinct codes', async () => {
    const auth = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => jsonResponse({ status: false, error_code: 67200003, error_msg: 'bad key' }),
    })
    await expect(auth.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'auth_failed' })

    const quota = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => jsonResponse({ status: false, error_code: 67200005, error_msg: 'no balance' }),
    })
    await expect(quota.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'quota_exhausted' })
  })

  it('retries a 429 once and succeeds', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({}, { status: 429, headers: { 'retry-after': '0.001' } })
      }
      return jsonResponse(OK_PAYLOAD, { amount: 1 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    const result = await channel.pdfLinks(['CN115690481A'])
    expect(calls).toBe(2)
    expect(result.items[0]?.pdfUrl).toContain('CN/115690481A.pdf')
  })

  it('reports a persistent 429 as rate limited', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '0.001' } })
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    await expect(channel.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('propagates cancellation as AbortError', async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
    const controller = new AbortController()
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    const pending = channel.pdfLinks(['CN115690481A'], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails loud when the key is missing or the batch size is invalid', () => {
    expect(() => new PatsnapChannel({ apiKey: '  ' })).toThrow(PatsnapChannelError)
    expect(() => new PatsnapChannel({ apiKey: 'sk-test', batchSize: 0 })).toThrow(/batchSize/)
  })
})

describe('patsnap receipt edge cases', () => {
  it('rejects a payload that is not an object or lacks status', () => {
    expect(readPatsnapPdfPayload(null, ['CN115690481A']).failure?.code).toBe('invalid_response')
    expect(readPatsnapPdfPayload({ data: [] }, ['CN115690481A']).failure?.code).toBe('invalid_response')
    expect(readPatsnapPdfPayload({ status: false, error_code: 'x' }, ['CN115690481A']).failure?.code).toBe('invalid_response')
  })

  it('maps permission and bad-request codes', () => {
    expect(classifyPatsnapErrorCode(67200004)).toBe('permission_denied')
    expect(classifyPatsnapErrorCode(67200012)).toBe('bad_request')
    expect(classifyPatsnapErrorCode(68300004)).toBe('bad_request')
    expect(readPatsnapPdfPayload({ status: false, error_code: 67200004, error_msg: 'no' }, ['CN115690481A']).failure?.code)
      .toBe('permission_denied')
  })

  it('skips malformed entries and reports a record without a PDF', () => {
    const read = readPatsnapPdfPayload({
      status: true,
      data: [
        null,
        { pn: '' },
        { pn: 'CN115690481A', pdf: {} },
        { pn: 'CN222222222A', pdf: { path: '' } },
        'not-an-object',
        { pn: 123 },
        { pn: 'CN333333333A', pdf: null },
      ],
    }, ['CN115690481A', 'CN222222222A', 'CN333333333A'])
    expect(read.items[0]).toMatchObject({ code: 'no_pdf' })
    expect(read.items[1]).toMatchObject({ code: 'no_pdf' })
    expect(read.items[2]).toMatchObject({ code: 'no_pdf' })
  })

  it('ignores an empty pn_related and a non-array data field', () => {
    expect(readPatsnapPdfPayload({ status: true, data: {} }, ['CN115690481A']).items[0]?.code).toBe('not_found')
    const read = readPatsnapPdfPayload({
      status: true,
      data: [{ pn: 'CN115690481A', pdf: { path: 'https://x/y.pdf' }, pn_related: '' }],
    }, ['CN115690481A'])
    expect(read.items[0]?.resolvedNumber).toBeUndefined()
  })
})

describe('PatsnapChannel edge cases', () => {
  it('returns nothing for an empty request', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error('must not fetch') }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    await expect(channel.pdfLinks([])).resolves.toEqual({ items: [], amount: 0 })
  })

  it('honours replace_by_related=false and ignores a malformed amount header', async () => {
    let url = ''
    const fetchImpl = async (input: RequestInfo | URL) => {
      url = requestUrl(input)
      return jsonResponse(OK_PAYLOAD, { headers: { 'x-openapi-amount': 'many' } })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl, replaceByRelated: false })
    const result = await channel.pdfLinks(['CN115690481A'])
    expect(url).toContain('replace_by_related=0')
    expect(result.amount).toBe(0)
  })

  it('maps HTTP auth, permission, upstream and bad-request statuses', async () => {
    for (const [status, code] of [[401, 'auth_failed'], [403, 'permission_denied'], [500, 'upstream_error'], [400, 'bad_request']] as const) {
      const channel = new PatsnapChannel({
        apiKey: 'sk-test',
        fetchImpl: async () => new Response('x', { status }),
      })
      await expect(channel.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code })
    }
  })

  it('reports invalid JSON and a missing fetch implementation', async () => {
    const badJson = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    })
    await expect(badJson.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'invalid_response' })

    vi.stubGlobal('fetch', undefined)
    try {
      const noFetch = new PatsnapChannel({ apiKey: 'sk-test' })
      await expect(noFetch.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'network_error' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('turns a request timeout into a timeout failure', async () => {
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('timeout', 'TimeoutError')) })
    })
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl, timeoutMs: 5 })
    await expect(channel.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reports a persistent 503 as an upstream failure', async () => {
    const fetchImpl: typeof fetch = async () => new Response('busy', {
      status: 503,
      headers: { 'retry-after': '0.001' },
    })
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    await expect(channel.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'upstream_error' })
  })

  it('falls back to a one-second wait for an unparseable Retry-After', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      if (calls === 1) return new Response('busy', { status: 429, headers: { 'retry-after': 'later' } })
      return jsonResponse(OK_PAYLOAD, { amount: 1 })
    }
    const channel = new PatsnapChannel({ apiKey: 'sk-test', fetchImpl })
    const result = await channel.pdfLinks(['CN115690481A'])
    expect(calls).toBe(2)
    expect(result.items[0]?.pdfUrl).toBeDefined()
  })
})

describe('PatsnapChannel defensive paths', () => {
  it('reports an empty normalized number as not found', async () => {
    const channel = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => jsonResponse(OK_PAYLOAD, { amount: 1 }),
    })
    const result = await channel.pdfLinks(['', 'CN115690481A'])
    expect(result.items[0]).toMatchObject({ number: '', code: 'not_found' })
    expect(result.items[1]?.pdfUrl).toBeDefined()
  })

  it('uses global fetch when no implementation is injected', async () => {
    const stub = vi.fn(async () => jsonResponse(OK_PAYLOAD, { amount: 1 }))
    vi.stubGlobal('fetch', stub)
    try {
      const channel = new PatsnapChannel({ apiKey: 'sk-test' })
      const result = await channel.pdfLinks(['CN115690481A'])
      expect(stub).toHaveBeenCalledTimes(1)
      expect(result.items[0]?.pdfUrl).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an invalid timeout in the constructor', () => {
    expect(() => new PatsnapChannel({ apiKey: 'sk-test', timeoutMs: 0 })).toThrow(/timeoutMs/)
  })

  it('accepts a live caller signal', async () => {
    const channel = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => jsonResponse(OK_PAYLOAD, { amount: 1 }),
    })
    const result = await channel.pdfLinks(['CN115690481A'], { signal: new AbortController().signal })
    expect(result.items[0]?.pdfUrl).toBeDefined()
  })

  it('classifies a plain network error and a non-Error throw', async () => {
    const failing = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => { throw new Error('boom') },
    })
    await expect(failing.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'network_error', detail: 'boom' })

    const stringThrown = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => { throw 'offline' },
    })
    await expect(stringThrown.pdfLinks(['CN115690481A'])).rejects.toMatchObject({ code: 'network_error', detail: 'offline' })
  })

  it('waits one second when a 429 omits Retry-After', async () => {
    let calls = 0
    const channel = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response('busy', { status: 429 })
        return jsonResponse(OK_PAYLOAD, { amount: 1 })
      },
    })
    const result = await channel.pdfLinks(['CN115690481A'])
    expect(result.items[0]?.pdfUrl).toBeDefined()
  })

  it('leaves the retry wait as soon as the caller aborts', async () => {
    const controller = new AbortController()
    let calls = 0
    const channel = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) {
          setTimeout(() => { controller.abort() }, 5)
          return new Response('busy', { status: 429, headers: { 'retry-after': '5' } })
        }
        return jsonResponse(OK_PAYLOAD, { amount: 1 })
      },
    })
    await expect(channel.pdfLinks(['CN115690481A'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })

  it('does not wait out the retry delay when the signal is already aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const channel = new PatsnapChannel({
      apiKey: 'sk-test',
      fetchImpl: async () => {
        calls += 1
        return new Response('busy', { status: 429, headers: { 'retry-after': '30' } })
      },
    })
    controller.abort()
    const outcome = await Promise.race([
      channel.pdfLinks(['CN115690481A'], { signal: controller.signal }).then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      ),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('still-waiting') }, 200) }),
    ])
    expect(outcome).toBe('AbortError')
    expect(calls).toBe(1)
  })
})
