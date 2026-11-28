/**
 * src/quality — 确定性质量判定域：稿件质量账本（draft-quality-ledger）、
 * `patent_eval` 与 patent-teams 质量门共用的产出评估，以及反套话引擎。
 *
 * 只折叠上游门原子已写入 state 的判定，或对文本做确定性评分，不新查任何事实，
 * 也不调用模型。
 */

export * from './ledger.ts'
export * from './patent-eval.ts'
export * from './slop-engine.ts'
