/**
 * CNIPR（中国知识产权网）通道的纯函数层：号码分类与规范化、脚本收据解析、页面文本解析。
 *
 * 脚本以 stdin 交给 ego-browser 执行，其中的代码只能在真实站点上验证；因此脚本只负责
 * 驱动页面并回传原文（结果页 innerText、直链原文、申请号原文），号码与文本的判定一律
 * 回到这里，由单测覆盖。ego 的 Node 运行时没有稳定的自身路径，脚本之间无法共享模块，
 * 这也是把解析留在包内而不是留在脚本里的原因。
 * @module @deepseek-ai/dsh-patent-data/cnipr-receipt
 */

import type {
  CniprLegalQuery,
  CniprLegalRecord,
  CniprLegalStatusItem,
  CniprPdfLinkItem,
  CniprScriptFailure,
  CniprScriptFailureCode,
  CniprSearchHit,
  CniprSearchRequest,
} from './types.ts'

/** 详情页 HTML 里的全文 PDF 直链模式；页内抽取与包内归一化共用这一处定义。 */
export const CNIPR_PDF_URL_PATTERN = String.raw`pic\.cnipr\.com\/pdfcn\/[^"'<>\s]+\.PDF`

/** 未登录页面文本的特征。已登录页以「欢迎您」为准，本模式只用于区分失败原因。 */
export const CNIPR_LOGIN_HINT_PATTERN = '登录|用户名|密码'

/** CNIPR 站点根地址；`pic.cnipr.com` 仅 HTTP 可达，检索与法律状态入口都是这个根。 */
export const CNIPR_BASE_URL = 'http://search.cnipr.com'

/** 法律状态结果页的「共 N 条记录」；零命中的结果页不输出该标记。 */
const LEGAL_TOTAL_PATTERN = /共\s*(\d+)\s*条记录/

/** 法律状态结果里一条记录的四段，用一个正则一次解析出全部字段。 */
const LEGAL_RECORD_PATTERN = new RegExp([
  '申请号[：:]\\s*((?:CN)?\\d{12}\\.[0-9A-Z])',
  '\\s+法律状态公告日[：:]\\s*([\\d.]+)',
  '\\s+法律状态[：:]\\s*(\\S+)',
  '\\s+法律状态信息[：:]\\s*([\\s\\S]*?)',
  '(?=\\s*(?:申请号[：:]|共\\s*\\d+\\s*条记录|知识产权出版社|$))',
].join(''), 'giu')

/** 结果页的「全部 N 件专利」；零命中页同样输出该标记（实测 `全部0件专利`）。 */
const SEARCH_TOTAL_PATTERN = /全部\s*(\d+)\s*件/u

/** 结果行里带标签的字段：公开(公告)号、公开(公告)日、申请人、摘要。 */
const SEARCH_FIELD_PATTERNS = {
  publicationNumber: /公开\(公告\)号[：:]\s*(\S+)/u,
  publicationDate: /公开\(公告\)日[：:]\s*([\d.]+)/u,
  assignee: /申请\(专利权\)人[：:]\s*([\s\S]*?)(?=\s*(?:分类号|优先权|摘要|发明\(设计\)人)[：:]|$)/u,
  abstract: /摘要[：:]\s*([\s\S]*?)(?:\s*机器翻译)?$/u,
} as const

/** 检索结果页每页条数：本部署账号下页面固定该值。 */
export const CNIPR_SEARCH_PAGE_SIZE = 10

/**
 * 单次检索的条数上限（3 页 × 10 条）。这是上限而非可配置项：页面可选的每页 20/30 条
 * 受站点等级校验（实测本部署账号 `checkCommonAuth()` 返回 `4003`，被拒回 10 条），
 * 因此「取更多」只能靠翻页，而每多一页就是向后端多要一次检索。
 */
export const CNIPR_SEARCH_MAX_HITS = 30

/**
 * 检索结果页里第一条记录的申请号（用于公开(公告)号 → 申请号）。脚本以它的 `source`
 * 在页内解析申请号，包内解析同一个模式，避免两处各写一份号码形态。
 */
export const CNIPR_RESULT_APP_NUMBER_PATTERN = /申请号[：:]\s*((?:CN)?\d{12}\.[0-9A-Z])/iu

/** 公开(公告)号形态。 */
const PUB_NUMBER_PATTERN = /^(?:CN|ZL)\d{7,}[A-Z]$/u

