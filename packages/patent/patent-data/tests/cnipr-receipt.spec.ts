// CNIPR 纯函数层：号码形态与规范化、请求规划、结果对齐、收据解析。
// 全部不触碰浏览器与 ego 全局，因此可在 Node 里直接跑；页内只取原文。
import { describe, expect, it } from 'vitest'
import {
  alignCniprResults,
  classifyCniprNumber,
  normalizeCniprAppNumber,
  normalizeCniprDate,
  normalizeCniprPdfUrls,
  parseCniprLegalRecords,
  parseCniprSearchTotal,
  planCniprLegalQueries,
  planCniprPdfRequests,
  planCniprSearchRequest,
  readCniprLegalPayload,
  readCniprPdfLinksPayload,
  readCniprScriptFailure,
  readCniprSearchPayload,
} from '@deepseek-ai/dsh-patent-data'

describe('normalizeCniprAppNumber', () => {
  it('puts the dot back before the check digit', () => {
    expect(normalizeCniprAppNumber('2023113560975')).toBe('202311356097.5')
    expect(normalizeCniprAppNumber('CN2023113560975')).toBe('CN202311356097.5')
    expect(normalizeCniprAppNumber(' cn202311356097A ')).toBe('CN202311356097.A')
  })

  it('keeps a number that already carries the dot, and other forms as-is', () => {
    expect(normalizeCniprAppNumber('202311356097.5')).toBe('202311356097.5')
    expect(normalizeCniprAppNumber('CN122072823A')).toBe('CN122072823A')
    expect(normalizeCniprAppNumber('202311')).toBe('202311')
  })
})

describe('classifyCniprNumber', () => {
  it('separates publication numbers, application numbers, and everything else', () => {
    expect(classifyCniprNumber('CN122072823A')).toBe('pub')
    expect(classifyCniprNumber('ZL202311356097.5')).toBe('other')
    expect(classifyCniprNumber('202311356097.5')).toBe('app')
    expect(classifyCniprNumber('2023113560975')).toBe('app')
    expect(classifyCniprNumber('US11452699B2')).toBe('other')
  })
})

describe('normalizeCniprPdfUrls', () => {
  it('forces http, strips an existing scheme, and dedupes', () => {
    expect(normalizeCniprPdfUrls([
      'https://pic.cnipr.com/pdfcn/a/PDF_PID/x.PDF',
      'pic.cnipr.com/pdfcn/a/PDF_PID/x.PDF',
      'http://pic.cnipr.com/pdfcn/b/PDF_PID/y.PDF',
    ])).toEqual([
      'http://pic.cnipr.com/pdfcn/a/PDF_PID/x.PDF',
      'http://pic.cnipr.com/pdfcn/b/PDF_PID/y.PDF',
    ])
  })
})

describe('planCniprPdfRequests', () => {
  it('sends publication numbers and reports the rest as unsupported', () => {
    const plan = planCniprPdfRequests(['CN122072823A', '202311356097.5'])
    expect(plan.requested).toEqual(['CN122072823A'])
    expect(plan.unsupported).toEqual([
      { number: '202311356097.5', urls: [], unexamined: false, authorized: false, error: 'CNIPR 通道只处理公开(公告)号' },
    ])
  })
})

describe('planCniprLegalQueries', () => {
  it('queries application numbers directly and resolves publication numbers first', () => {
    const plan = planCniprLegalQueries(['2023113560975', 'CN122072823A', 'US11452699B2'])
    expect(plan.queries).toEqual([
      { number: '2023113560975', appNumber: '202311356097.5' },
      { number: 'CN122072823A', pubNumber: 'CN122072823A' },
    ])
    expect(plan.unsupported).toEqual([
      { number: 'US11452699B2', appNumber: '', total: null, records: [], error: 'CNIPR 通道只处理中国申请号与公开(公告)号' },
    ])
  })
})

describe('alignCniprResults', () => {
  it('keeps request order and marks numbers the script never reported', () => {
    const aligned = alignCniprResults(
      ['CN1', 'CN2', 'CN3'],
      [{ number: 'CN3', marker: 'reported' }, { number: 'CN1', marker: 'reported' }],
      number => ({ number, marker: 'missing' }),
    )
    expect(aligned).toEqual([
      { number: 'CN1', marker: 'reported' },
      { number: 'CN2', marker: 'missing' },
      { number: 'CN3', marker: 'reported' },
    ])
  })
})

