/**
 * src/patent/workflow — 声明式工作流 manifest 校验（轻量守卫，替代 zod）。
 *
 * 从 workflow.ts 拆出，供 graph/adapter（manifestToGraph）在移植 P3.1 的
 * runWorkflow 执行器之前独立消费：非法 manifest 即抛 WorkflowError（fail-fast）。
 */

import { WorkflowError, type WorkflowManifest, type WorkflowStage } from './types.ts'
import { parseConsumeRef } from './consume-ref.ts'

/**
 * Manifest 校验（轻量守卫，替代 zod）：非法即抛错。
 * options.atomNames 提供时，额外校验已声明 atom 均存在（fail-fast）。
 * @param manifest - 待校验的工作流 manifest。
 * @param options - 可选校验配置（atomNames 提供时校验 atom 均存在；
 *                  projections 提供时校验 consumes 的投影键都已注册；
 *                  guidelineRevision 提供时期望 manifest 声明同一版本）。
 */
export function validateWorkflowManifest(
  manifest: WorkflowManifest,
  options?: { atomNames?: ReadonlySet<string>; projections?: ReadonlySet<string>; guidelineRevision?: string },
): void {
  if (!manifest.id.trim()) throw new WorkflowError('manifest.id 不能为空')
  if (!manifest.name.trim()) throw new WorkflowError('manifest.name 不能为空')
  if (!manifest.caseType.trim()) throw new WorkflowError('manifest.caseType 不能为空')
  validateGuidelineRevision(manifest, options?.guidelineRevision)
  if (manifest.validation?.maxRetries !== undefined) {
    assertNonNegativeInteger(manifest.validation.maxRetries, `manifest ${manifest.id} 的 validation.maxRetries`)
  }
  if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
    throw new WorkflowError('manifest.stages 必须至少包含一个阶段')
  }
  const ids = new Set<string>()
  const indexById = new Map(manifest.stages.map((stage, index) => [stage.id, index]))
  /** 已扫描到的审批门下标；随主循环累积，避免对稀疏数组再做一次投影。 */
  const gateIndices: number[] = []
  let stageIndex = -1
  // 用迭代器而非 `.entries()`：稀疏阶段数组的防御测试通过迭代器暴露阶段，
  // 按索引读取会把空洞当成缺失阶段。
  for (const stage of manifest.stages) {
    stageIndex += 1
    if (stage.atom === 'approval-gate') gateIndices.push(stageIndex)
    if (!stage.id.trim()) throw new WorkflowError('stage.id 不能为空')
    // `#` 是 consumes 的投影分隔符：允许出现在阶段 id 里，索引就不会报「前序阶段不存在」，
    // 运行时按投影去取值反而出错，属于最难查的一类。
    if (stage.id.includes('#')) throw new WorkflowError(`stage.id 不能包含 "#"（与 consumes 投影语法冲突）: ${stage.id}`)
    if (ids.has(stage.id)) throw new WorkflowError(`重复的阶段 id: ${stage.id}`)
    ids.add(stage.id)
    if (!['chain', 'react', 'sub_agent'].includes(stage.strategy)) {
      throw new WorkflowError(`未知策略: ${stage.strategy}（阶段 ${stage.id}）`)
    }
    if (!stage.description.trim()) throw new WorkflowError(`阶段 ${stage.id} 缺少描述`)
    if (stage.atom !== undefined && !stage.atom.trim()) {
      throw new WorkflowError(`阶段 ${stage.id} 的 atom 不能为空字符串`)
    }
    if (stage.guidance !== undefined && !stage.guidance.trim()) {
      throw new WorkflowError(`阶段 ${stage.id} 的 guidance 不能为空字符串`)
    }
    if (stage.consumes !== undefined) {
      if (stage.consumes.length === 0) {
        throw new WorkflowError(`阶段 ${stage.id} 的 consumes 不能为空数组`)
      }
      // 去重按**上游阶段**判，不按条目字符串：`['s1', 's1#rows']` 是同一份产出取两遍，
      // 按字符串判会放过它，等于把同一段文本塞进提示词两次。
      const upstreamIds = new Set<string>()
      for (const entry of stage.consumes) {
        const { stageId: upstream, projection } = parseConsumeRef(entry)
        if (upstream === '') {
          throw new WorkflowError(`阶段 ${stage.id} 的 consumes 条目缺少阶段 id: ${entry}`)
        }
        if (projection !== undefined && projection.trim() === '') {
          throw new WorkflowError(`阶段 ${stage.id} 的 consumes 投影缺少投影名: ${entry}`)
        }
        if (upstreamIds.has(upstream)) {
          throw new WorkflowError(`阶段 ${stage.id} 的 consumes 有重复的阶段 id: ${upstream}`)
        }
        upstreamIds.add(upstream)
        // 只认此前已出现过的阶段：自身与后续阶段都还没有产出可拼入。
        if (upstream === stage.id || !ids.has(upstream)) {
          throw new WorkflowError(`阶段 ${stage.id} 的 consumes 引用了不存在或非前序的阶段: ${upstream}`)
        }
        if (projection !== undefined && options?.projections !== undefined && !options.projections.has(entry)) {
          throw new WorkflowError(`阶段 ${stage.id} 的 consumes 引用了未注册的投影: ${entry}`)
        }
      }
    }
    if (options?.atomNames && stage.atom !== undefined && !options.atomNames.has(stage.atom)) {
      throw new WorkflowError(`阶段 ${stage.id} 声明了未知 atom: ${stage.atom}`)
    }
    if (stage.retry !== undefined) {
      const hasTextTrigger = stage.retry.whenOutputMatches !== undefined
      const hasRevisionTrigger = stage.retry.whenRevisionRequested === true
      if (!hasTextTrigger && !hasRevisionTrigger) {
        throw new WorkflowError(
          `阶段 ${stage.id} 的 retry 必须声明 whenOutputMatches 或 whenRevisionRequested: true`,
        )
      }
      if (stage.retry.whenOutputMatches !== undefined) {
        if (stage.retry.whenOutputMatches.trim() === '') {
          throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 不能为空`)
        }
        try {
          new RegExp(stage.retry.whenOutputMatches, 'i')
        } catch {
          throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 非法正则`)
        }
      }
      if (stage.retry.rewindTo !== undefined) {
        assertRewindTarget(stage, 'retry.rewindTo', stage.retry.rewindTo, ids, indexById, gateIndices, stageIndex, manifest)
      }
      if (stage.retry.routes !== undefined) {
        if (stage.retry.whenRevisionRequested !== true) {
          throw new WorkflowError(`阶段 ${stage.id} 的 retry.routes 只适用于 whenRevisionRequested: true`)
        }
        const entries = Object.entries(stage.retry.routes)
        if (entries.length === 0) {
          throw new WorkflowError(`阶段 ${stage.id} 的 retry.routes 不能为空`)
        }
        // 未命中路由的结构化信号会回落到 rewindTo；缺省目标会让这些信号无法定位。
        if (stage.retry.rewindTo === undefined) {
          throw new WorkflowError(`阶段 ${stage.id} 声明 retry.routes 时必须同时给出 retry.rewindTo`)
        }
        for (const [gapId, target] of entries) {
          if (gapId.trim() === '') {
            throw new WorkflowError(`阶段 ${stage.id} 的 retry.routes 含空 gapId`)
          }
          assertRewindTarget(
            stage,
            `retry.routes.${gapId}`,
            target,
            ids,
            indexById,
            gateIndices,
            stageIndex,
            manifest,
          )
        }
      }
      assertNonNegativeInteger(stage.retry.maxRetries ?? 1, `阶段 ${stage.id} 的 retry.maxRetries`)
    }
  }
}

