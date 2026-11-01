/**
 * Input, output, and shared vocabulary of the `validate_specification` checks.
 *
 * Every checker module reads these types; the tool assembly and the pure entry
 * point in `validate-specification.ts` own them.
 */

import type { PatentType, TechDomain } from './draft-claims.ts'
import type { EvaluatedText } from '../internal/evaluated-input.ts'

/** Rule family a violation belongs to; per-family verdicts read this. */
export type SpecFamily =
  | 'structure'
  | 'title'
  | 'abstract'
  | 'description'
  | 'prohibitions'
  | 'figures'
  | 'claims'

/** One item a deterministic rule set cannot decide; surfaced instead of silently passing. */
export type SpecNotAssessed = {
  /** Stable identifier, shared with the workflow state and `legal-gaps`. */
  id: string
  /** Short human-readable label. */
  label: string
  /** Why deterministic rules cannot decide it. */
  reason: string
}

/** Tool input: the specification fields to validate. */
export type ValidateSpecificationInput = {
  /** Specification full text (markdown, with section headings). */
  text?: string
  /** Invention title (optional; length checked separately). */
  title?: string
  /** Abstract (optional; length / keywords / drawing checked). */
  abstract?: string
  /** Claims full text (optional; used for feature-coverage comparison). */
  claims?: string
  /** Technical domain; "chemical" enables the characterization-data check. */
  tech_domain?: TechDomain
  /** Patent type; a utility model requires drawings. Defaults to invention with a warning. */
  patent_type?: PatentType
  /** Whether the application has drawings; inferred from the text and figure analysis when absent. */
  has_drawings?: boolean
  /** Declared drawing count; compared with the drawing-description entries when supplied. */
  drawing_count?: number
  /** Abstract figure number from the request form; checked against existing figure numbers. */
  abstract_figure_number?: number
  /** Figure-analysis results (optional); enables figure-mark consistency. */
  figure_analysis?: FigureAnalysisResult[]
  /** Structured claims (optional); enables the independent-claim unity check. */
  claim_units?: ClaimUnitInput[]
  /** Claim-to-embodiment entries (optional); enables the coverage matrix. */
  coverage_entries?: CoverageEntryInput[]
  /**
   * Upstream `enablement-report` atom output (optional). The deterministic rules
   * do not re-judge A26.3; the report is recorded as an evaluated input so a
   * later run can compare which upstream verdict this check was paired with.
   */
  enablement_report?: string
}

/** One claim of the application, split into its preamble and characterizing part. */
export type ClaimUnitInput = {
  /** Claim number as printed in the claims. */
  number: number
  /** Whether the claim is an independent claim; only independent claims enter the unity check. */
  kind: 'independent' | 'dependent'
  /** Preamble, e.g. "一种智能门锁". */
  preamble: string
  /** Characterizing part (after "其特征在于"). */
  characterized?: string
}

/**
 * One claim-to-embodiment entry. Coverage is computed from `features` and
 * `embodiment_refs`; a caller-supplied coverage verdict is not part of the input.
 */
export type CoverageEntryInput = {
  /** Claim identifier of the form `claim_<n>`. */
  claim_id: string
  /** Technical features of that claim. */
  features: string[]
  /** Embodiment passages that support the claim. */
  embodiment_refs: string[]
}

/** One compliance violation. */
export type SpecViolation = {
  rule: string
  /** Rule family; `spec-check` derives per-family verdicts from it. */
  family: SpecFamily
  severity: 'error' | 'warning'
  section?: string
  message: string
  suggestion?: string
  /**
   * Line (1-based) of the earliest literal hit in the checked text. Absent for
   * absence and aggregate checks (missing sections, coverage rates, numeric-range
   * coverage), and for checks reading a separate input field (title, abstract,
   * claims), where a line into the specification would point at nothing.
   */
  line?: number
  /** Sentence containing that hit; present exactly when `line` is. */
  matchedSentence?: string
}

/** The canonical validation result. */
export type ValidateSpecificationOutput = {
  passed: boolean
  score: number
  violations: SpecViolation[]
  /** Items deterministic rules cannot decide; callers must surface these rather than read `passed` as full compliance. */
  not_assessed: SpecNotAssessed[]
  /** Identity of the text inputs this run read, so another run can be compared with it. */
  evaluated: EvaluatedText[]
}

/** A numeric range extracted from the specification. */
export type NumericRange = { min: number; max: number; unit: string }

/** One recognized figure component as read by the consistency checker. */
type FigureComponentRef = {
  /** Reference mark from the figure (Arabic numerals only). */
  refNumber: string
}

/**
 * Minimal figure-analysis result consumed by this checker: `usable` and each
 * component's `refNumber` reconcile figure marks against the drawing-description
 * section, and `figureNumber` (optional) reconciles the abstract figure. Ported
 * from Sati's full `FigureAnalysisResult` (the rest is not needed here).
 */
export type FigureAnalysisResult = {
  /** Figure number of the analyzed drawing; absent for callers that only check marks. */
  figureNumber?: number
  /** Whether the analysis cleared the usable-confidence threshold. */
  usable: boolean
  /** Recognized components with their reference marks. */
  components: FigureComponentRef[]
}

/** Injectable dependencies for the `validate_specification` tool. */
export type ValidateSpecificationDeps = {
  /** Reports whether the RDKit chemistry engine is available for SMILES validation. Defaults to false (RDKit is not bundled in dsh). */
  isRdkitAvailable?: () => boolean
}
