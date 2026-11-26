/**
 * Late-bound download channel for `patent_pdf_download`.
 *
 * Two channel legs run in front of the browser-free scrape: the CNIPR channel serves
 * China publication numbers when the deployment enabled it (`@deepseek-ai/dsh-patent-data`
 * resolves that from its own Config), and every number it does not serve goes to the
 * Google Patents leg. The ego channel comes from `ctx.patentData`, whose plugin declares
 * `inject: ['subprocess']` and therefore activates one dependency hop after a consumer
 * that only injects `['tools']` — the shipped preset row order. Reading the service during
 * `apply()` loses it in every such composition, so {@link createDownloadChannelRunner}
 * resolves it per call and the Google leg falls back to a browser-free page scrape that
 * yields the CDN URL for the tool's own fetch fallback. The scrape channel relies on the
 * scrape's own request timeout: the LRU-cached scrape seam accepts neither a per-call
 * timeout nor an abort signal.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-pdf-download-channel
 */

import { scrapePatent as scrapePatentImpl } from '@deepseek-ai/nuo-patent'
import type { ScrapeResult } from '@deepseek-ai/nuo-patent'
import { DEFAULT_EGO_TIMEOUT_MS, cachedScrapePatent, classifyCniprNumber } from '@deepseek-ai/dsh-patent-data'
import type { CniprChannel } from '@deepseek-ai/dsh-patent-data'
import { PatentToolError } from '../error.ts'
import { CNIPR_CHANNEL, GOOGLE_PATENTS_CHANNEL } from './internal/upstream-channel.ts'
import type { EgoDownloadItem, EgoDownloadRequest, EgoDownloadResult, RunEgo } from './patent-pdf-download.ts'
import { createEgoDownloadRunner } from './patent-pdf-download-ego.ts'
import type { EgoSessionSeam } from './patent-pdf-download-ego.ts'

/**
 * The patent-data surface this channel reads: the ego session for the Google leg
 * and the optional CNIPR channel. `PatentData` satisfies it structurally, and a
 * test injects a stand-in with the same two factories.
 */
export type PatentDataSeam = {
  /** Build the ego-browser session the Google leg runs its script over. */
  createEgoSession: () => EgoSessionSeam
  /** The CNIPR channel, or undefined while the deployment leaves `cniprEnabled` off. */
  createCniprChannel: () => Pick<CniprChannel, 'pdfLinks'> | undefined
}

/**
 * Late-bound lookup for the patent-data service. Production passes
 * `() => ctx.get('patentData')`; a lookup that captures the service during
 * `apply()` freezes whatever the sibling row had published by then.
 * @returns the service surface, or undefined while it is not mounted in the caller's scope.
 */
export type PatentDataLookup = () => PatentDataSeam | undefined

/** Page-scrape seam for the browser-free channel (production: the LRU-cached nuo scrape). */
export type PatentScrape = (
  patent: string,
  options?: { returnAbstract?: boolean; returnLegal?: boolean },
) => Promise<ScrapeResult>

/** Injected dependencies of the browser-free channel. */
export type DownloadChannelDeps = {
  /** Scrape implementation; defaults to the LRU-cached nuo scrape. */
  scrape?: PatentScrape
}

/**
 * Build the browser-free channel: scrape each patent page for its CDN PDF link
 * and report it as a `fallback` item, which the tool's fetch fallback downloads.
 * Used when the ego service is absent and when its browser is unusable.
 * @param deps - optional scrape injection.
 * @returns a batch runner producing one `fallback` item per patent.
 */
export function createScrapeChannelRunner(deps: DownloadChannelDeps = {}): RunEgo {
  const cached = cachedScrapePatent(scrapePatentImpl)
  const scrape: PatentScrape = deps.scrape ?? (async (patent, options) => (await cached(patent, options)).value)
  return async (request: EgoDownloadRequest): Promise<EgoDownloadResult> => {
    const items = await Promise.all(request.patents.map(async (patent): Promise<EgoDownloadItem> => {
      const result = await scrape(patent, { returnAbstract: false, returnLegal: false })
      const pdfUrl = result.data?.pdf_url
      if (result.success && typeof pdfUrl === 'string' && pdfUrl.length > 0) {
        return { patent, status: 'fallback', pdfUrl, channel: GOOGLE_PATENTS_CHANNEL }
      }
      return {
        patent,
        status: 'fallback',
        channel: GOOGLE_PATENTS_CHANNEL,
        error: result.errorMessage || `未在页面中找到 CDN PDF 链接：${patent}`,
      }
    }))
    return { items }
  }
}

