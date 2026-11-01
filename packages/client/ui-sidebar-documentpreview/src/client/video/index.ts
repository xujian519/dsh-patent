/** Builtin video metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DocumentPreviewDefinition } from '../contract/registry.ts'
import { VideoBody } from './VideoBody.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

/** Video implementation identity, shared by metadata and the keyed slot. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/** Video container suffixes served by the builtin body. */
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'] as const

/**
 * Describe the builtin video renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for renderer-owned video loading.
 */
export function videoBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: VIDEO_BODY_ID,
    extensions: VIDEO_EXTENSIONS,
    binaryExtensions: VIDEO_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'renderer',
    wrap: false,
  }
}

/**
 * Register the video dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarVideo')
  ctx.effect(() => ctx.locale.register('sidebarVideo', { zh, en, ja, es, fr, de, ru, pt }), 'document-video: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(videoBodyDefinition(() => t('title'))), 'document-video: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarVideo',
  }, VideoBody)), 'document-video: body')
}