describe('readCniprScriptFailure', () => {
  it('keeps the login class and folds an unknown class into page_state', () => {
    expect(readCniprScriptFailure({ code: 'login_required', message: '请重新登录' }))
      .toEqual({ code: 'login_required', message: '请重新登录' })
    // 未知分类只可能来自脚本改了一半的运行，归入页面交互失败比放行安全。
    expect(readCniprScriptFailure({ code: 'something_new' })).toEqual({ code: 'page_state', message: '' })
    expect(readCniprScriptFailure(undefined)).toBeUndefined()
    expect(readCniprScriptFailure(null)).toBeUndefined()
    // 非对象的 error 同样是畸形收据：保留原文并按 page_state 报出。
    expect(readCniprScriptFailure('boom')).toEqual({ code: 'page_state', message: 'boom' })
    expect(readCniprScriptFailure(42)).toEqual({ code: 'page_state', message: '脚本回传的 error 不是对象' })
  })
})

describe('readCniprPdfLinksPayload', () => {
  it('maps reported links and drops entries that carry no number', () => {
    const read = readCniprPdfLinksPayload({
      items: [
        { number: 'CN122072823A', matches: ['pic.cnipr.com/pdfcn/a/PDF_PID/x.PDF'], isUnexamined: true, isAuthorized: false },
        { number: 'CN100000000A', error: '检索不到该号' },
        { matches: ['pic.cnipr.com/pdfcn/b.PDF'] },
        'not-an-object',
      ],
    })
    expect(read.items).toEqual([
      { number: 'CN122072823A', urls: ['http://pic.cnipr.com/pdfcn/a/PDF_PID/x.PDF'], unexamined: true, authorized: false },
      { number: 'CN100000000A', urls: [], unexamined: false, authorized: false, error: '检索不到该号' },
    ])
    expect(read.failure).toBeUndefined()
  })

  it('treats a malformed receipt as a channel failure and keeps a script-level failure', () => {
    expect(readCniprPdfLinksPayload(null)).toEqual({
      items: [],
      failure: { code: 'page_state', message: 'CNIPR 脚本收据不是对象' },
    })
    expect(readCniprPdfLinksPayload({ items: 'nope' })).toEqual({
      items: [],
      failure: { code: 'page_state', message: 'CNIPR 脚本收据缺少 items 数组' },
    })
    // 骨架缺失但脚本给了失败原因时，优先保留脚本自己的分类。
    expect(readCniprPdfLinksPayload({ items: 'nope', error: { code: 'login_required', message: '未检测到登录态' } }))
      .toEqual({ items: [], failure: { code: 'login_required', message: '未检测到登录态' } })
    const read = readCniprPdfLinksPayload({ items: [], error: { code: 'login_required', message: '未检测到登录态' } })
    expect(read.items).toEqual([])
    expect(read.failure).toEqual({ code: 'login_required', message: '未检测到登录态' })
  })
})

describe('parseCniprLegalRecords', () => {
  const pageText = [
    '法律状态检索结果',
    '申请号：202311356097.5 法律状态公告日：2023.12.29 法律状态：实质审查的生效 法律状态信息：实质审查的生效 IPC(主分类):H01M4/62',
    '申请号：202311356097.5 法律状态公告日：2023.12.12 法律状态：公开 法律状态信息：公开',
    '共 2 条记录',
  ].join(' ')

  it('parses the count and every record', () => {
    expect(parseCniprLegalRecords(pageText)).toEqual({
      total: 2,
      records: [
        { app_number: '202311356097.5', announce_date: '2023.12.29', status: '实质审查的生效', status_info: '实质审查的生效 IPC(主分类):H01M4/62' },
        { app_number: '202311356097.5', announce_date: '2023.12.12', status: '公开', status_info: '公开' },
      ],
    })
  })

  it('reports a zero-hit page as null count rather than inventing zero', () => {
    // 零命中的结果页不输出「共 N 条记录」标记（实测），因此 total 必须是 null。
    expect(parseCniprLegalRecords('法律状态检索结果 没有检索到相关记录')).toEqual({ total: null, records: [] })
  })
})