/** 规范化后的申请号形态。 */
const APP_NUMBER_PATTERN = /^(?:CN)?\d{12}\.[0-9A-Z]$/u

/** 号码在本通道里的形态。 */
export const CNIPR_NUMBER_KINDS = ['app', 'pub', 'other'] as const

/** One CNIPR number kind: see {@link CNIPR_NUMBER_KINDS}. */
export type CniprNumberKind = (typeof CNIPR_NUMBER_KINDS)[number]

/**
 * 把申请号整成 CNIPR 认的「校验位前带小数点」写法。CNIPR 实测只认带小数点的写法：
 * `202311356097.5` 命中，`2023113560975` 查无结果。
 * @param raw - 原始申请号；可写 `202311356097.5`、`CN202311356097.5` 或 `2023113560975`。
 * @returns 带小数点的申请号（原样已合规时保持不变）。
 */
export function normalizeCniprAppNumber(raw: string): string {
  const trimmed = raw.replace(/\s/gu, '').toUpperCase()
  if (trimmed.includes('.')) return trimmed
  const bare = trimmed.replace(/^CN/u, '')
  if (/^\d{13}$/u.test(bare) || /^\d{12}[A-Z]$/u.test(bare)) {
    const dotted = `${bare.slice(0, 12)}.${bare.slice(12)}`
    return trimmed.startsWith('CN') ? `CN${dotted}` : dotted
  }
  return trimmed
}

/**
 * 判一个号在本通道里的形态；`other` 表示本通道不处理它（非中国号或形态不符）。
 * @param raw - 原始号。
 * @returns 申请号 / 公开(公告)号 / 其他。
 */
export function classifyCniprNumber(raw: string): CniprNumberKind {
  const normalized = raw.replace(/\s/gu, '').toUpperCase()
  if (PUB_NUMBER_PATTERN.test(normalized)) return 'pub'
  if (APP_NUMBER_PATTERN.test(normalizeCniprAppNumber(normalized))) return 'app'
  return 'other'
}

/**
 * 把详情页里抓到的直链整成可 GET 的 `http://` 直链并去重。`pic.cnipr.com` 仅 HTTP 可达，
 * `https://` 会握手超时，因此这里强制 http 并剥掉已有协议头。
 * @param matches - 页内按 {@link CNIPR_PDF_URL_PATTERN} 抓到的原样匹配。
 * @returns 去重后的 http 直链。
 */
export function normalizeCniprPdfUrls(matches: readonly string[]): string[] {
  return [...new Set(matches.map(url => `http://${url.replace(/^https?:\/\//iu, '')}`))]
}

/**
 * 解析法律状态结果页文本。计数与记录同页，故一次解析出两者。
 * @param text - 结果页的 innerText。
 * @returns `total` 取页面上的「共 N 条记录」（零命中时不输出该标记，此处返回 null，不编造 0）
 * 与解析出的记录。
 */
export function parseCniprLegalRecords(text: string): { total: number | null; records: CniprLegalRecord[] } {
  const folded = text.replace(/\s+/gu, ' ')
  const total = folded.match(LEGAL_TOTAL_PATTERN)
  const records: CniprLegalRecord[] = []
  for (const match of folded.matchAll(LEGAL_RECORD_PATTERN)) {
    records.push({
      app_number: group(match, 1),
      announce_date: group(match, 2),
      status: group(match, 3),
      status_info: group(match, 4).trim(),
    })
  }
  return { total: total === null ? null : Number(group(total, 1)), records }
}

/**
 * PDF 直链请求的规划：本通道只处理公开(公告)号（详情页直链按公开(公告)号检索），
 * 其余形态的号原样标成错误项，交给调用方按号回退。
 * @param numbers - 请求的号（调用方已归一去重）。
 * @returns 要发脚本的号，以及本通道不处理的号。
 */
export function planCniprPdfRequests(numbers: readonly string[]): { requested: string[]; unsupported: CniprPdfLinkItem[] } {
  const requested: string[] = []
  const unsupported: CniprPdfLinkItem[] = []
  for (const number of numbers) {
    if (classifyCniprNumber(number) === 'pub') requested.push(number)
    else unsupported.push({ number, urls: [], unexamined: false, authorized: false, error: 'CNIPR 通道只处理公开(公告)号' })
  }
  return { requested, unsupported }
}

