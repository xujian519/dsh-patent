# Drafting-defect fixtures

English | [中文](README.zh.md)

Each fixture pins a specification fragment, a claim fragment, and the records a stubbed provider returns. `drafting-defects.spec.ts` runs `enablement-report` and `claim-breadth`, feeds their outputs into `legal-gaps`, and asserts the summary status. No fixture calls a model.

## Layout

| File | Contents |
|---|---|
| `types.ts` | Fixture and stubbed-record types |
| `a263.ts` | D01–D05, A26.3 enablement defects |
| `a264.ts` | D06–D09 and D11, A26.4 claim-breadth defects |
| `clean.ts` | D10, the passing control for both provisions |
| `index.ts` | The exported fixture list |

D11 is the anchor probe: the stub claims `defect: 'none'`, but its quote differs from the specification by one character, so only the program-side anchor recheck can fail it.

## Add a fixture

1. Add the fixture to `a263.ts` or `a264.ts`, or create a file and export its array from `index.ts`.
2. Set `checks` to the `legal-gaps` items it asserts: `enablement`, `claim-support-breadth`, or both.
3. Keep the `enablement` records aligned with the atom-derived feature IDs: `C{claim number}F{feature index}`, where features are the claim's characterizing part split on `，`, `；`, and `。`.
4. Copy quotes verbatim from `specification`. A rewritten quote fails the anchor recheck even when the stubbed model says `enabled: true` or `defect: 'none'`.
5. Run `pnpm exec vitest run packages/patent/patent-tools/tests/drafting-defects.spec.ts`. The spec loops every exported fixture and asserts its `legal-gaps` status.

Both provisions stay at warn level, so a failed fixture must leave `legal_gaps_passed` true and `claim-support-breadth` outside `revision_targets`. D10 must pass both checks to prove the fixtures do not reject a supported case.
