/**
 * 26.3/26.4 种植缺陷夹具。
 *
 * 每条夹具固定说明书与权利要求原文，并用桩 provider 返回预设模型记录；
 * `drafting-defects.spec.ts` 运行对应原子后，把输出交给 `legal-gaps`，
 * 断言汇总项状态，而不是只断言原子输出。
 */

import { A263_FIXTURES } from './a263.ts'
import { A264_FIXTURES } from './a264.ts'
import { D10 } from './clean.ts'
import type { DraftingDefectFixture } from './types.ts'

export type {
  ClaimBreadthModelRecord,
  DraftingDefectCheck,
  DraftingDefectFixture,
  EnablementModelRecord,
} from './types.ts'

/** 全部种植缺陷夹具。 */
export const DRAFTING_DEFECT_FIXTURES: readonly DraftingDefectFixture[] = [
  ...A263_FIXTURES,
  ...A264_FIXTURES,
  D10,
]
