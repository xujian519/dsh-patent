export * from './protocol/types.ts'
export {
  normalizeWhitespace,
  validateElements,
  validateClaimTextStructure,
  splitClaimSegments,
  type ElementValidationResult,
} from './runtime/element-validator.ts'
export {
  validateRowMapping,
  deriveNoveltyCoverage,
  deriveNoveltyCoverageByClaim,
  deriveDistinguishingFeatures,
  isElementCovered,
  type ClaimNoveltyCoverage,
} from './runtime/mapping-machine.ts'
export {
  deriveClaimRefs,
  validateClaimRefs,
  referencedClosure,
  parseReferenceNumbers,
  type ClaimRefIssue,
} from './runtime/claim-refs.ts'
export {
  deriveInvalidityConclusion,
  renderInvalidityConclusion,
  type DependentClaimPathIssue,
  type InvalidityConclusion,
  type InvalidityConclusionInput,
} from './runtime/invalidity-conclusion.ts'
export { detectGaps } from './runtime/gap-detector.ts'
export {
  validatePinCite,
  verifyQuoteInSource,
  type PinCiteCheckResult,
} from './runtime/pin-cite-validator.ts'
export {
  saveClaimChart,
  loadClaimChart,
  renderChartMarkdown,
  chartFileBase,
} from './runtime/store.ts'
