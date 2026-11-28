/**
 * Probe plugin mounted inside the patent overlay's isolate group.
 *
 * It records, per seam service, whether this realm ever published it. Each
 * service is injected on its own rather than as one dependency list: a list
 * stays pending until every member exists, which would hide which one is
 * missing. `patent-mount-driver.ts` imports the same module, waits for the
 * recorded observations to settle, and prints them.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Service names the patent overlay publishes inside its isolate group. */
export const PROBED_SERVICES = [
  'patentData',
  'patentKnowledge',
  'patentWorkflow',
  'patentTeams',
  'patentRuleGate',
  'writingPatterns',
] as const

/** Filled by {@link apply}; read by the driver after boot. */
export const mountObservation: {
  readonly services: Record<string, boolean>
  settled: boolean
} = { services: {}, settled: false }

export const name = 'patent-mount-probe'

/**
 * Subscribe to each probed service independently and record its arrival.
 * @param ctx - the probe's own context inside the patent isolate group.
 */
export function apply(ctx: Context): void {
  for (const service of PROBED_SERVICES) {
    ctx.inject([service], (scoped) => {
      mountObservation.services[service] = scoped.get(service) !== undefined
      if (Object.keys(mountObservation.services).length === PROBED_SERVICES.length) {
        mountObservation.settled = true
      }
    })
  }
}
