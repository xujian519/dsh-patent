/**
 * TRIZ data access: loads the shipped 39x39 contradiction matrix and the 40
 * inventive principles, and exposes the 39 engineering-parameter labels used
 * for deterministic cell lookup.
 *
 * The JSON assets ship at the package root (assets/) and resolve relative to
 * this module via import.meta.url, so both source (src/data.ts) and built
 * (lib/index.js) execution find them without a build-time copy step.
 * @module @deepseek-ai/dsh-methodology/data
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TrizPrinciple, TrizParameter, TrizSeparation } from './types.ts'

const MATRIX_URL = new URL('../assets/triz-matrix.json', import.meta.url)
const PRINCIPLES_URL = new URL('../assets/triz-principles.json', import.meta.url)
const SEPARATIONS_URL = new URL('../assets/triz-separations.json', import.meta.url)

/**
 * Load and memoize a shipped JSON asset resolved relative to this module.
 * @param url - the asset URL resolved relative to import.meta.url.
 * @param cache - the memoization slot holding the parsed value.
 * @returns the parsed JSON value.
 */
function loadJsonAsset<T>(url: URL, cache: { current: T | null }): T {
  const cached = cache.current
  if (cached !== null) return cached
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T
  cache.current = parsed
  return parsed
}

const matrixCache: { current: number[][][] | null } = { current: null }

/**
 * Load the 39x39 contradiction matrix, indexed [worsening-1][improving-1].
 * @returns the full matrix of recommended principle numbers.
 */
export function loadMatrix(): number[][][] {
  return loadJsonAsset(MATRIX_URL, matrixCache)
}

/**
 * Deterministic cell lookup: improving parameter x worsening parameter.
 * @param paramImproving - improving engineering parameter number, 1-39.
 * @param paramWorsening - worsening engineering parameter number, 1-39.
 * @returns recommended inventive principle numbers for that cell, in source
 * order and deduplicated (empty both on the diagonal, a physical contradiction
 * with no classical entry, and in the transcription's 234 empty off-diagonal
 * cells).
 */
export function lookupMatrixCell(paramImproving: number, paramWorsening: number): number[] {
  const row = loadMatrix()[paramWorsening - 1] ?? []
  return [...new Set(row[paramImproving - 1] ?? [])]
}

const principlesCache: { current: TrizPrinciple[] | null } = { current: null }

/**
 * Load the 40 inventive principles from the shipped asset.
 * @returns the principles in number order.
 */
export function loadPrinciples(): TrizPrinciple[] {
  return loadJsonAsset(PRINCIPLES_URL, principlesCache)
}

let principlesByIdCache: Map<number, TrizPrinciple> | null = null

/**
 * Resolve an inventive principle number to its full principle entry.
 * @param no - inventive principle number, 1-40.
 * @returns the principle, or undefined when the number is unknown.
 */
export function principleById(no: number): TrizPrinciple | undefined {
  if (principlesByIdCache === null) {
    principlesByIdCache = new Map(loadPrinciples().map(principle => [principle.no, principle]))
  }
  return principlesByIdCache.get(no)
}

const separationsCache: { current: TrizSeparation[] | null } = { current: null }

/**
 * Load the separation principles used to resolve physical contradictions.
 * @returns the separation principles in definition order.
 */
export function loadSeparations(): TrizSeparation[] {
  return loadJsonAsset(SEPARATIONS_URL, separationsCache)
}

/** The asset set validated at plugin start. */
export type TrizAssets = {
  matrix: number[][][]
  principles: TrizPrinciple[]
  separations: TrizSeparation[]
}

/** Runtime guard for a JSON object entry, whose static type hides malformed files. */
function isJsonObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/** Collect matrix dimension and cell violations. */
function collectMatrixViolations(matrix: number[][][], violations: string[]): void {
  if (!Array.isArray(matrix)) {
    violations.push('matrix is not an array')
    return
  }
  if (matrix.length !== 39) violations.push(`matrix has ${matrix.length} rows, expected 39`)
  for (const [worsening, row] of matrix.entries()) {
    if (!Array.isArray(row)) {
      violations.push(`matrix row ${worsening + 1} is not an array`)
      continue
    }
    if (row.length !== 39) violations.push(`matrix row ${worsening + 1} has ${row.length} columns, expected 39`)
    for (const [improving, cell] of row.entries()) {
      if (!Array.isArray(cell)) {
        violations.push(`matrix cell (${improving + 1}, ${worsening + 1}) is not an array`)
        continue
      }
      for (const principle of cell) {
        if (!Number.isInteger(principle) || principle < 1 || principle > 40) {
          violations.push(`matrix cell (${improving + 1}, ${worsening + 1}) holds ${String(principle)}, expected an integer 1-40`)
        }
      }
    }
  }
}

/** Collect principle count, identity, range, and text violations. */
function collectPrincipleViolations(principles: TrizPrinciple[], violations: string[]): void {
  if (!Array.isArray(principles)) {
    violations.push('principles is not an array')
    return
  }
  if (principles.length !== 40) violations.push(`principles has ${principles.length} entries, expected 40`)
  const seen = new Set<number>()
  for (const [index, principle] of principles.entries()) {
    if (!isJsonObject(principle)) {
      violations.push(`principle entry ${index + 1} is not an object`)
      continue
    }
    if (typeof principle.no !== 'number' || !Number.isInteger(principle.no) || principle.no < 1 || principle.no > 40) {
      violations.push(`principle ${String(principle.no)} is outside the integers 1-40`)
    }
    if (seen.has(principle.no)) violations.push(`principle ${principle.no} repeats`)
    seen.add(principle.no)
    if (typeof principle.name !== 'string' || principle.name.length === 0
      || typeof principle.description !== 'string' || principle.description.length === 0) {
      violations.push(`principle ${String(principle.no)} has an empty or missing name or description`)
    }
  }
  const missing = Array.from({ length: 40 }, (_, index) => index + 1).filter(no => !seen.has(no))
  if (missing.length > 0) violations.push(`principles is missing numbers ${missing.join(', ')}`)
}

