/**
 * PatSnap 兜底解析器：把 `patent_pdf_download` 首次下载失败的篇目换成 PatSnap 的
 * PDF 直链。
 *
 * 这里只做「查链接」：下载与 PDF 校验由工具复用同一套逻辑。通道不可用（缺 Key、
 * 鉴权、余额、限流）原样抛给工具，由工具记进 `warnings` 并保留首次失败；逐号失败
 * 变成带原因的 {@link FallbackLink}，不中断同批其余号。
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-pdf-download-fallback
 */

import type { PatsnapChannel } from '@deepseek-ai/dsh-patent-data'
import { PATSNAP_CHANNEL } from './internal/upstream-channel.ts'
import type { FallbackLink, FallbackRequest, ResolveFallback } from './patent-pdf-download.ts'

/** The PatSnap surface the resolver reads; `PatsnapChannel` satisfies it. */
export type PatsnapChannelSeam = Pick<PatsnapChannel, 'pdfLinks'>

/**
 * Late-bound patent-data lookup exposing the PatSnap channel factory. Production
 * passes `() => ctx.get('patentData')`; the same activation-order reason as the
 * Google runner applies.
 */
export type PatsnapLookup = () => { createPatsnapChannel: () => PatsnapChannelSeam | undefined } | undefined

/**
 * Build the fallback resolver over a late-bound lookup.
 * @param lookup - late-bound patent-data lookup.
 * @returns a resolver that maps failed patents to PatSnap PDF links.
 */
export function createPatsnapFallbackResolver(lookup: PatsnapLookup): ResolveFallback {
  return async (requests: readonly FallbackRequest[], options): Promise<readonly FallbackLink[]> => {
    const channel = lookup()?.createPatsnapChannel()
    if (channel === undefined) return []
    const result = await channel.pdfLinks(requests.map(request => request.patent), options)
    const byNumber = new Map(result.items.map(item => [item.number, item]))
    return requests.map((request): FallbackLink => {
      const item = byNumber.get(request.patent)
      if (item === undefined) {
        return { patent: request.patent, channel: PATSNAP_CHANNEL, error: 'PatSnap 未返回该号' }
      }
      if (item.pdfUrl === undefined) {
        return { patent: request.patent, channel: PATSNAP_CHANNEL, error: item.error ?? 'PatSnap 没有该号的 PDF' }
      }
      return {
        patent: request.patent,
        channel: PATSNAP_CHANNEL,
        pdfUrl: item.pdfUrl,
        ...(item.resolvedNumber === undefined ? {} : { resolvedNumber: item.resolvedNumber }),
      }
    })
  }
}
