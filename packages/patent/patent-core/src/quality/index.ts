/**
 * src/quality — 稿件质量账本（draft-quality-ledger）的确定性判定域。
 *
 * 只折叠上游门原子已写入 state 的判定，不新查任何事实，也不调用模型。
 */

export * from './ledger.ts'