/** Collect separation count, identity, text, and signal violations. */
function collectSeparationViolations(separations: TrizSeparation[], violations: string[]): void {
  if (!Array.isArray(separations)) {
    violations.push('separations is not an array')
    return
  }
  if (separations.length !== 5) violations.push(`separations has ${separations.length} entries, expected 5`)
  const ids = new Set<string>()
  for (const [index, separation] of separations.entries()) {
    if (!isJsonObject(separation)) {
      violations.push(`separation entry ${index + 1} is not an object`)
      continue
    }
    if (typeof separation.id !== 'string' || separation.id.length === 0
      || typeof separation.name !== 'string' || separation.name.length === 0
      || typeof separation.description !== 'string' || separation.description.length === 0) {
      violations.push(`separation entry ${index + 1} has an empty or missing id, name, or description`)
    }
    if (typeof separation.id === 'string') {
      if (ids.has(separation.id)) violations.push(`separation "${separation.id}" repeats`)
      ids.add(separation.id)
    }
    if (!Array.isArray(separation.signals) || separation.signals.length === 0) {
      violations.push(`separation "${separation.id}" has no signals`)
    } else {
      for (const [signalIndex, signal] of separation.signals.entries()) {
        if (typeof signal !== 'string' || signal.length === 0) {
          violations.push(`separation "${separation.id}" signal ${signalIndex + 1} is empty or not a string`)
        }
      }
    }
  }
}

/**
 * Validate the shipped TRIZ assets. The plugin calls this during apply() so a
 * missing or malformed asset fails at load instead of at the first tool call.
 * @param assets - the asset set; defaults to the shipped files.
 * @throws Error naming the package and every invalid asset.
 */
export function validateTrizAssets(assets: TrizAssets = {
  matrix: loadMatrix(),
  principles: loadPrinciples(),
  separations: loadSeparations(),
}): void {
  const violations: string[] = []
  collectMatrixViolations(assets.matrix, violations)
  collectPrincipleViolations(assets.principles, violations)
  collectSeparationViolations(assets.separations, violations)
  if (violations.length > 0) {
    throw new Error('@deepseek-ai/dsh-methodology: invalid TRIZ assets: ' + violations.join('; '))
  }
}

/**
 * The 39 classic engineering parameters (row/column names). label is the
 * human-facing display name; callers supply the parameter number explicitly.
 */
export const ENGINEERING_PARAMS: readonly TrizParameter[] = [
  { no: 1, label: '运动物体重量' },
  { no: 2, label: '静止物体重量' },
  { no: 3, label: '运动物体长度' },
  { no: 4, label: '静止物体长度' },
  { no: 5, label: '运动物体面积' },
  { no: 6, label: '静止物体面积' },
  { no: 7, label: '运动物体体积' },
  { no: 8, label: '静止物体体积' },
  { no: 9, label: '速度' },
  { no: 10, label: '力' },
  { no: 11, label: '应力' },
  { no: 12, label: '形状' },
  { no: 13, label: '结构稳定性' },
  { no: 14, label: '强度' },
  { no: 15, label: '运动物体作用时间' },
  { no: 16, label: '静止物体作用时间' },
  { no: 17, label: '温度' },
  { no: 18, label: '光照度' },
  { no: 19, label: '运动物体能量' },
  { no: 20, label: '静止物体能量' },
  { no: 21, label: '功率' },
  { no: 22, label: '能量损失' },
  { no: 23, label: '物质损失' },
  { no: 24, label: '信息损失' },
  { no: 25, label: '时间损失' },
  { no: 26, label: '物质数量' },
  { no: 27, label: '可靠性' },
  { no: 28, label: '测量精度' },
  { no: 29, label: '制造精度' },
  { no: 30, label: '作用于物体的有害因素' },
  { no: 31, label: '物体产生的有害因素' },
  { no: 32, label: '可制造性' },
  { no: 33, label: '可操作性' },
  { no: 34, label: '可维修性' },
  { no: 35, label: '适应性' },
  { no: 36, label: '装置复杂性' },
  { no: 37, label: '检测复杂性' },
  { no: 38, label: '自动化程度' },
  { no: 39, label: '生产率' },
]

/**
 * Resolve a parameter number to its human-facing label.
 * @param no - engineering parameter number, 1-39.
 * @returns the label, or the number as a string when unknown.
 */
export function paramLabel(no: number): string {
  const param = ENGINEERING_PARAMS.find(entry => entry.no === no)
  return param?.label ?? String(no)
}

/**
 * Render principle numbers as "N name" entries for prompt text.
 * @param ids - inventive principle numbers, 1-40.
 * @returns a comma-joined, ordered list.
 */
export function principleNames(ids: readonly number[]): string {
  return ids.map((id) => {
    const name = principleById(id)?.name ?? ''
    return `${id} ${name}`.trim()
  }).join(', ')
}
