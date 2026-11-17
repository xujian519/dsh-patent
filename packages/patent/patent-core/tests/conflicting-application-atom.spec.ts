import { describe, expect, it } from 'vitest'
import { conflictingApplicationAtom, ConflictingApplicationHandler } from '../src/atoms/handlers/builtin/conflicting-application.ts'

const handler = new ConflictingApplicationHandler()

const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  applicationNumber: 'CN202310000001',
  publicationNumber: 'CN123456A',
  title: '在先申请',
  filingDate: '2023-01-01',
  publicationDate: '2024-07-01',
  sameInvention: true,
  ...extra,
})

const stateWith = (
  entries: unknown[] | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(entries !== undefined ? { conflicting_applications: entries } : {}),
  reference_date: '2024-06-01',
  reference_basis: 'filing-date',
  filing_date: '2024-06-01',
  ...overrides,
})

describe('conflicting-application atom', () => {
  it('声明报告为主输出，三个分类列表为后续输出键', () => {
    expect(conflictingApplicationAtom.name).toBe('conflicting-application')
    expect(conflictingApplicationAtom.category).toBe('compare')
    expect(conflictingApplicationAtom.outputSchema).toEqual([
      'conflicting_application_report',
      'conflicting_applications',
      'conflicting_application_excluded',
      'conflicting_application_unknown',
    ])
  })

  it('在先申请、在后公布且同样性为真时确认抵触申请（A22.2 第二句正例）', async () => {
    const out = await handler.execute({ state: stateWith([entry()]) })
    expect(out.conflicting_applications).toMatchObject([
      {
        label: 'E1',
        publicationNumber: 'CN123456A',
        effectiveFilingDate: '2023-01-01',
        filingBasis: 'filing-date',
        publicationDate: '2024-07-01',
        sameInvention: true,
      },
    ])
    expect(out.conflicting_application_excluded).toEqual([])
    expect(out.conflicting_application_unknown).toEqual([])
    const report = String(out.conflicting_application_report)
    expect(report).toContain('确认 1 件，排除 0 件，待定 0 件')
    expect(report).toContain('仅用于新颖性判断')
    expect(report).toContain('不得与其它文件组合评价创造性')
  })

  it('公开日等于目标申请日仍构成抵触申请（申请日以后含申请日）', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: '2024-06-01' })]),
    })
    expect(out.conflicting_applications).toHaveLength(1)
    expect(out.conflicting_application_excluded).toEqual([])
  })

  it('公开日早于目标申请日时属于现有技术，不按抵触申请处理（A22.5 反例）', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: '2024-05-31' })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_excluded).toMatchObject([
      { label: 'E1', reason: 'published-before-target', publicationDate: '2024-05-31' },
    ])
    expect(String(out.conflicting_application_report)).toContain('现有技术（A22.5）')
  })

  it('申请日与目标申请日相同不构成抵触申请，并提示 A9 重复授权风险', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ filingDate: '2024-06-01' })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_excluded).toMatchObject([
      { label: 'E1', reason: 'filed-on-same-day', filingDate: '2024-06-01' },
    ])
    expect(String(out.conflicting_application_report)).toContain('A9')
  })

  it('申请日晚于目标申请日时不构成抵触申请', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ filingDate: '2024-07-01' })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_excluded).toMatchObject([
      { label: 'E1', reason: 'filed-after-target' },
    ])
  })

  it('时间条件满足但同样性为否时不构成抵触申请', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ sameInvention: false })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_excluded).toMatchObject([
      { label: 'E1', reason: 'different-invention' },
    ])
    expect(String(out.conflicting_application_report)).toContain('判定为否')
  })

  it.each([undefined, null])('未提供同样性判定（%s）时保留待定，不默认为同样的发明创造', async (sameInvention) => {
    const out = await handler.execute({
      state: stateWith([entry({ sameInvention })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_unknown).toMatchObject([{ label: 'E1' }])
    expect(String(out.conflicting_application_report)).toContain('未提供同样的发明或者实用新型判定')
    expect(String(out.conflicting_application_report)).toContain('待核实')
  })

  it('缺少公开日时保留待定，不据此排除', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: undefined })]),
    })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_unknown).toMatchObject([
      { label: 'E1', reason: '缺少公开日' },
    ])
  })

  it('空白日期按缺失处理，不当作可解析日期', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: '   ' })]),
    })
    expect(out.conflicting_application_unknown).toMatchObject([
      { label: 'E1', reason: '缺少公开日' },
    ])
  })

  it('在先申请的优先权日早于申请日时按优先权日计算有效申请日', async () => {
    const out = await handler.execute({
      state: stateWith([
        entry({ filingDate: '2024-07-01', priorityDate: '2023-01-01', publicationDate: '2024-08-01' }),
      ]),
    })
    expect(out.conflicting_applications).toMatchObject([
      { effectiveFilingDate: '2023-01-01', filingBasis: 'priority-date' },
    ])
    expect(String(out.conflicting_application_report)).toContain('有效申请日（优先权日）')
  })

  it('优先权日晚于申请日时仍按申请日计算有效申请日', async () => {
    const out = await handler.execute({
      state: stateWith([
        entry({ filingDate: '2024-01-01', priorityDate: '2024-02-01' }),
      ]),
    })
    expect(out.conflicting_applications).toMatchObject([
      { effectiveFilingDate: '2024-01-01', filingBasis: 'filing-date' },
    ])
  })

  it('优先权日不可解析时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ priorityDate: '2023-13-01' })]),
    })
    expect(String(out._error)).toContain('priorityDate 不是可识别的日期')
  })

  it('reference_date 缺失时回退到 filing_date', async () => {
    const state = stateWith([entry()], { reference_date: undefined })
    // 显式删除 reference_date，模拟 time-baseline 未产出。
    delete state.reference_date
    const out = await handler.execute({ state })
    expect(out.conflicting_applications).toHaveLength(1)
    expect(String(out.conflicting_application_report)).toContain('申请日 2024-06-01')
  })

  it('reference_basis 为优先权日时报告使用优先权日', async () => {
    const out = await handler.execute({
      state: stateWith([entry()], { reference_date: '2023-06-01', reference_basis: 'priority-date' }),
    })
    expect(out.conflicting_applications).toHaveLength(1)
    expect(String(out.conflicting_application_report)).toContain('优先权日 2023-06-01')
  })

  it('未声明 reference_basis 时报告使用中性时间基准', async () => {
    const state = stateWith([entry()], { reference_date: '2024-06-01' })
    delete state.reference_basis
    const out = await handler.execute({ state })
    expect(out.conflicting_applications).toHaveLength(1)
    expect(String(out.conflicting_application_report)).toContain('目标时间基准 2024-06-01')
  })

  it('标识字段类型不符时回退到序号，不影响时间判定', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationNumber: 123, applicationNumber: 456, title: 789 })]),
    })
    expect(out.conflicting_applications).toMatchObject([{ label: 'E1', id: '#1', title: '#1' }])
  })

  it('未提供候选列表时明确说明“未发现不等同于已排除”', async () => {
    const out = await handler.execute({ state: stateWith(undefined) })
    expect(out.conflicting_applications).toEqual([])
    expect(out.conflicting_application_excluded).toEqual([])
    expect(out.conflicting_application_unknown).toEqual([])
    expect(String(out.conflicting_application_report)).toContain('不等同于已排除抵触申请')
  })

  it('空候选列表时说明列表为空', async () => {
    const out = await handler.execute({ state: stateWith([]) })
    expect(String(out.conflicting_application_report)).toContain('候选列表为空，未发现抵触申请')
  })

  it('不把既有 prior_art 当作抵触申请候选（C-02 依赖契约）', async () => {
    const state = stateWith(undefined, {
      prior_art: [{ title: 'D1', publicationDate: '2023-01-01' }],
    })
    const out = await handler.execute({ state })
    expect(out.conflicting_applications).toEqual([])
    expect(String(out.conflicting_application_report)).toContain('未提供抵触申请候选')
  })

  it('候选列表不是数组时降级', async () => {
    const out = await handler.execute({ state: stateWith(undefined, { conflicting_applications: {} }) })
    expect(String(out._error)).toContain('conflicting_application')
  })

  it('条目不是对象时降级', async () => {
    const out = await handler.execute({ state: stateWith(['not-an-object']) })
    expect(String(out._error)).toContain('E1 条目不是对象')
  })

  it('日期字段格式错误时降级，不静默当作缺失', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ filingDate: '2024-13-01' })]),
    })
    expect(String(out._error)).toContain('filingDate 不是可识别的日期')
  })

  it('月级日期不足以判断时间关系时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: '2024-07' })]),
    })
    expect(String(out._error)).toContain('publicationDate 仅精确到月')
  })

  it('目标时间基准仅到月时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry()], { reference_date: '2024-06' }),
    })
    expect(String(out._error)).toContain('目标时间基准')
    expect(String(out._error)).toContain('仅精确到月')
  })

  it('日期字段类型错误时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: 20240701 })]),
    })
    expect(String(out._error)).toContain('publicationDate 必须是字符串')
  })

  it('sameInvention 不是布尔值时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ sameInvention: 'yes' })]),
    })
    expect(String(out._error)).toContain('sameInvention 必须是布尔值')
  })

  it('缺少申请日时保留待定', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ filingDate: undefined })]),
    })
    expect(out.conflicting_application_unknown).toMatchObject([
      { label: 'E1', reason: '缺少申请日' },
    ])
  })

  it('缺少目标时间基准时降级', async () => {
    const state = stateWith([entry()], { reference_date: undefined, filing_date: undefined })
    delete state.reference_date
    delete state.filing_date
    const out = await handler.execute({ state })
    expect(String(out._error)).toContain('缺少目标申请日/优先权日')
  })

  it('目标时间基准不可解析时降级', async () => {
    const out = await handler.execute({
      state: stateWith([entry()], { reference_date: '2024-13-01' }),
    })
    expect(String(out._error)).toContain('目标时间基准')
  })

  it('reference_date 缺失时对申请日的月级与不可解析输入降级', async () => {
    const month = await handler.execute({
      state: stateWith([entry()], { reference_date: undefined, filing_date: '2024-06' }),
    })
    expect(String(month._error)).toContain('目标申请日')
    expect(String(month._error)).toContain('仅精确到月')
    const invalid = await handler.execute({
      state: stateWith([entry()], { reference_date: undefined, filing_date: '2024-13-01' }),
    })
    expect(String(invalid._error)).toContain('目标申请日')
    expect(String(invalid._error)).toContain('无法解析')
  })

  it('目标日期键参数非法时分别降级', async () => {
    const dateKey = await handler.execute({ state: stateWith([entry()], { target_date_key: '' }) })
    expect(String(dateKey._error)).toContain('target_date_key')
    const filingKey = await handler.execute({ state: stateWith([entry()], { target_filing_date_key: 1 }) })
    expect(String(filingKey._error)).toContain('target_filing_date_key')
  })

  it('标题与标识相同时不重复渲染书名号', async () => {
    const confirmed = await handler.execute({
      state: stateWith([entry({ title: undefined, applicant: '某公司' })]),
    })
    expect(confirmed.conflicting_applications).toMatchObject([{ title: 'CN123456A', applicant: '某公司' }])
    expect(String(confirmed.conflicting_application_report)).not.toContain('《CN123456A》')

    const excluded = await handler.execute({
      state: stateWith([entry({ title: undefined, filingDate: '2024-06-01' })]),
    })
    expect(String(excluded.conflicting_application_report)).toContain('- E1 CN123456A：')
    expect(String(excluded.conflicting_application_report)).not.toContain('《CN123456A》')

    const unknown = await handler.execute({
      state: stateWith([entry({ title: undefined, filingDate: undefined })]),
    })
    expect(String(unknown.conflicting_application_report)).toContain('- E1 CN123456A：缺少申请日')
    expect(String(unknown.conflicting_application_report)).not.toContain('《CN123456A》')
  })

  it('排除条目缺少公开日时只列申请日', async () => {
    const out = await handler.execute({
      state: stateWith([entry({ publicationDate: undefined, filingDate: '2024-07-01' })]),
    })
    expect(out.conflicting_application_excluded).toMatchObject([{ reason: 'filed-after-target' }])
    const report = String(out.conflicting_application_report)
    expect(report).toContain('申请日 2024-07-01，申请日不早于目标申请日')
    expect(report).not.toContain('公开日 undefined')
  })

  it('自定义状态键与非法键参数', async () => {
    const custom = await handler.execute({
      state: {
        candidates: [entry()],
        cutoff: '2024-06-01',
        reference_basis: 'filing-date',
        conflicting_applications_key: 'candidates',
        target_date_key: 'cutoff',
      },
    })
    expect(custom.conflicting_applications).toHaveLength(1)

    const invalid = await handler.execute({
      state: stateWith([entry()], { conflicting_applications_key: '' }),
    })
    expect(String(invalid._error)).toContain('conflicting_applications_key 必须是非空字符串')
  })
})