/**
 * 法律状态请求的规划：申请号直接查，公开(公告)号先在检索结果页解析申请号，
 * 其余形态的号原样标成错误项。
 * @param numbers - 请求的号（调用方已归一去重）。
 * @returns 要发脚本的查询目标，以及本通道不处理的号。
 */
export function planCniprLegalQueries(numbers: readonly string[]): { queries: CniprLegalQuery[]; unsupported: CniprLegalStatusItem[] } {
  const queries: CniprLegalQuery[] = []
  const unsupported: CniprLegalStatusItem[] = []
  for (const number of numbers) {
    const kind = classifyCniprNumber(number)
    if (kind === 'app') queries.push({ number, appNumber: normalizeCniprAppNumber(number) })
    else if (kind === 'pub') queries.push({ number, pubNumber: number })
    else unsupported.push({ number, appNumber: '', total: null, records: [], error: 'CNIPR 通道只处理中国申请号与公开(公告)号' })
  }
  return { queries, unsupported }
}

/**
 * 规划一次检索：把期望条数收敛到本通道能服务的范围，并换算成结果页数。
 * 页数由这里决定而不是由脚本自行判断，脚本只按给定的页数读取。
 * @param limit - 调用方期望的条数；缺省为 {@link CNIPR_SEARCH_PAGE_SIZE}。
 * @returns 归一后的条数（1..{@link CNIPR_SEARCH_MAX_HITS}）与要读取的页数。
 */
export function planCniprSearchRequest(limit?: number): CniprSearchRequest {
  const wanted = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : CNIPR_SEARCH_PAGE_SIZE
  const normalized = Math.min(wanted, CNIPR_SEARCH_MAX_HITS)
  return { limit: normalized, pages: Math.ceil(normalized / CNIPR_SEARCH_PAGE_SIZE) }
}

/**
 * 把页面的公开日归一为 `YYYY-MM-DD`：工具的两个检索通道共用同一字段语义，报告里的日期
 * 不该因来源不同而写法不同。
 * @param raw - 页面原样的日期。
 * @returns 归一后的日期；不是 `YYYY.MM.DD` / `YYYY-MM-DD` 形态时原样返回（不丢弃、不编造）。
 */
export function normalizeCniprDate(raw: string): string {
  const trimmed = raw.trim()
  const match = /^(\d{4})[./-](\d{2})[./-](\d{2})$/u.exec(trimmed)
  return match === null ? trimmed : `${group(match, 1)}-${group(match, 2)}-${group(match, 3)}`
}

/**
 * 解析结果页分类导航给出的总数。
 * @param header - `#slideselect` 的文本（如 `全部655件专利`）。
 * @returns 总数；文本不含该标记时为 null（页面结构变化，由通道 fail loud）。
 */
export function parseCniprSearchTotal(header: string): number | null {
  const match = SEARCH_TOTAL_PATTERN.exec(header.replace(/\s+/gu, ' '))
  return match === null ? null : Number(group(match, 1))
}

/**
 * 解析一条结果行的标签字段。结果行只有带标签的字段有稳定锚点，因此逐字段取；缺哪个字段
 * 就留空，不拿行内其它文本顶替。
 * @param text - 结果行的 innerText。
 * @returns 公开(公告)号、公开(公告)日、申请人与摘要的原文。
 */
function parseCniprSearchRowText(text: string): { publicationNumber: string; publicationDate: string; assignee: string; abstract: string } {
  return {
    publicationNumber: SEARCH_FIELD_PATTERNS.publicationNumber.exec(text)?.[1]?.trim() ?? '',
    publicationDate: SEARCH_FIELD_PATTERNS.publicationDate.exec(text)?.[1]?.trim() ?? '',
    assignee: SEARCH_FIELD_PATTERNS.assignee.exec(text)?.[1]?.trim() ?? '',
    abstract: SEARCH_FIELD_PATTERNS.abstract.exec(text)?.[1]?.trim() ?? '',
  }
}

/**
 * 把请求的号与脚本回报的条目按号对齐；脚本没有回报的号按缺失处理，不静默丢弃。
 * @param numbers - 本次实际请求的号，决定结果顺序。
 * @param reported - 脚本回报的条目。
 * @param missing - 构造「脚本未回报该号」条目的方法。
 * @returns 与请求号一一对应的结果。
 */