/**
 * 校验一个回退目标：存在、非自身、位于本阶段之前且不跨审批门。
 * 回退会重做已确认的产出，跨运行重跑无法保留新的确认状态。
 * @param stage - 声明回退的阶段。
 * @param label - 出错信息中的字段名（如 `retry.rewindTo`）。
 * @param target - 回退目标阶段 id。
 * @param ids - 已扫描到的阶段 id。
 * @param indexById - 阶段 id → 下标。
 * @param gateIndices - 已扫描到的审批门下标。
 * @param stageIndex - 当前阶段下标。
 * @param manifest - 当前 manifest（用于错误信息）。
 * @throws WorkflowError 当目标不存在、指向自身、位于本阶段之后或跨过审批门时。
 */
function assertRewindTarget(
  stage: WorkflowStage,
  label: string,
  target: string,
  ids: ReadonlySet<string>,
  indexById: ReadonlyMap<string, number>,
  gateIndices: readonly number[],
  stageIndex: number,
  manifest: WorkflowManifest,
): void {
  if (!ids.has(target)) {
    throw new WorkflowError(`阶段 ${stage.id} 的 ${label} 指向不存在的阶段: ${target}`)
  }
  if (target === stage.id) {
    throw new WorkflowError(`阶段 ${stage.id} 的 ${label} 不能指向自身（无回退意义）`)
  }
  const rewindIndex = indexById.get(target)
  const crossedGate = gateIndices.find(index =>
    rewindIndex !== undefined && index > rewindIndex && index < stageIndex)
  if (crossedGate !== undefined) {
    throw new WorkflowError(
      `阶段 ${stage.id} 的 ${label} 跨过审批门 ${manifest.stages[crossedGate]?.id}：`
      + '回退会重做已确认的产出，跨运行重跑无法保留新的确认状态；请把审批门放到回退范围之外',
    )
  }
}

/** Reject NaN, fractions, and numeric strings arriving from external YAML/JSON. */
function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new WorkflowError(`${label} 必须为非负整数`)
}

/**
 * Check the manifest's declared guideline revision against the revision the
 * deployment expects. The cross-check is opt-in: without an expected revision
 * the declaration is only checked for a blank value.
 * @param manifest - the manifest under validation.
 * @param expected - the revision the deployment expects, when it states one.
 * @throws WorkflowError when the declaration is blank, missing under an expected
 *         revision, or different from it.
 */
function validateGuidelineRevision(manifest: WorkflowManifest, expected: string | undefined): void {
  const declared = manifest.guidelineRevision?.trim()
  if (manifest.guidelineRevision !== undefined && declared === '') {
    throw new WorkflowError(`manifest ${manifest.id} 的 guidelineRevision 不能为空字符串`)
  }
  if (expected === undefined) return
  if (expected.trim() === '') {
    throw new WorkflowError('guidelineRevision 期望版本不能为空字符串')
  }
  if (declared === undefined) {
    throw new WorkflowError(`manifest ${manifest.id} 未声明 guidelineRevision，当前指南版本为 ${expected}`)
  }
  if (declared !== expected) {
    throw new WorkflowError(`manifest ${manifest.id} 的 guidelineRevision（${declared}）与当前指南版本（${expected}）不一致`)
  }
}
