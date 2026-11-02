/** Host half: embeds the studio's browser preview limits in served pages. */
/* jscpd:ignore-start -- the Host config adapter matches the sibling document-preview plugin's */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Embed validated studio preview settings in browser pages.
 * @param ctx - Host context serving browser pages.
 * @param config - Preview limits adopted when the page loads.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_DOCUMENT_STUDIO_CONFIG__', value: config })
  })
}
/* jscpd:ignore-end */
