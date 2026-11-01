/** Full-capture fetch observations sent to the Inspector Worker. */

/** One header entry; arrays retain duplicate header names. */
export type InspectorHeader = readonly [name: string, value: string]

/** One parsed Server-Sent Event independent of its CDP projection. */
export interface InspectorEventSourceMessage {
  readonly eventName: string
  readonly eventId: string
  readonly data: string
}
