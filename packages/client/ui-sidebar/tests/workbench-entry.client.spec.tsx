// @vitest-environment jsdom
/**
 * The shell promotes the externally injected personal-workbench entry into the
 * top action group: the slot right after 「新会话」, with that button's class,
 * icon size and label class, and with the scheduled-task trigger hidden.
 */
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)
const t: SidebarRootComponentProps['t'] = key =>
  (en as Record<string, string>)[key] ?? (commonEn as Record<string, string>)[key] ?? key

afterEach(() => { cleanup() })

/** Mount the shell inside an app `#root`, the subtree the effect observes. */
function mountRootedShell({ appRoot = true }: { appRoot?: boolean } = {}) {
  let root: HTMLElement | undefined
  if (appRoot) {
    root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
  }
  const container = document.createElement('div')
  ;(root ?? document.body).append(container)
  let collapsed = false
  const shell = (): ReactNode => (
    <SidebarRoot
      drawer={false}
      collapsed={collapsed} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      useShortcuts={selector => selector([])}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} setPinned={() => {}} trackEntryClick={() => {}}
      usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)}
      useContextMenu={contextMenuHook()}
      useResource={useResource} useWorkspaces={neverHook}
      useRemoteAccess={() => true} useSessionAccess={neverHook} useWorkspaceAccess={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(shell(), { container })
  // The column paints the New Session capsule, the effect's promotion anchor.
  const anchor = (): HTMLButtonElement => {
    const found = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === t('session.new'))
    if (found === undefined) throw new Error('New Session capsule not rendered')
    return found
  }
  const column = (): HTMLElement => container.firstElementChild as HTMLElement
  return {
    root,
    container,
    anchor,
    column,
    collapse(): void {
      collapsed = true
      view.rerender(shell())
    },
    /** Inject the plugin's entry (and optionally its scheduled-task trigger). */
    injectEntry(markup = '<svg></svg><span class="wb-label">Workbench</span>'): HTMLButtonElement {
      const entry = document.createElement('button')
      entry.setAttribute('data-dsh-personal-workbench-entry', '')
      entry.innerHTML = markup
      column().prepend(entry)
      return entry
    },
    injectTimerTrigger(): HTMLButtonElement {
      const trigger = document.createElement('button')
      trigger.className = 'dshc-trigger'
      column().append(trigger)
      return trigger
    },
    dispose(): void { root?.remove() },
  }
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })

describe('personal-workbench entry promotion', () => {
  it('moves the injected entry after New Session and restyles it as a peer', async () => {
    const b = mountRootedShell()
    try {
      const trigger = b.injectTimerTrigger()
      const anchor = b.anchor()
      const entry = b.injectEntry()
      await act(async () => { await flush() })

      expect(trigger.style.display).toBe('none')
      expect(anchor.nextElementSibling).toBe(entry)
      expect(entry.className).toBe(anchor.className)
      expect(entry.querySelector('span')?.className).toBe(anchor.querySelector('span')?.className)
      const icon = entry.querySelector('svg')
      expect(icon?.style.width).toBe('14px')
      expect(icon?.style.height).toBe('14px')
      expect(icon?.style.flex).toBe('0 0 auto')

      // Idempotent: a later mutation leaves the promoted entry where it is.
      await act(async () => { b.column().append(document.createElement('i')) })
      await act(async () => { await flush() })
      expect(anchor.nextElementSibling).toBe(entry)
    } finally {
      b.dispose()
    }
  })

  it('re-promotes with the rail icon size when the column collapses', async () => {
    const b = mountRootedShell()
    try {
      const entry = b.injectEntry()
      await act(async () => { await flush() })
      expect(entry.querySelector('svg')?.style.width).toBe('14px')

      // The shell keeps the wide content until the slide settles (150ms), so the
      // collapse and the settle wait are separate act scopes: passive effects
      // (which schedule that timer) flush when the first one exits.
      await act(async () => { b.collapse() })
      await act(async () => {
        await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
        await flush()
      })
      expect(entry.querySelector('svg')?.style.width).toBe('18px')
    } finally {
      b.dispose()
    }
  })

  it('promotes a bare entry when the trigger, label and icon are absent', async () => {
    const b = mountRootedShell()
    try {
      const anchor = b.anchor()
      const entry = b.injectEntry('')
      await act(async () => { await flush() })

      expect(anchor.nextElementSibling).toBe(entry)
      expect(entry.className).toBe(anchor.className)
      expect(entry.querySelector('span')).toBeNull()
      expect(entry.querySelector('svg')).toBeNull()
    } finally {
      b.dispose()
    }
  })

  it('leaves the entry alone when the column carries no New Session anchor', async () => {
    const b = mountRootedShell()
    try {
      // The anchor is matched by the shell's own class; without it the effect
      // must leave the entry where the plugin put it and copy nothing.
      b.anchor().className = ''
      const entry = b.injectEntry()
      await act(async () => { await flush() })

      expect(entry.className).toBe('')
      expect(entry.parentElement).toBe(b.column())
    } finally {
      b.dispose()
    }
  })

  it('promotes nothing while the plugin entry is absent', async () => {
    const b = mountRootedShell()
    try {
      const trigger = b.injectTimerTrigger()
      await act(async () => { await flush() })
      // The early return owns the trigger's state: no entry, no hiding.
      expect(trigger.style.display).toBe('')
    } finally {
      b.dispose()
    }
  })

  it('promotes nothing without an app #root to observe', async () => {
    const b = mountRootedShell({ appRoot: false })
    try {
      const entry = b.injectEntry()
      await act(async () => { await flush() })
      expect(entry.className).toBe('')
    } finally {
      b.dispose()
    }
  })
})
