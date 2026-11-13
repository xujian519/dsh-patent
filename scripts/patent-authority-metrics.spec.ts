/**
 * Boundary table for `patent-authority-metrics`: which inputs the measurement
 * accepts, which numbers it derives, and which citations it reports as
 * undecidable.
 *
 * The report is the baseline every later phase is compared against, so the
 * cases here pin the two failure modes that make a baseline unusable: a silent
 * empty scan, and a citation counted as covered because the parser produced
 * some reference.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadLawBaselines } from '@deepseek-ai/dsh-patent-law'
import {
  buildCoverage,
  classifyBasis,
  findUnresolved,
  findUnstructuredBasis,
  parseArgs,
  parseAuthorityBaseline,
  parseGuidelineExtent,
  renderMarkdown,
  resolveSourceRoot,
  scanFiles,
  verifyCarriers,
  type AuthorityMetrics,
} from './patent-authority-metrics.ts'

const baselineText = `version: "1.0"
verifiedOn: 2026-11-13
sourceRoot: 宝宸知识库_Raw
sources:
  - id: patent-law
    law: 专利法
    document: 中华人民共和国专利法
    revision: 2020 年第四次修正
    effectiveDate: 2021-06-01
    authority: 全国人民代表大会常务委员会
    carriers:
      - path: 法律法规司法解释/中华人民共和国专利法_20201017.md
        mediaType: text/markdown
        sha256: b00794817b50fb7b49899c66b6caeabfbc09028f770694186690a26c6ae17469
        bytes: 33040
extents:
  - id: judicial-interpretations
    documentKind: 司法解释
    count: 7
    paths:
      - 法律法规司法解释/最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释_20091228.md
`

describe('parseArgs', () => {
  it('默认输出到 reports，不校验哈希', () => {
    expect(parseArgs([])).toEqual({ outDir: 'reports', sourceRoot: null, check: false, verifyHashes: false })
  })

  it('读取输出目录、源根与两个开关', () => {
    expect(parseArgs(['--out-dir', '/tmp/out', '--source-root', '/tmp/src', '--check', '--verify-hashes']))
      .toEqual({ outDir: '/tmp/out', sourceRoot: '/tmp/src', check: true, verifyHashes: true })
  })

  it('拒绝缺值或未知参数', () => {
    expect(() => parseArgs(['--out-dir'])).toThrow('需要一个值')
    expect(() => parseArgs(['--out-dir', '--check'])).toThrow('需要一个值')
    expect(() => parseArgs(['--wat'])).toThrow('未知参数')
  })
})

describe('resolveSourceRoot', () => {
  it('显式路径优先于环境变量', () => {
    expect(resolveSourceRoot('/definitely/absent', { DSH_LAW_SOURCE_ROOT: '/tmp' }))
      .toEqual({ path: '/definitely/absent', available: false })
  })

  it('环境变量在未给显式路径时生效', () => {
    expect(resolveSourceRoot(null, { DSH_LAW_SOURCE_ROOT: '/tmp' })).toMatchObject({ path: '/tmp', available: true })
  })
})

describe('parseAuthorityBaseline', () => {
  it('读出八件法源的结构', () => {
    const baseline = parseAuthorityBaseline(baselineText)
    expect(baseline.sources).toHaveLength(1)
    expect(baseline.sources[0]).toMatchObject({ id: 'patent-law', revision: '2020 年第四次修正', effectiveDate: '2021-06-01' })
    expect(baseline.sources[0]?.carriers[0]).toMatchObject({ role: null, bytes: 33040 })
    expect(baseline.extents[0]?.count).toBe(7)
  })

  it('拒绝没有 carriers 的法源与不是数组的 extents', () => {
    expect(() => parseAuthorityBaseline(baselineText.replace(/    carriers:\n(?:.*\n)*?        bytes: 33040\n/, '')))
      .toThrow('carriers 必须是非空数组')
    expect(() => parseAuthorityBaseline(`${baselineText.slice(0, baselineText.indexOf('extents:'))}extents: 7\n`))
      .toThrow('extents 必须是数组')
  })

  it('随包基线登记八件核心法源', () => {
    const text = requireBaselineText()
    const baseline = parseAuthorityBaseline(text)
    expect(baseline.sources).toHaveLength(8)
    expect(baseline.sources.map(source => source.id)).toContain('examination-guidelines')
    expect(baseline.sources.find(source => source.id === 'examination-guidelines')?.revision).toBe('2026 年修订版')
  })
})

describe('buildCoverage', () => {
  it('用随包索引与 maxArticle 算出三部法的覆盖', () => {
    const rows = buildCoverage(
      loadLawBaselines(),
      parseAuthorityBaseline(requireBaselineText()),
      parseGuidelineExtent(requireExtentText()),
    )
    expect(rows[0]).toMatchObject({ document: '专利法', extent: 82, indexed: 38, coverage: '46.3%' })
    expect(rows[1]).toMatchObject({ document: '专利法实施细则', extent: 149, indexed: 45, coverage: '30.2%' })
    expect(rows[2]).toMatchObject({ document: '专利审查指南', extent: 1335, indexed: 85, transcribed: 70 })
    expect(rows[3]).toMatchObject({ document: '司法解释', extent: 7, indexed: 0, coverage: '0.0%' })
  })
})

describe('parseGuidelineExtent', () => {
  it('读数取自指南 PDF 的编号标题与带正文节', () => {
    const extent = parseGuidelineExtent(requireExtentText())
    expect(extent.headings).toBe(1335)
    expect(extent.headingsWithBody).toBe(1145)
    expect(extent.revision).toContain('2023 年修订版')
  })

  it('拒绝带正文节数超过标题数的记录', () => {
    expect(() => parseGuidelineExtent(requireExtentText().replace('headingsWithBody: 1145', 'headingsWithBody: 1336')))
      .toThrow('headingsWithBody 不能大于 headings')
  })
})

describe('classifyBasis', () => {
  it('识别条号、范围与带空格的条号', () => {
    expect(classifyBasis('《专利法》第二十二条第三款')).toBe('article')
    expect(classifyBasis('《民法典》第 188 条')).toBe('article')
    expect(classifyBasis('民事诉讼法第75-78条')).toBe('article')
    expect(classifyBasis('法释〔2009〕20 号第 17 条（2016 修正）')).toBe('article')
  })

  it('识别指南节路径与无条号依据', () => {
    expect(classifyBasis('《专利审查指南》第二部分第二章')).toBe('guideline-path')
    expect(classifyBasis('执业规范：AI 输出不构成正式法律意见')).toBe('unstructured')
  })
})

describe('findUnresolved', () => {
  const baselines = loadLawBaselines()

  it('报告索引没有的条号与被引但没有正文的指南节', () => {
    const files = [
      { file: 'a.md', text: '依据《专利法》第八十二条。' },
      { file: 'b.md', text: '见《专利审查指南》第二部分第二章。' },
    ]
    expect(findUnresolved(files, baselines)).toEqual([
      { file: 'a.md', line: 1, raw: '专利法第八十二条', reason: 'not-indexed' },
      { file: 'b.md', line: 1, raw: '专利审查指南第二部分第二章', reason: 'untranscribed' },
    ])
  })

  it('已索引且已转录的条号不报告', () => {
    expect(findUnresolved([{ file: 'a.md', text: '《专利法》第二十二条第三款' }], baselines)).toEqual([])
  })

  it('紧凑写法与 IPC 分类号同形，不进入报告', () => {
    expect(findUnresolved([{ file: 'ipc.yaml', text: 'A61K 36/00 与 A4' }], baselines)).toEqual([])
  })

  it('覆盖数量表述不当作引用', () => {
    expect(findUnresolved([{ file: 'README.md', text: '《专利法》82 条中的 38 条' }], baselines)).toEqual([])
  })
})

describe('findUnstructuredBasis', () => {
  it('只扫描规则资产里的单行 legalBasis', () => {
    const files = [
      { file: 'packages/patent/patent-rule/assets/rules/a.yaml', text: '    legalBasis: 执业规范\n    legalBasis: 《专利法》第二十二条\n' },
      { file: 'packages/patent/patent-core/assets/x.yaml', text: 'legalBasis: 执业规范\n' },
    ]
    expect(findUnstructuredBasis(files)).toEqual([
      { file: 'packages/patent/patent-rule/assets/rules/a.yaml', line: 1, text: '执业规范' },
    ])
  })
})

describe('scanFiles', () => {
  it('扫到随包资产，且不把索引自身当成引用方', () => {
    const files = scanFiles(process.cwd())
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(file => file.file.startsWith('packages/patent/patent-law/assets/law/'))).toBe(false)
    expect(files.some(file => file.file.includes('/src/'))).toBe(true)
  })
})

describe('verifyCarriers', () => {
  it('源不可用时全部报 unavailable', () => {
    const checks = verifyCarriers(parseAuthorityBaseline(baselineText), { path: '/absent', available: false })
    expect(checks).toEqual([
      {
        source: 'patent-law',
        path: '法律法规司法解释/中华人民共和国专利法_20201017.md',
        status: 'unavailable',
        recorded: 'b00794817b50fb7b49899c66b6caeabfbc09028f770694186690a26c6ae17469',
        actual: null,
      },
    ])
  })
})

describe('renderMarkdown', () => {
  it('固定矩阵表头与不可用提示', () => {
    const metrics: AuthorityMetrics = {
      version: 1,
      sourceRoot: { name: '宝宸知识库_Raw' },
      baseline: { version: '1.0', verifiedOn: '2026-11-13', sources: 8 },
      coverage: [{ document: '专利法', extent: 82, indexed: 38, transcribed: 38, coverage: '46.3%', source: '随包索引 maxArticle' }],
      unresolved: [],
      unstructured: [],
    }
    const markdown = renderMarkdown(metrics)
    expect(markdown).toContain('| 文书 | 权威范围 | 索引条目 | 带正文 | 覆盖率 | 口径 |')
    expect(markdown).toContain('哈希校验由 `--verify-hashes` 另行报告')
    expect(markdown).toContain('| 专利法 | 82 | 38 | 38 | 46.3% |')
  })
})

/** Read the shipped baseline so the assertions face the file the script reads. */
function requireBaselineText(): string {
  return readFileSync(new URL('../packages/patent/patent-law/assets/authority/authority-baseline.yaml', import.meta.url), 'utf8')
}

function requireExtentText(): string {
  return readFileSync(new URL('../packages/patent/patent-law/assets/authority/guideline-extent.yaml', import.meta.url), 'utf8')
}
