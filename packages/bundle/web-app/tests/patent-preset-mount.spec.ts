/**
 * Mounts the sixteen patent rows the `patent` preset declares and asserts what
 * the composition published: the six seam services resolve from inside the
 * isolate realm, and each package's tools reached the host registry.
 *
 * `patent-preset.spec.ts` reads the preset declaration statically — it proves
 * the rows exist, name real packages, and share a realm. This spec answers the
 * next question, which static reading cannot: do those rows actually mount
 * together, and does a consumer inside the realm see the published services.
 *
 * The second case is the negative control: it disables one provider row and
 * requires the probe to report that service as missing, so a probe that
 * silently stopped observing cannot pass this suite.
 *
 * The delivery-gate denial path is not re-probed here; `patent-rule`'s own
 * suites exercise it through the executor.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/patent-mount-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/patent-mount.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

const MARKER = '{"type":"patent-mount-observation"'

/** Every service the patent overlay publishes inside its isolate group. */
const SEAM_SERVICES = [
  'patentData',
  'patentKnowledge',
  'patentWorkflow',
  'patentTeams',
  'patentRuleGate',
  'writingPatterns',
] as const

/** One representative tool per package the patent preset mounts. */
const REPRESENTATIVE_TOOLS: Readonly<Record<string, string>> = {
  'patent-tools (search)': 'patent_search',
  'patent-tools (claim chart)': 'claim_chart_build',
  'patent-tools (drafting)': 'draft_claims',
  'patent-tools (validation)': 'validate_specification',
  'patent-tools (review)': 'review_patent_application',
  'patent-tools (workflow)': 'patent_workflow_run',
  'patent-teams': 'patent_teams_create',
  'patent-document': 'render_patent_document',
  'patent-filing': 'build_patent_filing',
  'patent-deadline': 'patent_deadlines',
  'patent-fees': 'patent_fees',
  'patent-law': 'law_verify',
  methodology: 'triz',
  'tool-literature': 'paper_search',
  'writing-patterns': 'query_writing_patterns',
}

interface MountObservation {
  readonly services: Record<string, boolean>
  readonly awaiting: readonly string[]
  readonly tools: readonly string[]
}

/** Boot the overlay and return the in-realm probe's observation. */
async function observe(env: Record<string, string> = {}): Promise<MountObservation> {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'patent mount probe',
    tempDirPrefix: 'patent-mount-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: repoTsconfig,
    processTimeoutMs: LOADER_SMOKE_TEST_TIMEOUT_MS,
    env,
  })
  expect(stderr).not.toContain('UNHANDLED')
  const line = stdout.split('\n').findLast(candidate => candidate.startsWith(MARKER))
  if (line === undefined) throw new Error(`mount driver printed no observation line; stdout:\n${stdout}`)
  return JSON.parse(line) as MountObservation
}

describe('patent rows mount over the shipped headless profile', () => {
  it('resolves every seam service and registers each package\'s tools', async () => {
    const observation = await observe()

    // Provider and consumer share one realm: a service the probe could not
    // resolve from inside the group is one no patent consumer could resolve.
    expect(observation.services).toEqual(Object.fromEntries(SEAM_SERVICES.map(service => [service, true])))
    expect(observation.awaiting).toEqual([])

    const registered = new Set(observation.tools)
    const missing = Object.entries(REPRESENTATIVE_TOOLS)
      .filter(([, tool]) => !registered.has(tool))
      .map(([owner, tool]) => `${owner}: ${tool}`)
    expect(missing).toEqual([])

    // A duplicated registration would mean two mounts of one row.
    expect(registered.size).toBe(observation.tools.length)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('reports the one service whose provider row is disabled', async () => {
    const observation = await observe({ PATENT_MOUNT_DROP_TEAMS: '1' })

    expect(observation.services).toEqual({
      patentData: true,
      patentKnowledge: true,
      patentWorkflow: true,
      patentRuleGate: true,
      writingPatterns: true,
    })
    expect(observation.awaiting).toEqual(['patentTeams'])
    expect(observation.tools).not.toContain('patent_teams_create')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
