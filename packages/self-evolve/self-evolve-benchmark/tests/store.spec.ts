import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BenchmarkId, CaseId } from '../src/brand.ts'
import {
  CONFIG_FILENAME,
  RUBRIC_FILENAME,
  STATEMENT_FILENAME,
  assertSafeId,
  benchmarkConfigPath,
  benchmarkDir,
  benchmarkRoot,
  caseDir,
  ensureBenchmark,
  listCaseIds,
  loadBenchmark,
  readBenchmarkConfig,
  rubricPath,
  statementPath,
  writeCase,
} from '../src/store.ts'

describe('benchmark store path helpers', () => {
  it('builds paths under the benchmarks root', () => {
    const base = '/root'
    expect(benchmarkRoot(base)).toBe(join(base, 'benchmarks'))
    expect(benchmarkDir(base, BenchmarkId('b'))).toBe(join(base, 'benchmarks', 'b'))
    expect(caseDir(base, BenchmarkId('b'), CaseId('c'))).toBe(join(base, 'benchmarks', 'b', 'c'))
    expect(statementPath(base, BenchmarkId('b'), CaseId('c'))).toBe(join(base, 'benchmarks', 'b', 'c', STATEMENT_FILENAME))
    expect(rubricPath(base, BenchmarkId('b'), CaseId('c'))).toBe(join(base, 'benchmarks', 'b', 'c', RUBRIC_FILENAME))
    expect(benchmarkConfigPath(base, BenchmarkId('b'))).toBe(join(base, 'benchmarks', 'b', CONFIG_FILENAME))
  })
})

describe('benchmark store persistence', () => {
  let dir: string
  let benchmarkId: BenchmarkId

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-store-'))
    benchmarkId = BenchmarkId('summarizer')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('ensures a benchmark directory and its title document', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: 'Summarizer', optimizable: true })
    const config = await readFile(benchmarkConfigPath(dir, benchmarkId), 'utf8')
    expect(config).toContain('Summarizer')
  })

  it('defaults a missing title document to the benchmark id', async () => {
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: benchmarkId, optimizable: true })
    await mkdir(benchmarkDir(dir, benchmarkId), { recursive: true })
    await writeFile(benchmarkConfigPath(dir, benchmarkId), 'null', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: benchmarkId, optimizable: true })
  })

  it('fails loud when the title document cannot be read for a non-missing reason', async () => {
    await writeFile(join(dir, 'benchmarks'), 'not a directory', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).rejects.toThrow()
  })

  it('falls back to the benchmark id when the title is not a string', async () => {
    await mkdir(benchmarkDir(dir, benchmarkId), { recursive: true })
    await writeFile(benchmarkConfigPath(dir, benchmarkId), 'title: 123', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: benchmarkId, optimizable: true })
  })

  it('reads an explicit optimizable: false and defaults the flag to true', async () => {
    await mkdir(benchmarkDir(dir, benchmarkId), { recursive: true })
    await writeFile(benchmarkConfigPath(dir, benchmarkId), 'title: Held out\noptimizable: false\n', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: 'Held out', optimizable: false })
    await writeFile(benchmarkConfigPath(dir, benchmarkId), 'title: Dev\noptimizable: true\n', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).resolves.toEqual({ title: 'Dev', optimizable: true })
  })

  it('fails loud on a non-boolean optimizable rather than silently optimizing a held-out benchmark', async () => {
    await mkdir(benchmarkDir(dir, benchmarkId), { recursive: true })
    await writeFile(benchmarkConfigPath(dir, benchmarkId), 'optimizable: no\n', 'utf8')
    await expect(readBenchmarkConfig(dir, benchmarkId)).rejects.toThrow(/non-boolean optimizable/)
  })

  it('writes a case statement with and without a rubric', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    await writeCase(dir, benchmarkId, CaseId('c1'), { statement: 'Task one', rubric: 'Rubric one' })
    await writeCase(dir, benchmarkId, CaseId('c2'), { statement: 'Task two' })

    const loaded = await loadBenchmark(dir, benchmarkId)
    expect(loaded.id).toBe(benchmarkId)
    expect(loaded.title).toBe('Summarizer')
    expect(loaded.cases).toEqual([
      { caseId: 'c1', statement: 'Task one', rubric: 'Rubric one' },
      { caseId: 'c2', statement: 'Task two' },
    ])
  })

  it('lists case directories in lexical order, ignoring files', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    await writeCase(dir, benchmarkId, CaseId('b'), { statement: 'B' })
    await writeCase(dir, benchmarkId, CaseId('a'), { statement: 'A' })
    await writeFile(join(benchmarkDir(dir, benchmarkId), 'README'), 'not a case', 'utf8')
    await expect(listCaseIds(dir, benchmarkId)).resolves.toEqual(['a', 'b'])
  })

  it('lists no cases for a missing benchmark directory', async () => {
    await expect(listCaseIds(dir, benchmarkId)).resolves.toEqual([])
  })

  it('fails loud when the benchmark directory cannot be listed for a non-missing reason', async () => {
    await writeFile(join(dir, 'benchmarks'), 'not a directory', 'utf8')
    await expect(listCaseIds(dir, benchmarkId)).rejects.toThrow()
  })

  it('fails loud on a benchmark with no cases', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Empty')
    await expect(loadBenchmark(dir, benchmarkId)).rejects.toThrow(/has no cases/)
  })

  it('fails loud when a case directory lacks its statement file', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Broken')
    await mkdir(caseDir(dir, benchmarkId, CaseId('c1')), { recursive: true })
    await expect(loadBenchmark(dir, benchmarkId)).rejects.toThrow()
  })

  it('fails loud when a rubric cannot be read for a non-missing reason', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Broken rubric')
    await writeCase(dir, benchmarkId, CaseId('c1'), { statement: 'Task one' })
    await mkdir(rubricPath(dir, benchmarkId, CaseId('c1')), { recursive: true })
    await expect(loadBenchmark(dir, benchmarkId)).rejects.toThrow()
  })

  it('rejects on-disk ids that are not safe single path segments', async () => {
    await ensureBenchmark(dir, benchmarkId, 'Traversal')
    await mkdir(caseDir(dir, benchmarkId, CaseId('c1')), { recursive: true })
    await writeFile(statementPath(dir, benchmarkId, CaseId('c1')), 'Task one', 'utf8')
    // A case directory named `..` would address the parent of the benchmark.
    await mkdir(join(benchmarkDir(dir, benchmarkId), '..name'), { recursive: true })
    await writeFile(join(benchmarkDir(dir, benchmarkId), '..name', STATEMENT_FILENAME), 'x', 'utf8')

    expect(() => { assertSafeId('c1', 'caseId') }).not.toThrow()
    expect(() => { assertSafeId('a.b-c_1', 'caseId') }).not.toThrow()
    expect(() => { assertSafeId('..', 'caseId') }).toThrow(/unsafe caseId/)
    expect(() => { assertSafeId('.hidden', 'caseId') }).toThrow(/unsafe caseId/)
    expect(() => { assertSafeId('a/b', 'benchmarkId') }).toThrow(/unsafe benchmarkId/)
    await expect(listCaseIds(dir, benchmarkId)).rejects.toThrow(/unsafe caseId/)
    await expect(loadBenchmark(dir, BenchmarkId('../etc'))).rejects.toThrow(/unsafe benchmarkId/)
  })
})
