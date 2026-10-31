import type { BrowserFrameState } from './BrowserFrame.ts'
import type { BrowserAddressFailure, BrowserTarget } from './url.ts'

/** Live tab state; navigation comes from its provider and draft validation stays local. */
export interface BrowserControllerState {
  readonly frame: BrowserFrameState
  /** Saved address offered for explicit restoration before any page has been requested. */
  readonly restoreTarget: BrowserTarget | undefined
  readonly addressFailure: BrowserAddressFailure | undefined
  readonly addressRevision: number
}
