/** Register interactive terminal tabs with the sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { SidebarRightTabParamsMap, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { PluginArtworkTerminal } from '@deepseek-ai/dsh-client-ui-primitives'
import { TerminalGuide, type TerminalGuideInjected } from './TerminalGuide.tsx'
import { LazyTerminalBody } from './LazyTerminalBody.tsx'
import { TerminalTitle } from './TerminalTitle.tsx'
import type { TerminalBodyInjected, TerminalInjected } from './face.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

/** Services needed by the terminal's two sidebar seats. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'webTerminals', 'theme', 'shortcuts']

/**
 * Register the terminal type, observable views and sidebar tabs.
 * @param ctx - Client root Context with sidebar and terminal services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const sync = (): void => { ctx.webTerminals.retainTabs(ctx.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === 'terminal')) }
    const unsubscribe = ctx.sidebarRight.openTabs.subscribe(sync)
    sync()
    return () => { unsubscribe(); ctx.webTerminals.retainTabs([]) }
  }, 'ui-sidebar-terminal.window-holds')
  const target = (sessionId: SessionId, key: string): SidebarRightTabParamsMap['terminal'] | undefined =>
    ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().params
  const terminalId = (sessionId: SessionId, key: string): WebTerminalId | undefined => {
    const params = target(sessionId, key)
    return params !== undefined && 'terminalId' in params ? params.terminalId : undefined
  }
  const view = (sessionId: SessionId, key: string) => {
    const params = target(sessionId, key)
    const contentId = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().address
    return ctx.webTerminals.view(sessionId, key, contentId, terminalId(sessionId, key),
      params !== undefined && 'shellPath' in params ? params.shellPath : undefined)
  }
  const namespace = 'sidebarTerminal'
  const id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.shortcuts.register({
    id: 'terminal.new' as ShortcutCommandId, label: () => t('new'), aliases: ['new terminal', 'shell'],
    defaults: {
      'desktop:macos': { code: 'Backquote', modifiers: ['control'] },
      'desktop:windows': { code: 'Backquote', modifiers: ['control'] },
      'desktop:linux': { code: 'Backquote', modifiers: ['control'] },
      'web:macos': { code: 'Backquote', modifiers: ['control'] },
      'web:windows': { code: 'Backquote', modifiers: ['control'] },
    },
    regions: ['page', 'editable', 'terminal'], modals: [],
    resolve: ({ target: element }) => {
      const target = ctx.sidebarRight.commandTarget(element)
      if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
      return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('terminal', target) } }
    },
  }), 'ui-sidebar-terminal: shortcut')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-terminal.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'terminal', multiple: true, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'new', order: 20, title: () => t('new'), description: () => t('description'), icon: PluginArtworkTerminal }],
  }), 'ui-sidebar-terminal.type')
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('terminal', (sessionId, tab) => {
    ctx.webTerminals.close(sessionId, tab.id, tab.contentId, terminalId(sessionId, tab.id))
  }), 'ui-sidebar-terminal.close')
  const inject = (sessionId: SessionId): TerminalInjected => ({
    view: key => view(sessionId, key),
    keyedHooks: { terminal: key => view(sessionId, key).state },
  })
  const theme: TerminalBodyInjected['hooks']['theme'] = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: id, locale: namespace,
    inject: (sessionId): TerminalGuideInjected => ({
      hooks: { shortcuts: ctx.shortcuts.catalog },
      loadShells: signal => ctx.webTerminals.launchShells(sessionId, signal),
      selectShell: (path) => { ctx.webTerminals.selectShell(path) },
    }),
  }, TerminalGuide)), 'ui-sidebar-terminal.guide')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: id, locale: namespace,
      inject: (sessionId): TerminalBodyInjected => ({ ...inject(sessionId), hooks: { theme } }),
    }, LazyTerminalBody,
  )), 'ui-sidebar-terminal.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: id, locale: namespace, inject }, TerminalTitle,
  )), 'ui-sidebar-terminal.title')
}
