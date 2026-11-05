/**
 * Shared types of the fee index: what the asset file declares, what a case asks
 * about, and what the tool reports.
 *
 * The split that runs through all of them is applicability versus amount: which
 * fee items a case owes is structural and always answerable, while every money
 * value is transcription content that carries its own source and verification
 * date.
 * @module @deepseek-ai/dsh-patent-fees/types
 */

import type { RecordedSource } from '@deepseek-ai/dsh-patent-index-asset'

/** Patent types a fee item can apply to. */
export type PatentType = 'invention' | 'utility-model' | 'design'

/** The step at which a fee is owed. */
export type FeeTrigger =
  /** Filing an application: application fee, printing, surcharges, priority claims. */
  | 'filing'
  /** Requesting substantive examination. */
  | 'substantive-examination'
  /** Registering the grant: the granted year's annual fee and stamp tax. */
  | 'grant-registration'
  /** Annual fees after the granted year. */
  | 'annual-fee'
  /** Requesting reexamination. */
  | 'reexamination'
  /** Requesting invalidation. */
  | 'invalidation'
  /** Requesting a patent evaluation report. */
  | 'evaluation-report'
  /** Requesting restoration of rights. */
  | 'restoration'
  /** Requesting an extension of a period. */
  | 'extension'
  /** Changing bibliographic data. */
  | 'record-change'
  /** The grace fee for entering the Chinese national phase late under the PCT. */
  | 'pct-grace'

/**
 * How an item's quantity is counted. `per-case` and `per-annuity-year` are
 * fixed by the case's shape; the others subtract the item's `freeUnits` or
 * count a case fact the caller supplies.
 */
export type FeeBasis =
  /** One charge per case. */
  | 'per-case'
  /** One charge per claim beyond `freeUnits`. */
  | 'per-claim-beyond'
  /** One charge per specification page beyond `freeUnits`. */
  | 'per-page-beyond'
  /** One charge per priority claim. */
  | 'per-priority'
  /** One charge per patent year. */
  | 'per-annuity-year'
  /** One charge per month of an extension. */
  | 'per-month'

/** Fee-reduction programmes the index can carry. */
export type ReductionKind = 'individual' | 'enterprise'

/**
 * Where a transcribed value came from: the source and check date every index
 * entry records, plus the date the fee standard took effect. Every field is null
 * until a person records it; an amount without a verification date is
 * unverified, not verified-by-default.
 */
export type FeeValueSource = RecordedSource & {
  /** Date the fee standard took effect, or null. */
  effectiveFrom: string | null
}

/** One annual-fee tier: the years it covers and the amount for each of them. */
export type AnnuityTier = {
  /** First patent year the tier covers. */
  fromYear: number
  /** Last patent year the tier covers. */
  toYear: number
  /** Amount per year, in yuan, as a decimal string. */
  amount: string
}

/** The surcharge rule that follows an annual fee's due date. */
export type LatePaymentRule = {
  /** Percentage of the year's full annual fee added per month of delay. */
  monthlyPercent: number
  /** Number of months the fee may still be paid with a surcharge. */
  maxMonths: number
  /** The rule's statutory basis, or null while unrecorded. */
  legalBasis: string | null
} & FeeValueSource

/** One indexed fee item. */
export type FeeItem = {
  /** Stable id, unique within the table. */
  id: string
  /** Official name of the fee. */
  name: string
  /** The step at which it is owed. */
  trigger: FeeTrigger
  /** Patent types it applies to; null means every type. */
  patentTypes: PatentType[] | null
  /** How its quantity is counted. */
  basis: FeeBasis
  /** Free units a `beyond` basis subtracts; required for those bases. */
  freeUnits?: number
  /** Amount per unit, in yuan, as a decimal string; null until transcribed. */
  amount: string | null
  /** Whether it falls under fee reduction; null while unrecorded. */
  reducible: boolean | null
  /** Highest patent year a reduction covers, for year-indexed items. */
  reductionMaxYears?: number
  /** Annual-fee tiers; empty until transcribed. */
  tiers: AnnuityTier[]
  /** Surcharge rule of an annual fee. */
  latePayment?: LatePaymentRule
  /** The item's statutory basis, or null while unrecorded. */
  legalBasis: string | null
} & FeeValueSource