/**
 * CNIPR 段在整个调用预算里能占的份额：按中国号占整批的比例分，并给一个下限。
 *
 * CNIPR 段失败时其余号仍要交给 Google 腿，因此不能让它吃掉整批预算；下限取 ego 会话的
 * 默认期限（脚本自己要等首页渲染与登录态，冷启动也在这一段里）。两腿各自拿到的都是
 * 「这一腿最多用多久」，不是整批墙钟上限——最坏情形是两腿各用满各自的预算。
 * @param timeoutMs - 本次调用的整批预算。
 * @param cnNumbers - 交给 CNIPR 段的数量。
 * @param total - 本次调用请求的总篇数。
 * @returns CNIPR 段的期限（毫秒）。
 */
function cniprBudgetMs(timeoutMs: number, cnNumbers: number, total: number): number {
  return Math.max(DEFAULT_EGO_TIMEOUT_MS, Math.floor(timeoutMs * cnNumbers / total))
}

/**
 * Build the `patent_pdf_download` batch runner over a late-bound patent-data lookup:
 * China publication numbers first go to the CNIPR channel when the deployment enabled
 * it, and every remaining number goes to the Google Patents leg (browser, then the
 * browser-free scrape when the browser is unusable). A CNIPR number it cannot serve is
 * reported in `warnings`, never dropped: a silently skipped channel reads as "this
 * deployment does not need it".
 * @param lookup - late-bound patent-data lookup (production: `() => ctx.get('patentData')`).
 * @param deps - optional scrape injection for the browser-free channel.
 * @returns the batch runner to inject into the tool.
 */
export function createDownloadChannelRunner(
  lookup: PatentDataLookup,
  deps: DownloadChannelDeps = {},
): RunEgo {
  const scrapeRunner = createScrapeChannelRunner(deps)
  const googleChannel = async (patentData: PatentDataSeam | undefined, request: EgoDownloadRequest): Promise<EgoDownloadResult> => {
    if (patentData === undefined) return scrapeRunner(request)
    try {
      return await createEgoDownloadRunner(patentData.createEgoSession())(request)
    } catch (error) {
      // 浏览器不可用（未安装 ego lite / 首次引导未完成）属可预期环境差异：退回无浏览器通道，
      // 其余错误（超时、脚本失败）保持 fail-loud，避免把真实故障伪装成降级成功。
      if (error instanceof PatentToolError && error.code === 'setup_required') return scrapeRunner(request)
      throw error
    }
  }
  return async (request: EgoDownloadRequest): Promise<EgoDownloadResult> => {
    const patentData = lookup()
    const warnings: string[] = []
    const items: EgoDownloadItem[] = []
    const served = new Set<string>()
    const cnipr: Pick<CniprChannel, 'pdfLinks'> | undefined = patentData?.createCniprChannel()
    const cnNumbers = cnipr === undefined
      ? []
      : request.patents.filter(patent => classifyCniprNumber(patent) === 'pub')
    if (cnipr !== undefined && cnNumbers.length > 0) {
      try {
        const links = await cnipr.pdfLinks(cnNumbers, {
          timeoutMs: cniprBudgetMs(request.timeoutMs, cnNumbers.length, request.patents.length),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        for (const link of links) {
          const url = link.urls[0]
          if (url === undefined) {
            warnings.push(`CNIPR 通道未取到 ${link.number} 的全文直链（${link.error ?? '无直链'}），该篇改走 ${GOOGLE_PATENTS_CHANNEL}`)
            continue
          }
          items.push({ patent: link.number, status: 'fallback', pdfUrl: url, channel: CNIPR_CHANNEL })
          served.add(link.number)
        }
      } catch (error) {
        // 通道级失败（未登录、ego 缺失、站点变化）不是整批失败：这些号改走 Google 腿，
        // 但失败必须进 warnings——否则「通道不可用」会被读成「不需要这条通道」。
        const detail = error instanceof Error ? error.message : String(error)
        warnings.push(`CNIPR 通道不可用（${detail}），${cnNumbers.length} 篇改走 ${GOOGLE_PATENTS_CHANNEL}`)
      }
    }
    const remaining = request.patents.filter(patent => !served.has(patent))
    if (remaining.length === 0) return { items, warnings }
    const rest = await googleChannel(patentData, { ...request, patents: remaining })
    return {
      items: [...items, ...rest.items],
      warnings: [...warnings, ...(rest.warnings ?? [])],
      ...(rest.recorded === undefined ? {} : { recorded: rest.recorded }),
    }
  }
}
