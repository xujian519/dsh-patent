# Agent Note: Calibrate deterministic readings against professional amendments

Status: implemented

English | [中文](2026-11-26-patent-draft-calibration-against-professional-amendments.zh.md)

## Problem

The drafting chain now reports deterministic quality readings (`draft_quality`, `revision_ledger`), but nothing in the repository answers whether those readings move in the direction a patent attorney would move a draft. Without that, a check that never matches professional judgement keeps firing in prompts and gates, and there is no measured distribution of what a finished professional draft looks like on the same readings.

Two planned inputs were unavailable. Attorney scoring of many drafts takes practitioner time that was not committed, and a large keyed run takes model spend that was not committed. The remaining offline route was to compare machine output against the amendment record that already happened: the corpus of pre-amendment and amended text sitting in the ignored per-case work directories.

The other candidate input also failed on inspection. `packages/self-evolve/self-evolve-benchmark/examples/patent-oas/corpus/` was assumed to hold granted-application text that the same checks could read. Each of its 50 items is a single 413-byte de-legalized statement carrying the publication number and figure count — no claims and no description — so committed repository content contains no patent full text and cannot yield an offline distribution reference. Full text exists only under ignored directories (`patent-workspace/`, `.dsh-work/`).

## Decision

`scripts/patent-draft-calibration.ts` holds the pure functions and `scripts/verify-patent-draft-calibration.ts` is the command. The manifest lists every measured pair by `stem` and the two file names, before and after the amendment; nothing is discovered by pattern, so the measured set is a checked decision rather than a directory listing, and the manifest file stays outside the repository with the text it names. Each side is read with model-free checks only: claim-lint error and warning counts with per-rule tallies, the spec-check violation count and similarity score, the `slop_score` total from the slop gate (higher is better), and the draft-quality ledger fold. Direction agreement is `improved / (improved + regressed)` over the pairs that moved an axis; an axis no pair moved reports `n/a` rather than a perfect score.

The committed artifact is `packages/self-evolve/evaluation/patent-draft-calibration.json`: per-case rows keyed by an alias derived from the file stem's digest (ten letters, so no digit run can look like an application number), a corpus digest over the sorted `alias:similarity` lines, the reference range as amended-side p10/median/p90 plus pass rate, the rule-level tally, and the floors the gate asserts (`minPairs`, `minAgreement`, `agreementAxes`). Anonymity is enforced before write: the leak scan reads only the fields that can carry text — the recorded command, the aliases, the rule keys — because scanning the serialized JSON would flag digit runs inside the hex digest and inside similarity values.

Two commands run against one artifact. With no arguments the gate recomputes every aggregate from the stored rows and asserts the floors and the leak scan, which is what CI runs; the corpus is not needed and never reaches CI. With `--manifest` and `--corpus` the command re-measures and compares structurally against the stored artifact, naming the case whose readings moved; `--write` is required to replace the file, and first publication must state the floors on the command line rather than inherit them.

Measured evidence, 12 pairs from the amendment corpus (corpus digest `sha256:f93f8dc6015…`): `lint-errors` agreement 0.667 over 9 moving pairs, `lint-warnings` 0.500 over 8, `spec-score` 1.000 over 1, `slop-total` 1.000 over 5, and `spec-violations` 0 of 12 pairs moved. Declared agreement axes are `lint-errors`, `spec-score`, `slop-total` at 0.6; `lint-warnings` is recorded but not gated. Amended-side pass rates are 17% for lint errors, 17% for lint warnings, 25% for spec violations, 92% for the spec-check score, and 42% for `slop_score`, whose pass line of 35 sits one point above the amended-side median of 34 — five of twelve amended drafts clear it.

## Reading limits

Claim-lint vocabulary rules do not branch on patent type: `lintClaim` takes no options, so utility-model wording such as the `process-feature` and `functional-limitation` notices fires against invention-application text. A hit records that an attorney should look at the phrasing, not that the draft violates a rule. `non-claim-content` fires nine times before and nine times after, on nine of the twelve cases, because the extracted text keeps non-claim lines around the claims; the count is an artifact of extraction, not a professional finding.

`spec-violations` does not move across professional amendments, so it carries no directional information here and is not a gate candidate. `spec-score` and `slop-total` agreements rest on one and five moving pairs, which is description, not a demonstrated rate.

The ledger fold judges one of its five catalog rows on external text — spec-check — and reports the other four as unassessed, so calibration never reads a 0–100 draft-quality score. Character-multiset similarity reads high under reordering and is used only to band a pair's edit size, never to compare edit size across cases.

## Alternatives considered

**Keep B1 as a committed-corpus distribution reference.** Rejected on inspection: the committed corpus is paraphrase metadata, and committing full text of real applications would publish case material that was never authorized for release.

**Ask a model to judge which side is better.** Rejected: it needs a key per run, the result is not reproducible across models or prompt revisions, and the evidence being tested is the deterministic checks — judging them with a model leaves nothing that reproduces.

**Use the `draft_quality` 0–100 scalar as the calibrated direction.** Rejected: three of its five rows are unassessed on external text, and an unassessed row must not be read as no movement, which is what a score would do.

**Register a patent-core atom or model-facing tool.** Rejected: nothing here enters a model request, and the model-visible rule would then demand a session event for data that must stay off-repository. This is an offline gate, which is the `scripts/` responsibility.

**Follow the patent-oas `gate.yaml` "declared surface needs a baseline" mechanism.** Rejected: that mechanism compares recorded keyed runs against per-surface baselines. Calibration compares one anonymous aggregate against its own declared floors, so the floors live in the artifact and no surface registry is needed.

**Discover pairs by globbing the corpus directory.** Rejected: the measured set would change whenever case material is added or removed locally, and a gate that can silently change its own population cannot support a declared `minPairs`.

## Consequences

There is now a measured answer, from twelve pairs, to whether the deterministic readings move the way professional amendments move: claim-lint error counts do at 0.667, and the spec-violation count does not at all. Each rule carries its own before/after finding tally, which is the evidence for keeping, narrowing, or dropping a rule rather than arguing about it. The reference range gives later draft output something to be compared against without a model.

CI cannot prove the artifact still matches the corpus, because the corpus is not in the repository; it proves the artifact is internally consistent, anonymized, and above its declared floors. Reproducing the measurement needs an operator holding the amendment text, so the re-measure path is evidence recorded per regeneration, not a standing check. `lint-warnings` is published without a floor, which keeps the honest 0.500 visible instead of dropping the axis or moving the threshold to fit it.

## Testing

`scripts/patent-draft-calibration.spec.ts` covers pair discovery (missing side, path escaping the corpus root, manifest rejection of a duplicate or a JS tag), the four readings, band boundaries, alias derivation, digest order-independence, artifact round trip, and negative controls for a foreign schema version, an out-of-set enum, a negative count, a rule key carrying text, a CJK run, a duplicated alias, an edited aggregate, a stale band, a direction contradicting its readings, a corpus below `minPairs`, a declared axis no pair moved, and an agreement below the floor. `scripts/verify-patent-draft-calibration.spec.ts` covers option parsing and the exit codes of the three modes, including that a gate change is located at the case whose readings moved. Both spec files are wired through the existing `scripts/**/*.spec.ts` include.

## Related

- [Disclosure revision ledger and quality scalar](../feature/2026-11-25-disclosure-revision-ledger-and-quality-scalar.md) — the stages whose verdicts this calibration reads.
- [PFIE insight slot and consistency atom](../architecture/2026-10-17-pfie-insight-slot-and-consistency-atom.md) — names the per-case work directories the amendment corpus comes from.
