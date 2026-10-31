import type { BrowserTarget } from './url.ts'

/** The presentation face is separate from page navigation and terminal disposal. */
export interface BrowserPresentation {
  /**
   * Attach the page inside a committed content container.
   * @param viewportId - content element id; its DOM ancestors must remain connected for page retention.
   * @returns ends physical attachment, without disposing the navigation model; a later mount may reload the page.
   */
  mount(viewportId: string): () => void
}

/** One prepared iframe document; the provider reports its revision back on load or failure. */
export interface IframeDocument {
  readonly target: BrowserTarget
  readonly revision: number
  readonly sandboxed: boolean
}

/** Iframe presentation face used by the navigation provider, without owning the DOM container. */
export interface IframePagePresentation {
  /** Retain the prepared document and render it when a container is mounted. @param value - prepared document and event generation. */
  show(value: IframeDocument): void
  /** Remove the owned DOM and retained presentation data. */
  dispose(): void
}
