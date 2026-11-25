import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `insertSvgDocumentTitle` is mocked at the module boundary so line 41
// (re-throw of a non-VectorFigureError) is reachable without a custom SVG.
vi.mock('../src/figure/vector-figure.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/figure/vector-figure.ts')>()
  return { ...orig, insertSvgDocumentTitle: vi.fn() }
})

const { insertSvgDocumentTitle: mockInsert } = vi.mocked(
  await import('../src/figure/vector-figure.ts'),
)

// Import after mock so `figure-delivery.ts` picks up the mocked `insertSvgDocumentTitle`.
const { stampDotDocumentTitle } = await import('../src/tool/figure-delivery.ts')
const { VectorFigureError } = await import('../src/figure/vector-figure.ts')

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-delivery-')) })
afterEach(() => { vi.clearAllMocks() })

describe('stampDotDocumentTitle', () => {
  it('title undefined 时不读文件', async () => {
    const path = join(dir, 'skip.svg')
    writeFileSync(path, '<svg></svg>')
    await stampDotDocumentTitle(path, 'svg', undefined)
    expect(readFileSync(path, 'utf8')).toBe('<svg></svg>')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('format 非 svg 时不读文件', async () => {
    const path = join(dir, 'skip.png')
    writeFileSync(path, 'binary')
    await stampDotDocumentTitle(path, 'png', '标题')
    expect(readFileSync(path, 'utf8')).toBe('binary')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('正常路径：写入 insertSvgDocumentTitle 的结果', async () => {
    const path = join(dir, 'ok.svg')
    writeFileSync(path, '<svg></svg>')
    mockInsert.mockReturnValueOnce('<svg><title>T</title></svg>')
    await stampDotDocumentTitle(path, 'svg', 'T')
    expect(readFileSync(path, 'utf8')).toBe('<svg><title>T</title></svg>')
  })

  it('insertSvgDocumentTitle 抛 VectorFigureError 时转为 PatentToolError', async () => {
    const path = join(dir, 'bad.svg')
    writeFileSync(path, '<g/>')
    mockInsert.mockImplementation(() => {
      throw new VectorFigureError('invalid_input', '缺少根 svg 开标签')
    })
    // PatentToolError is imported as a value (dynamic import), so assert on constructor name.
    let err: Error | undefined
    try { await stampDotDocumentTitle(path, 'svg', 'T') } catch (e) { err = e as Error }
    expect(err?.constructor.name).toBe('PatentToolError')
    expect(err?.message).toContain('缺少根 svg 开标签')
  })

  it('insertSvgDocumentTitle 抛非 VectorFigureError 时原样重抛', async () => {
    const path = join(dir, 'other.svg')
    writeFileSync(path, '<svg></svg>')
    const cause = new TypeError('unexpected')
    mockInsert.mockImplementationOnce(() => { throw cause })
    await expect(stampDotDocumentTitle(path, 'svg', 'T')).rejects.toThrow(cause)
  })
})