describe('readCniprLegalPayload', () => {
  it('parses the page text a script returned for an application number', () => {
    const read = readCniprLegalPayload({
      items: [{
        number: '2023113560975',
        appNumber: '202311356097.5',
        text: '申请号：202311356097.5 法律状态公告日：2023.12.29 法律状态：实质审查的生效 法律状态信息：实质审查的生效',
      }],
    })
    expect(read.items).toEqual([{
      number: '2023113560975',
      appNumber: '202311356097.5',
      total: null,
      records: [{ app_number: '202311356097.5', announce_date: '2023.12.29', status: '实质审查的生效', status_info: '实质审查的生效' }],
    }])
    expect(read.failure).toBeUndefined()
  })

  it('keeps a resolved publication number and a per-number error', () => {
    const read = readCniprLegalPayload({
      items: [
        { number: 'CN122072823A', appNumber: '202311356097.5', resolvedFrom: 'CN122072823A', text: '共 1 条记录 申请号：202311356097.5 法律状态公告日：2023.12.29 法律状态：公开 法律状态信息：公开' },
        { number: 'CN100000000A', resolvedFrom: 'CN100000000A', error: '公开(公告)号 CN100000000A 未检索到申请号，无法查询法律状态' },
        { number: 'CN100000001A', appNumber: '' },
        { number: 'CN100000002A', appNumber: '202311356097.5', error: '等法律状态结果页失败' },
        { number: 'CN100000003A', appNumber: '202311356097.5' },
        { text: 'no number' },
      ],
    })
    expect(read.items).toEqual([
      {
        number: 'CN122072823A',
        appNumber: '202311356097.5',
        resolvedFrom: 'CN122072823A',
        total: 1,
        records: [{ app_number: '202311356097.5', announce_date: '2023.12.29', status: '公开', status_info: '公开' }],
      },
      {
        number: 'CN100000000A',
        appNumber: '',
        resolvedFrom: 'CN100000000A',
        total: null,
        records: [],
        error: '公开(公告)号 CN100000000A 未检索到申请号，无法查询法律状态',
      },
      // 没解析出申请号、脚本也没报错的条目：按无法查询处理，不静默返回空记录。
      { number: 'CN100000001A', appNumber: '', total: null, records: [], error: '号 CN100000001A 未解析出申请号，无法查询法律状态' },
      { number: 'CN100000002A', appNumber: '202311356097.5', total: null, records: [], error: '等法律状态结果页失败' },
      // 条目缺原文（脚本只在成功时带 text）：按零记录返回，不编造计数。
      { number: 'CN100000003A', appNumber: '202311356097.5', total: null, records: [] },
    ])
  })

  it('treats a malformed receipt as a channel failure and carries a script-level failure', () => {
    expect(readCniprLegalPayload(undefined)).toEqual({
      items: [],
      failure: { code: 'page_state', message: 'CNIPR 脚本收据不是对象' },
    })
    expect(readCniprLegalPayload({ items: 'nope' })).toEqual({
      items: [],
      failure: { code: 'page_state', message: 'CNIPR 脚本收据缺少 items 数组' },
    })
    expect(readCniprLegalPayload({ items: [], error: { code: 'page_state', message: '等检索结果页失败' } }).failure)
      .toEqual({ code: 'page_state', message: '等检索结果页失败' })
  })
})

describe('planCniprSearchRequest', () => {
  it('defaults to one page and clamps to the channel ceiling', () => {
    expect(planCniprSearchRequest()).toEqual({ limit: 10, pages: 1 })
    expect(planCniprSearchRequest(1)).toEqual({ limit: 1, pages: 1 })
    expect(planCniprSearchRequest(10)).toEqual({ limit: 10, pages: 1 })
    expect(planCniprSearchRequest(11)).toEqual({ limit: 11, pages: 2 })
    expect(planCniprSearchRequest(30)).toEqual({ limit: 30, pages: 3 })
    // 上限而非无限翻页：超过 30 的请求收敛到 3 页，由调用方在 warnings 里说明截断。
    expect(planCniprSearchRequest(50)).toEqual({ limit: 30, pages: 3 })
    expect(planCniprSearchRequest(0)).toEqual({ limit: 10, pages: 1 })
    expect(planCniprSearchRequest(-5)).toEqual({ limit: 10, pages: 1 })
    expect(planCniprSearchRequest(10.7)).toEqual({ limit: 10, pages: 1 })
  })
})

describe('parseCniprSearchTotal', () => {
  it('reads the classified-navigation total, including the zero-hit page', () => {
    expect(parseCniprSearchTotal('全部655件专利')).toBe(655)
    expect(parseCniprSearchTotal('全部 0 件专利')).toBe(0)
  })

  it('returns null when the marker is absent', () => {
    expect(parseCniprSearchTotal('所有分类 >')).toBeNull()
    expect(parseCniprSearchTotal('')).toBeNull()
  })
})

describe('normalizeCniprDate', () => {
  it('normalizes the page date to the hyphenated form', () => {
    expect(normalizeCniprDate('2020.08.25')).toBe('2020-08-25')
    expect(normalizeCniprDate(' 2020-08-25 ')).toBe('2020-08-25')
  })

  it('returns anything else as-is rather than dropping it', () => {
    expect(normalizeCniprDate('2020.8.5')).toBe('2020.8.5')
    expect(normalizeCniprDate('')).toBe('')
  })
})

