import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { BrowserControllerState } from './controller.ts'
import type { BrowserTabState } from './BrowserPersistence.ts'
import type { BrowserStore } from './store.ts'

/** Values available once a Sidebar body has committed its content container. */
export interface BrowserMountRequest {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly viewportId: string
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly initialUrl: string | undefined
  readonly openTab: (url: string) => void
}

/** Plain Slot callbacks and a framework-bound state source, not a desktop protocol. */
export interface BrowserInjected {
  readonly keyedHooks: {
    readonly browserState: (key: string) => HostObservable<BrowserControllerState> | undefined
  }
  /** @param request - committed tab and container. @returns ends physical attachment without closing the tab. */
  mount(request: BrowserMountRequest): () => void
  /** @returns after every page has been disposed. */
  dispose(): Promise<void>
  /** @param actions - writer from a recreated Session binding. */
  rebind(actions: BoundActions<BrowserStore>): void
  /** @param tabId - owning tab. @param value - address input. */
  loadUrl(tabId: TabId, value: string): void
  /** @param tabId - tab whose saved address the user requested to restore. */
  restore(tabId: TabId): void
  /** @param tabId - owning tab. */
  goBack(tabId: TabId): void
  /** @param tabId - owning tab. */
  goForward(tabId: TabId): void
  /** Restore a saved address or reload its page. @param tabId - owning tab. */
  reload(tabId: TabId): void
  /** @param tabId - owning tab. @param enabled - provider's optional sandbox control. */
  setSandbox(tabId: TabId, enabled: boolean): void
}
