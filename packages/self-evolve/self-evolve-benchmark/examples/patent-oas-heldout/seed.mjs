#!/usr/bin/env node
/**
 * Seed the `patent-oas-heldout` benchmark into a benchmark store data root.
 *
 * Writes the store layout documented in the package README:
 *
 *   <baseDir>/benchmarks/patent-oas-heldout/
 *   ├── benchmark_config.yaml        # { title, optimizable: false } — copied verbatim
 *   ├── heldout-oa-answer/statement|rubric (+ rounds/02/statement stays in the repo)
 *   └── heldout-claim-drafting/statement|rubric
 *
 * The config is copied, not regenerated, so the `optimizable: false` mark that
 * keeps the optimizer out survives seeding. No agent state is seeded here: the
 * held-out benchmark is measured against the same `patent-state` agent state
 * the dev benchmark (`patent-oas`) optimizes, which is what makes the
 * before/after readings comparable.
 *
 * Usage:
 *   node seed.mjs [baseDir]
 *
 * `baseDir` defaults to `~/.dsh/self-evolve-benchmark`, the provider default
 * for `$DSH_HOME`-aware `dshHomePath('self-evolve-benchmark')`. It is
 * idempotent: re-running overwrites case files in place.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exampleDir = dirname(fileURLToPath(import.meta.url))
const casesDir = join(exampleDir, 'cases')
const baseDir = process.argv[2] ?? join(homedir(), '.dsh', 'self-evolve-benchmark')
const benchmarkDir = join(baseDir, 'benchmarks', 'patent-oas-heldout')

await mkdir(benchmarkDir, { recursive: true })
await copyFile(join(exampleDir, 'benchmark_config.yaml'), join(benchmarkDir, 'benchmark_config.yaml'))

let caseCount = 0
for (const entry of await readdir(casesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const caseDir = join(benchmarkDir, entry.name)
  await mkdir(caseDir, { recursive: true })
  for (const file of ['statement', 'rubric']) {
    await copyFile(join(casesDir, entry.name, file), join(caseDir, file))
  }
  caseCount += 1
}

console.log(`Seeded ${caseCount} cases into ${benchmarkDir}`)
