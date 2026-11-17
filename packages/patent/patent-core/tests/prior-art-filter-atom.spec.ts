import { describe, expect, it } from 'vitest'
import { priorArtFilterAtom, PriorArtFilterHandler } from '../src/atoms/handlers/builtin/prior-art-filter.ts'

const handler = new PriorArtFilterHandler()

const doc = (title: string, publicationDate?: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title,
  ...(publicationDate !== undefined ? { publicationDate } : {}),
  ...extra,
})

const stateWith = (docs: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  prior_art: docs,
  reference_date: '2024-06-01',
  reference_basis: 'filing-date',
  filing_date: '2024-06-01',
  ...overrides,
})

describe('prior-art-filter atom', () => {
  it('声明报告为主输出，过滤后的 prior_art 为第二输出键', () => {
    expect(priorArtFilterAtom.name).toBe('prior-art-filter')
    expect(priorArtFilterAtom.category).toBe('search')
    expect(priorArtFilterAtom.outputSchema.slice(0, 2)).toEqual(['prior_art_filter_report', 'prior_art'])
  })

  it('保留截止日前的文献，排除截止日当天及之后的文献（A22.5 现有技术）', async () => {
    const out = await handler.execute({
      state: stateWith([
        doc('D1 早于截止日', '2023-01-01'),
        doc('D2 等于截止日', '2024-06-01'),
        doc('D3 晚于截止日', '2024-07-01'),
      ]),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art).toMatchObject([{ title: 'D1 早于截止日', dLabel: 'D1' }])
    expect(out.prior_art_excluded).toHaveLength(2)
    expect(out.prior_art_excluded).toMatchObject([
      { label: 'D2', reason: 'not-prior-art', publicationDate: '2024-06-01' },
      { label: 'D3', reason: 'not-prior-art', publicationDate: '2024-07-01' },
    ])
    const report = String(out.prior_art_filter_report)
    expect(report).toContain('保留 1 篇，排除 2 篇')
    expect(report).toContain('2024-06-01')
  })

  it.each([
    ['A24.1', 'applicant'],
    ['A24.2', 'derived-from-applicant'],
    ['A24.3', 'applicant'],
    ['A24.4', 'unauthorized-disclosure'],
  ] as const)(
    '申请日前六个月内且属于 %s 的首次公开不破坏新颖性（G-2 正例）',
    async (exception, source) => {
      const out = await handler.execute({
        state: stateWith([
          doc('宽限期内公开', '2024-03-01', { a24Exception: exception, a24DisclosureSource: source }),
        ]),
      })
      expect(out.prior_art).toEqual([])
      expect(out.prior_art_excluded).toMatchObject([
        { reason: 'a24-grace-period', a24Exception: exception, disclosureSource: source },
      ])
      expect(String(out.prior_art_filter_report)).toContain(exception)
    },
  )

  it('宽限期外的 A24 标注不适用，该公开仍作为现有技术（G-2 反例）', async () => {
    const out = await handler.execute({
      state: stateWith([
        doc('宽限期外公开', '2023-01-01', { a24Exception: 'A24.2', a24DisclosureSource: 'applicant' }),
      ]),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_excluded).toEqual([])
    const report = String(out.prior_art_filter_report)
    expect(report).toContain('宽限期外')
    expect(report).toContain('A24.2')
  })

  it('六个月的起点按对应日计算，边界日仍在宽限期内', async () => {
    const out = await handler.execute({
      state: stateWith(
        [doc('边界日公开', '2024-02-29', { a24Exception: 'A24.3', a24DisclosureSource: 'applicant' })],
        {
          filing_date: '2024-08-31',
          reference_date: '2024-08-31',
        },
      ),
    })
    expect(out.prior_art).toEqual([])
    expect(out.prior_art_excluded).toMatchObject([{ reason: 'a24-grace-period' }])
  })

  it('缺少申请日时 A24 标注无法判定，按截止日保留并写明原因', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('优先权日前公开', '2023-05-01', {
            a24Exception: 'A24.4',
            a24DisclosureSource: 'unauthorized-disclosure',
          }),
        ],
        {
          reference_basis: 'priority-date',
          reference_date: '2023-06-01',
          filing_date: '',
        },
      ),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(String(out.prior_art_filter_report)).toContain('缺少申请日')
    expect(String(out.prior_art_filter_report)).toContain('A24 未判定')
  })

  it('优先权日早于申请日时以优先权日为宽限期基准', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('优先权日宽限期内', '2021-12-01', {
            a24Exception: 'A24.2',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { priority_date: '2022-01-01', reference_date: '2022-01-01', reference_basis: 'priority-date' },
      ),
    })
    expect(out.prior_art).toEqual([])
    expect(out.prior_art_excluded).toMatchObject([{ reason: 'a24-grace-period' }])
    expect(out.a24_grace).toEqual({ status: 'resolved', date: '2022-01-01', basis: 'priority-date' })
  })

  it('多个优先权日取最早的一日作为基准', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('仅落在最早优先权宽限期内', '2021-12-01', {
            a24Exception: 'A24.2',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { priority_date: ['2022-01-01', '2022-08-01'], reference_date: '2022-01-01', reference_basis: 'priority-date' },
      ),
    })
    expect(out.prior_art).toEqual([])
    expect(out.a24_grace).toEqual({ status: 'resolved', date: '2022-01-01', basis: 'priority-date' })
  })

  it('优先权日晚于申请日时基准取申请日', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('申请日宽限期内', '2024-03-01', {
            a24Exception: 'A24.3',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { priority_date: '2024-07-01' },
      ),
    })
    expect(out.prior_art).toEqual([])
    expect(out.a24_grace).toEqual({ status: 'resolved', date: '2024-06-01', basis: 'filing-date' })
  })

  it('缺少申请日但有有效优先权日时以优先权日为基准', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('优先权宽限期内', '2023-12-01', {
            a24Exception: 'A24.2',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { filing_date: '', priority_date: '2024-01-01', reference_date: '2024-01-01', reference_basis: 'priority-date' },
      ),
    })
    expect(out.a24_grace).toEqual({ status: 'resolved', date: '2024-01-01', basis: 'priority-date' })
    expect(out.prior_art_excluded).toMatchObject([{ reason: 'a24-grace-period' }])
  })

  it('优先权日不可解析时标为未判定，不回退到申请日', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('看似在申请日宽限期内', '2024-03-01', {
            a24Exception: 'A24.2',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { priority_date: '2022-13-01' },
      ),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_excluded).toEqual([])
    expect(out.a24_grace).toMatchObject({ status: 'unverifiable' })
    expect(out.prior_art_grace).toMatchObject([{ status: 'unverifiable' }])
    expect(String(out.prior_art_filter_report)).toContain('优先权日')
    expect(String(out.prior_art_filter_report)).toContain('A24 未判定')
  })

  it('仅精确到月的优先权日同样标为未判定', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('优先权月级', '2024-03-01', {
            a24Exception: 'A24.2',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { priority_date: '2022-01' },
      ),
    })
    expect(out.a24_grace).toMatchObject({ status: 'unverifiable' })
    expect(String(out.prior_art_filter_report)).toContain('仅精确到月')
  })

  it('优先权日类型非法时降级', async () => {
    const wrongType = await handler.execute({
      state: stateWith([], { priority_date: 20220101 }),
    })
    expect(String(wrongType._error)).toContain('priority_date')
    const wrongEntry = await handler.execute({
      state: stateWith([], { priority_date: ['2022-01-01', 3] }),
    })
    expect(String(wrongEntry._error)).toContain('priority_date')
  })

  it('空优先权日按未主张优先权处理', async () => {
    const emptyString = await handler.execute({
      state: stateWith([], { priority_date: '' }),
    })
    expect(emptyString.a24_grace).toEqual({ status: 'resolved', date: '2024-06-01', basis: 'filing-date' })
    const emptyEntries = await handler.execute({
      state: stateWith([], { priority_date: ['', '  '] }),
    })
    expect(emptyEntries.a24_grace).toEqual({ status: 'resolved', date: '2024-06-01', basis: 'filing-date' })
    const nullValue = await handler.execute({
      state: stateWith([], { priority_date: null }),
    })
    expect(nullValue.a24_grace).toEqual({ status: 'resolved', date: '2024-06-01', basis: 'filing-date' })
  })

  it('公开来源未知时不认定宽限期', async () => {
    const out = await handler.execute({
      state: stateWith([doc('来源未知', '2024-03-01', { a24Exception: 'A24.2' })]),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_excluded).toEqual([])
    expect(out.prior_art_grace).toMatchObject([{ status: 'unverifiable', disclosureSource: 'unknown' }])
    expect(String(out.prior_art_filter_report)).toContain('公开来源 unknown')
    expect(String(out.prior_art_filter_report)).toContain('A24 未判定')
    const nullSource = await handler.execute({
      state: stateWith([
        doc('来源为空', '2024-03-01', { a24Exception: 'A24.2', a24DisclosureSource: null }),
      ]),
    })
    expect(nullSource.prior_art_grace).toMatchObject([{ status: 'unverifiable', disclosureSource: 'unknown' }])
    const explicitUnknown = await handler.execute({
      state: stateWith([
        doc('来源显式未知', '2024-03-01', { a24Exception: 'A24.2', a24DisclosureSource: ' unknown ' }),
      ]),
    })
    expect(explicitUnknown.prior_art_grace).toMatchObject([
      { status: 'unverifiable', disclosureSource: 'unknown' },
    ])
  })

  it('公开来源与 A24 情形不匹配时不认定宽限期', async () => {
    const out = await handler.execute({
      state: stateWith([
        doc('来源不匹配', '2024-03-01', {
          a24Exception: 'A24.4',
          a24DisclosureSource: 'applicant',
        }),
      ]),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_grace).toMatchObject([{ status: 'unverifiable' }])
    expect(String(out.prior_art_filter_report)).toContain('不属于 A24.4')
  })

  it('非法公开来源值降级', async () => {
    const empty = await handler.execute({
      state: stateWith([doc('空来源', '2024-03-01', { a24Exception: 'A24.1', a24DisclosureSource: '' })]),
    })
    expect(String(empty._error)).toContain('a24DisclosureSource')
    const unknownValue = await handler.execute({
      state: stateWith([
        doc('坏来源', '2024-03-01', { a24Exception: 'A24.1', a24DisclosureSource: 'inventor' }),
      ]),
    })
    expect(String(unknownValue._error)).toContain('a24DisclosureSource')
  })

  it('宽限期起点前一日不适用 A24', async () => {
    const out = await handler.execute({
      state: stateWith(
        [
          doc('起点前一日', '2024-02-28', {
            a24Exception: 'A24.3',
            a24DisclosureSource: 'applicant',
          }),
        ],
        { filing_date: '2024-08-31', reference_date: '2024-08-31' },
      ),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_grace).toMatchObject([{ status: 'outside-period' }])
    expect(String(out.prior_art_filter_report)).toContain('宽限期外')
  })

  it('缺少公开日的文献保留并列入待核实，避免把未知日期当作非现有技术', async () => {
    const out = await handler.execute({ state: stateWith([{ title: '无日期' }]) })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_excluded).toEqual([])
    expect(out.prior_art_undated).toMatchObject([{ label: 'D1' }])
    expect(String(out.prior_art_filter_report)).toContain('缺少公开日')
    expect(String(out.prior_art_filter_report)).toContain('保留待人工核实')
  })

  it('不可解析的公开日保留并列入待核实', async () => {
    const out = await handler.execute({ state: stateWith([doc('坏日期', '2024-13-01')]) })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_undated).toMatchObject([{ label: 'D1' }])
    expect(String(out.prior_art_filter_report)).toContain('2024-13-01')
  })

  it('从 Wayback Machine 存档 URL 推定公开日', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: '存档页', url: 'https://web.archive.org/web/20230501000000/https://example.com/a' },
      ]),
    })
    expect(out.prior_art).toHaveLength(1)
    expect(out.prior_art_undated).toEqual([])
  })

  it('月级公开日推定到月末后再与截止日比较', async () => {
    const before = await handler.execute({ state: stateWith([doc('五月', '2024-05')]) })
    expect(before.prior_art).toHaveLength(1)
    const after = await handler.execute({ state: stateWith([doc('六月', '2024-06')]) })
    expect(after.prior_art).toEqual([])
    expect(after.prior_art_excluded).toMatchObject([{ publicationDate: '2024-06-30' }])
  })

  it('输出保留原始 D 标号，过滤后不影响引用接地', async () => {
    const out = await handler.execute({
      state: stateWith([doc('被排除', '2024-07-01'), doc('被保留', '2023-01-01')]),
    })
    expect(out.prior_art).toMatchObject([{ title: '被保留', dLabel: 'D2' }])
  })

  it('params 可指定检索结果、截止日与申请日的状态键', async () => {
    const out = await handler.execute({
      state: {
        hits: [doc('自定义状态键', '2023-01-01')],
        cutoff: '2024-06-01',
        filed: '2024-06-01',
        prior_art_key: 'hits',
        reference_date_key: 'cutoff',
        filing_date_key: 'filed',
      },
    })
    expect(out.prior_art).toMatchObject([{ title: '自定义状态键', dLabel: 'D1' }])
  })

  it('params 可指定公开日与 A24 标注字段', async () => {
    const out = await handler.execute({
      state: stateWith(
        [{ title: '自定义字段', publishedAt: '2024-02-01', grace: 'A24.1', graceSource: 'applicant' }],
        {
          publication_date_key: 'publishedAt',
          a24_exception_key: 'grace',
          a24_disclosure_source_key: 'graceSource',
        },
      ),
    })
    expect(out.prior_art_excluded).toMatchObject([{ reason: 'a24-grace-period' }])
  })

  it('非法 A24 标注使阶段降级，避免静默按现有技术处理', async () => {
    const out = await handler.execute({
      state: stateWith([doc('坏标注', '2024-03-01', { a24Exception: 'A24.9' })]),
    })
    expect(String(out._error)).toContain('[prior-art-filter]')
    expect(String(out._error)).toContain('a24Exception')
    expect(out.prior_art).toBeUndefined()
  })

  it('检索结果为空时通过，并说明无需过滤', async () => {
    const out = await handler.execute({ state: stateWith([]) })
    expect(out.prior_art).toEqual([])
    expect(out.prior_art_excluded).toEqual([])
    expect(String(out.prior_art_filter_report)).toContain('检索结果为空')
  })

  it('检索阶段未产出 prior_art 时降级', async () => {
    const out = await handler.execute({
      state: { reference_date: '2024-06-01', filing_date: '2024-06-01' },
    })
    expect(String(out._error)).toContain('prior_art')
  })

  it('缺少或不可解析截止日时降级', async () => {
    const missing = await handler.execute({ state: { prior_art: [], filing_date: '2024-06-01' } })
    expect(String(missing._error)).toContain('reference_date')
    const invalid = await handler.execute({
      state: { prior_art: [], reference_date: '2024-13-01', filing_date: '2024-06-01' },
    })
    expect(String(invalid._error)).toContain('reference_date')
  })

  it('月级截止日或申请日降级，避免按月初误判', async () => {
    const reference = await handler.execute({
      state: stateWith([doc('五月公开', '2024-05-10')], {
        reference_date: '2024-06',
        filing_date: '2024-06-01',
      }),
    })
    expect(String(reference._error)).toContain('reference_date')
    expect(String(reference._error)).toContain('仅精确到月')
    expect(reference.prior_art).toBeUndefined()

    const filing = await handler.execute({
      state: stateWith([doc('五月公开', '2024-05-10')], { filing_date: '2024年6月' }),
    })
    expect(String(filing._error)).toContain('filing_date')
    expect(String(filing._error)).toContain('仅精确到月')
    expect(filing.prior_art).toBeUndefined()
  })

  it('已提供的申请日不可解析时降级', async () => {
    const out = await handler.execute({
      state: { prior_art: [], reference_date: '2024-06-01', filing_date: '2024-13-01' },
    })
    expect(String(out._error)).toContain('filing_date')
  })

  it('条目不是对象时保留并列入待核实', async () => {
    const out = await handler.execute({ state: stateWith(['纯文本条目']) })
    expect(out.prior_art).toEqual(['纯文本条目'])
    expect(out.prior_art_undated).toMatchObject([
      { label: 'D1', title: '#1', reason: '条目不是对象，无法读取公开日' },
    ])
  })

  it('缺少标题、专利号与 URL 时用位次命名；已有合法 D 标号不覆盖', async () => {
    const out = await handler.execute({
      state: stateWith([
        { publicationDate: '2023-01-01', dLabel: 5 },
        { publicationDate: '2023-01-01', dLabel: 'X' },
        { publicationDate: '2023-01-01', dLabel: '  ' },
        { publicationDate: '2023-01-01', dLabel: 'D9' },
      ]),
    })
    expect(out.prior_art).toMatchObject([
      { dLabel: 'D1' },
      { dLabel: 'X' },
      { dLabel: 'D3' },
      { dLabel: 'D9' },
    ])
  })

  it('保留条目出现在过滤后列表中', async () => {
    const out = await handler.execute({ state: stateWith([{ publicationDate: '2023-01-01' }]) })
    expect(out.prior_art).toMatchObject([{ publicationDate: '2023-01-01', dLabel: 'D1' }])
  })

  it('公开日字段不是字符串时列入待核实', async () => {
    const out = await handler.execute({ state: stateWith([{ title: '坏字段', publicationDate: 20230101 }]) })
    expect(out.prior_art_undated).toMatchObject([{ reason: 'publicationDate 不是字符串' }])
  })

  it('A24 标注为空或非字符串时降级', async () => {
    const empty = await handler.execute({ state: stateWith([doc('空标注', '2024-03-01', { a24Exception: '' })]) })
    expect(String(empty._error)).toContain('a24Exception')
    const wrongType = await handler.execute({ state: stateWith([doc('坏类型', '2024-03-01', { a24Exception: 2 })]) })
    expect(String(wrongType._error)).toContain('a24Exception')
  })

  it('公开日未知但标注 A24 → 记录未判定说明', async () => {
    const out = await handler.execute({
      state: stateWith([{ title: '无日期', a24Exception: 'A24.1', a24DisclosureSource: 'applicant' }]),
    })
    expect(String(out.prior_art_filter_report)).toContain('公开日未知，A24 未判定')
  })

  it('各字段配置参数非法时分别降级', async () => {
    const cases = [
      'prior_art_key',
      'reference_date_key',
      'filing_date_key',
      'priority_date_key',
      'a24_exception_key',
      'a24_disclosure_source_key',
    ] as const
    for (const key of cases) {
      const out = await handler.execute({ state: stateWith([], { [key]: 3 }) })
      expect(String(out._error)).toContain(key)
    }
  })

  it('字段配置参数非法时降级', async () => {
    const out = await handler.execute({
      state: stateWith([], { publication_date_key: 3 }),
    })
    expect(String(out._error)).toContain('publication_date_key')
  })
})
