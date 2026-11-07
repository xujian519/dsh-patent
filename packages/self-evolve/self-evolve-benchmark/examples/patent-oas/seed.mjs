#!/usr/bin/env node
/**
 * Seed the `patent-oas` benchmark into a benchmark store data root.
 *
 * Writes the store layout documented in the package README:
 *
 *   <baseDir>/benchmarks/patent-oas/
 *   ├── benchmark_config.yaml        # { title }
 *   ├── oa-answer/statement|rubric
 *   ├── claim-drafting/statement|rubric
 *   ├── disclosure-drafting/statement|rubric
 *   ├── infringement-comparison/statement|rubric
 *   ├── invalidation-analysis/statement|rubric
 *   ├── novelty-creative/statement|rubric
 *   └── reexamination-request/statement|rubric
 *
 * and the initial agent state seed:
 *
 *   <baseDir>/patent-state/guidance.md   # model-visible work specification
 *
 * Each case is a directory under `cases/` holding two plain-text files:
 * `statement` (public task text) and `rubric` (private scoring standard).
 * This script copies them verbatim, preserving the physical separation the
 * engine's C2 guard relies on.
 *
 * Usage:
 *   node seed.mjs [baseDir]
 *
 * `baseDir` defaults to `~/.dsh/self-evolve-benchmark`, the provider default
 * for `$DSH_HOME`-aware `dshHomePath('self-evolve-benchmark')`. It is
 * idempotent: re-running overwrites case files in place.
 */

import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const casesDir = join(dirname(fileURLToPath(import.meta.url)), 'cases')
const baseDir = process.argv[2] ?? join(homedir(), '.dsh', 'self-evolve-benchmark')
const benchmarkDir = join(baseDir, 'benchmarks', 'patent-oas')

await mkdir(benchmarkDir, { recursive: true })
await writeFile(
  join(benchmarkDir, 'benchmark_config.yaml'),
  'title: 专利 OA 与撰写实务基准(patent-oas)\n',
)

// Seed the initial agent state: the model-visible work specification that
// executors follow and the optimize loop edits. The agent state lives under
// the data root, never the caller's working directory.
const patentStateDir = join(baseDir, 'patent-state')
await mkdir(patentStateDir, { recursive: true })
await copyFile(join(dirname(casesDir), 'patent-state', 'guidance.md'), join(patentStateDir, 'guidance.md'))

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