/** One fee-reduction programme. */
export type ReductionRule = {
  kind: ReductionKind
  /** How the programme is named in Chinese. */
  label: string
  /**
   * Percentage of the fee that is waived: the payable amount is
   * `amount × (1 − reductionPercent / 100)`, so 85 means 15% is still paid.
   */
  reductionPercent: number | null
  /** Whether the reduction requires a filed reduction record beforehand. */
  requiresFiling: boolean
} & FeeValueSource

/** One loaded fee index. */
export type FeeTable = {
  /** Title of the fee standard. */
  document: string
  /** Revision the index targets, or null while unrecorded. */
  revision: string | null
  /** Currency every amount is stated in, e.g. `CNY`. */
  currency: string
  /** Fee-reduction programmes the table carries. */
  reductions: ReductionRule[]
  /** Indexed fee items, in the order the asset lists them. */
  items: FeeItem[]
} & FeeValueSource

/** The reduction a case asks for. */
export type ReductionRequest = {
  kind: ReductionKind
  /** Whether the reduction record was filed before paying. */
  filed: boolean
}

/** What a caller knows about the case it is pricing. */
export type FeeQuery = {
  patentType: PatentType
  /** Steps of this case; only items under them are considered. */
  triggers: FeeTrigger[]
  /** Total claim count, for the claim-count surcharge. */
  claims?: number
  /** Specification page count, for the page-count surcharge. */
  specificationPages?: number
  /** Number of priority claims made, for the priority-claim fee. */
  priorityClaims?: number
  /** Patent years whose annual fee is being priced, 1-based. */
  annuityYears?: number[]
  /** Months of extension requested, for the extension fee. */
  extensionMonths?: number
  /** Started months of delay on an annual fee, for the surcharge. */
  lateMonths?: number
  /** The reduction the case qualifies for, when there is one. */
  reduction?: ReductionRequest
}

/** How well an amount is supported. */
export type AmountStatus =
  /** The item's amount and verification date are both recorded. */
  | 'verified'
  /** The amount is recorded but its verification date is not. */
  | 'unverified'
  /** The amount is not recorded at all. */
  | 'unrecorded'

/** One priced fee item. */
export type FeeLine = {
  id: string
  name: string
  basis: FeeBasis
  /** Units charged; an item whose quantity needs a missing input is reported as pending instead. */
  quantity: number
  /** How the quantity was counted, in the model's language. */
  quantityBasis: string
  /** Amount per unit, in yuan, or null when it cannot be stated. */
  unitAmount: string | null
  /** Quantity × unit amount, in yuan, or null. */
  subtotal: string | null
  /** What the case owes after any reduction, in yuan, or null. */
  payable: string | null
  /** How well the amount and payable figures are supported. */
  status: AmountStatus
  /** The reduction applied to this line, in the model's language, or null. */
  reduction: string | null
  /** The item's statutory basis, or null while unrecorded. */
  legalBasis: string | null
  /** Where the amount came from, copied from the asset. */
  valueSource: FeeValueSource
  /** Anything about this line the caller has to know. */
  notes: string[]
}

/** A fee item that cannot be priced because a case input is missing. */
export type PendingFee = {
  id: string
  name: string
  /** The input whose value is required. */
  requiredInput: string
  reason: string
}

/** What the reduction request resolved to. */
export type ReductionOutcome = {
  kind: ReductionKind
  filed: boolean
  /** The waived percentage, or null while it is not recorded. */
  reductionPercent: string | null
  /** Whether the ratio was applied to any line. */
  applied: boolean
  reason: string
}

/** The report's total. */
export type FeeTotal = {
  /** The total in yuan, or null when it must not be stated. */
  amount: string | null
  /**
   * Whether every named trigger is indexed, every applicable line carries a
   * verified payable amount, and no applicable item is waiting for a case input.
   */
  complete: boolean
  /** Ids of the lines and pending items that keep the total incomplete. */
  unverifiedIds: string[]
  /**
   * Triggers the query named but the index carries no item for. Present only
   * when non-empty; such a stage is unknown, not free, so the total is withheld.
   */
  uncoveredTriggers?: string[]
}

/** The priced case. */
export type FeeReport = {
  /** Currency of every amount in the report. */
  currency: string
  lines: FeeLine[]
  /** Items that need a case input the query did not supply. */
  pending: PendingFee[]
  reduction: ReductionOutcome | null
  total: FeeTotal
  /** Statements that apply to the report as a whole. */
  notes: string[]
}