export function alignCniprResults<T extends { number: string }>(
  numbers: readonly string[],
  reported: readonly T[],
  missing: (number: string) => T,
): T[] {
  const byNumber = new Map(reported.map(item => [item.number, item]))
  return numbers.map(number => byNumber.get(number) ?? missing(number))
}

/** 脚本回传的法律状态条目：页面原文，记录由 {@link readCniprLegalPayload} 解析。 */
type LegalPayloadItem = {
  number?: unknown
  appNumber?: unknown
  resolvedFrom?: unknown
  text?: unknown
  error?: unknown
}

/** 脚本回传的直链条目：页内抓到的原样匹配。 */
type PdfLinksPayloadItem = {
  number?: unknown
  matches?: unknown
  isUnexamined?: unknown
  isAuthorized?: unknown
  error?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 取一个正则分组。匹配成功时分组的取值不会是 undefined，`?? ''` 只为
 * `noUncheckedIndexedAccess` 的静态类型存在。
 * @param match - 匹配结果。
 * @param index - 分组序号。
 * @returns 分组文本，静态类型要求下的 undefined 折叠为空串。
 */
function group(match: RegExpMatchArray, index: number): string {
  /* v8 ignore next -- 该组的模式在匹配成功时必然参与，取值不会是 undefined。 */
  return match[index] ?? ''
}

/**
 * 校验脚本回传的失败对象；未知分类与非对象取值都按 `page_state` 处理（脚本与包
 * 同版本发布，未知分类只可能来自脚本改了一半的运行，归入页面交互失败比放行更安全）。
 * @param value - 脚本回传的 error 字段。
 * @returns 规范化后的失败，或 undefined（该字段为 null/undefined）。
 */
export function readCniprScriptFailure(value: unknown): CniprScriptFailure | undefined {
  if (value === null || value === undefined) return undefined
  const record = asRecord(value)
  // 脚本回传的 error 不是对象也是畸形收据：按页面状态失败报出，不静默丢弃。
  if (record === undefined) {
    return { code: 'page_state', message: typeof value === 'string' ? value : '脚本回传的 error 不是对象' }
  }
  const message = asString(record.message) ?? ''
  const code = asString(record.code)
  const known: CniprScriptFailureCode = code === 'login_required' ? 'login_required' : 'page_state'
  return { code: known, message }
}

/**
 * 校验脚本回传的载荷骨架：逐条交给条目映射，条目映射返回 undefined 表示这条不进结果。
 * 三种能力共用同一份骨架，差别只在条目字段；被丢弃的条目单独计数，供调用方判断能否
 * 把结果当作完整结果（按号对齐的能力会自行把缺号报告成号码级失败，检索不会）。
 * @param payload - 脚本回传的载荷（未校验）。
 * @param readItem - 把一条条目记录映射成结果，或 undefined（缺号、非对象）。
 * @returns 每条的结果、被丢弃的条目数，以及脚本级失败（有失败时 items 仍可能带着已完成的条目）。
 */
function readCniprPayload<T>(
  payload: unknown,
  readItem: (record: Record<string, unknown>) => T | undefined,
): { items: T[]; dropped: number; failure?: CniprScriptFailure } {
  const root = asRecord(payload)
  if (root === undefined) {
    return { items: [], dropped: 0, failure: { code: 'page_state', message: 'CNIPR 脚本收据不是对象' } }
  }
  const failure = readCniprScriptFailure(root.error)
  const list = root.items
  if (!Array.isArray(list)) {
    // 收据骨架不合约定时按通道级失败处理；静默当空数组会把脚本故障伪装成号码级缺失。
    return {
      items: [],
      dropped: 0,
      failure: failure ?? { code: 'page_state', message: 'CNIPR 脚本收据缺少 items 数组' },
    }
  }
  const items: T[] = []
  let dropped = 0
  for (const entry of list) {
    const record = asRecord(entry)
    if (record === undefined) {
      dropped += 1
      continue
    }
    const item = readItem(record)
    if (item === undefined) {
      dropped += 1
      continue
    }
    items.push(item)
  }
  return { items, dropped, ...(failure === undefined ? {} : { failure }) }
}

/** 映射一条 PDF 直链条目；无号的条目丢弃。 */
function readPdfLinkItem(record: PdfLinksPayloadItem & Record<string, unknown>): CniprPdfLinkItem | undefined {
  const number = asString(record.number)
  if (number === undefined) return undefined
  const matches = Array.isArray(record.matches) ? record.matches.filter((m): m is string => typeof m === 'string') : []
  const error = asString(record.error)
  return {
    number,
    urls: normalizeCniprPdfUrls(matches),
    unexamined: record.isUnexamined === true,
    authorized: record.isAuthorized === true,
    ...(error === undefined ? {} : { error }),
  }
}

/** 映射一条法律状态条目：无号的丢弃，缺原文按零记录处理，缺申请号按无法查询报出。 */
function readLegalItem(record: LegalPayloadItem & Record<string, unknown>): CniprLegalStatusItem | undefined {
  const number = asString(record.number)
  if (number === undefined) return undefined
  const appNumber = asString(record.appNumber) ?? ''
  const resolvedFrom = asString(record.resolvedFrom)
  const error = asString(record.error) ?? (appNumber === '' ? `号 ${number} 未解析出申请号，无法查询法律状态` : undefined)
  if (error !== undefined) {
    return { number, appNumber, total: null, records: [], error, ...(resolvedFrom === undefined ? {} : { resolvedFrom }) }
  }
  const parsed = parseCniprLegalRecords(asString(record.text) ?? '')
  return {
    number,
    appNumber,
    total: parsed.total,
    records: parsed.records,
    ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
  }
}

/**
 * 校验并映射脚本回传的 PDF 直链载荷。
 * @param payload - 脚本回传的载荷（未校验）。
 * @returns 每条号的结果，以及脚本级失败（有失败时 items 仍可能带着已完成的条目）。
 */
export function readCniprPdfLinksPayload(payload: unknown): { items: CniprPdfLinkItem[]; failure?: CniprScriptFailure } {
  const { items, failure } = readCniprPayload(payload, readPdfLinkItem)
  return { items, ...(failure === undefined ? {} : { failure }) }
}

/**
 * 校验并映射脚本回传的法律状态载荷：脚本只回页面原文，记录在这里解析。
 * @param payload - 脚本回传的载荷（未校验）。
 * @returns 每条号的结果，以及脚本级失败。
 */
export function readCniprLegalPayload(payload: unknown): { items: CniprLegalStatusItem[]; failure?: CniprScriptFailure } {
  const { items, failure } = readCniprPayload(payload, readLegalItem)
  return { items, ...(failure === undefined ? {} : { failure }) }
}

/** 脚本回传的检索条目：公开号与标题是干净的属性，其余字段在行文本里。 */
type SearchPayloadItem = {
  number?: unknown
  title?: unknown
  text?: unknown
}

/** 映射一条检索条目：无公开号的丢弃（结果行必然发布该号，缺了说明行结构不完整）。 */
function readSearchItem(record: SearchPayloadItem & Record<string, unknown>): CniprSearchHit | undefined {
  const text = asString(record.text) ?? ''
  const fields = parseCniprSearchRowText(text)
  const patent = (asString(record.number) ?? fields.publicationNumber).trim()
  if (patent === '') return undefined
  return {
    patent,
    title: (asString(record.title) ?? '').replace(/\s+/gu, ' ').trim(),
    assignee: fields.assignee.replace(/\s+/gu, ' '),
    publicationDate: normalizeCniprDate(fields.publicationDate),
    abstract: fields.abstract.replace(/\s+/gu, ' '),
  }
}

/**
 * 校验并映射脚本回传的检索载荷：脚本回传结果行原文与分类导航文本，字段在这里解析。
 *
 * 检索结果不按请求号对齐，被丢弃的行不会像 PDF/法律状态那样变成号码级失败，因此
 * 这里单独回报丢弃数；通道据此把「行结构变化」报成通道级失败，而不是把残缺结果
 * 当作完整命中集返回。
 * @param payload - 脚本回传的载荷（未校验）。
 * @returns 总数（分类导航缺失该标记时为 null）、命中、被丢弃的行数，以及脚本级失败。
 */
export function readCniprSearchPayload(payload: unknown): {
  total: number | null
  hits: CniprSearchHit[]
  dropped: number
  failure?: CniprScriptFailure
} {
  const read = readCniprPayload(payload, readSearchItem)
  const root = asRecord(payload)
  const header = root === undefined ? undefined : asString(root.header)
  const total = header === undefined ? null : parseCniprSearchTotal(header)
  return {
    total,
    hits: read.items,
    dropped: read.dropped,
    ...(read.failure === undefined ? {} : { failure: read.failure }),
  }
}
