#!/usr/bin/env node
/**
 * Boot the patent overlay over the shipped headless profile and print what the
 * in-realm probe observed.
 *
 * The probe plugin rides inside the overlay's isolate group, so its view is the
 * one a consumer of those services has: a service missing here is missing for
 * every patent consumer too, not merely from the root context. Tool names are
 * read from the root context because the tools registry is host-plane.
 */

import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { mountObservation, PROBED_SERVICES } from './patent-mount-probe.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('patent mount driver requires a config path')

/** Bound on waiting for every injected service to report; a miss is data, not a hang. */
const SETTLE_TIMEOUT_MS = 5_000
const SETTLE_POLL_MS = 25

const ctx = await bootProductionProfile({
  binName: 'patent-mount-probe',
  profile: 'headless',
  overlayPaths: [configPath],
  // The headless chain roots in the launcher's `cmdlineArgs`/`appExit`
  // (`headless-startup` injects them, `sandbox-policy` injects its service, and
  // the workspace root flows from there). This driver is the launcher.
  prepare: (launcher) => {
    launcher.provide('cmdlineArgs', { get: () => [] })
    launcher.provide('appExit', () => {})
  },
})

try {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (!mountObservation.settled && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS))
  }
  const tools = ctx.get('tools') as { restrictableNames(): ReadonlySet<string> } | undefined
  console.log(JSON.stringify({
    type: 'patent-mount-observation',
    services: mountObservation.services,
    awaiting: PROBED_SERVICES.filter(service => mountObservation.services[service] === undefined),
    hostServices: {
      subagents: ctx.get('subagents') !== undefined,
      tools: tools !== undefined,
      systemPrompt: ctx.get('systemPrompt') !== undefined,
    },
    tools: tools === undefined ? [] : [...tools.restrictableNames()].sort(),
  }))
} finally {
  await ctx.fiber.dispose()
}