describe('readCniprSearchPayload', () => {
  // 结果行原文取自 2026-10-12 真机探测（搜索「石墨烯电池」第一条）。
  const rowText = '申请号： CN201922356571.X 申请日： 2019.12.25 公开(公告)号： CN211350734U 公开(公告)日： 2020.08.25 '
    + '同日申请： 分案原申请号： 申请(专利权)人： 上海碳源汇谷新材料科技有限公司 '
    + '分类号： H01M2/10(2006.01);H01M10/48(2006.01) 优先权： 摘要：本实用新型属于石墨烯电池技术领域。 机器翻译'

  it('maps the rows, the total, and the clean title attribute', () => {
    const read = readCniprSearchPayload({
      header: '全部655件专利',
      items: [
        { cursor: 0, number: 'CN211350734U', title: '一种稳定性高的石墨烯电池', text: rowText },
      ],
    })
    expect(read.total).toBe(655)
    expect(read.hits).toEqual([{
      patent: 'CN211350734U',
      title: '一种稳定性高的石墨烯电池',
      assignee: '上海碳源汇谷新材料科技有限公司',
      publicationDate: '2020-08-25',
      abstract: '本实用新型属于石墨烯电池技术领域。',
    }])
  })

  it('falls back to the labelled publication number and drops rows with no number', () => {
    const read = readCniprSearchPayload({
      header: '全部2件专利',
      items: [
        { cursor: 0, number: null, title: null, text: rowText },
        // 勾选框没给号、行文本里也没有「公开(公告)号」：这一行结构不完整，丢弃而不是编一个号。
        { cursor: 1, number: null, title: '无号的行', text: '申请号： CN201922356571.X 摘要：无公开号' },
        { cursor: 2, number: 'CN1A', title: null, text: '公开(公告)号： CN1A' },
      ],
    })
    expect(read.hits.map(hit => hit.patent)).toEqual(['CN211350734U', 'CN1A'])
    // 缺标题留空，不用行内其它文本顶替；缺标签字段同样留空。
    expect(read.hits[1]?.title).toBe('')
    expect(read.hits[1]?.assignee).toBe('')
    expect(read.hits[1]?.publicationDate).toBe('')
    expect(read.hits[1]?.abstract).toBe('')
    // 丢弃不能静默：通道按这个计数把残缺结果报成页面结构失败。
    expect(read.dropped).toBe(1)
  })

  it('counts every row it cannot parse, including non-object entries', () => {
    const read = readCniprSearchPayload({
      header: '全部3件专利',
      items: [{ number: 'CN1A' }, null, { cursor: 2 }],
    })

    expect(read.hits.map(hit => hit.patent)).toEqual(['CN1A'])
    expect(read.dropped).toBe(2)
  })

  it('keeps a row whose text is missing, taking the number from the attribute alone', () => {
    const read = readCniprSearchPayload({
      header: '全部1件专利',
      items: [{ cursor: 0, number: 'CN1A', title: '标题' }],
    })
    expect(read.hits).toEqual([{
      patent: 'CN1A',
      title: '标题',
      assignee: '',
      publicationDate: '',
      abstract: '',
    }])
  })

  it('reports a null total when the page stops publishing it', () => {
    expect(readCniprSearchPayload({ items: [] }).total).toBeNull()
    expect(readCniprSearchPayload({ header: '', items: [] }).total).toBeNull()
    expect(readCniprSearchPayload({ header: '全部0件专利', items: [] })).toEqual({ total: 0, hits: [], dropped: 0 })
  })

  it('treats a malformed receipt as a channel failure and carries a script-level failure', () => {
    expect(readCniprSearchPayload(undefined)).toEqual({
      total: null,
      hits: [],
      dropped: 0,
      failure: { code: 'page_state', message: 'CNIPR 脚本收据不是对象' },
    })
    expect(readCniprSearchPayload({ items: 'nope' })).toEqual({
      total: null,
      hits: [],
      dropped: 0,
      failure: { code: 'page_state', message: 'CNIPR 脚本收据缺少 items 数组' },
    })
    expect(readCniprSearchPayload({ header: '全部2件专利', items: [], error: { code: 'login_required', message: '未检测到登录态' } }))
      .toEqual({ total: 2, hits: [], dropped: 0, failure: { code: 'login_required', message: '未检测到登录态' } })
  })
})
