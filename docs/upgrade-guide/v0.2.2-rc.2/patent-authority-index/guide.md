---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-law now verifies guideline citations against the 2026 change table, including renumbered paths, instead of three section overrides."
---

# Guideline citations follow the 2026 change table

English | [中文](guide.zh.md)

## Change

`verifyCitation` in `@deepseek-ai/dsh-patent-law` no longer treats the 2026 guideline text as three section overrides on an otherwise untouched 2023 index. The shipped index's `versions` entry for `2026 年修订版（2026-01-01 施行）` carries the sections transcribed from 局令第84号, including added and renumbered sections. `staleSections` names the six old paths. A citation of `第五部分第二章4.2.1.3` is `unverified`. A citation of a transcribed current section, such as `第一部分第一章4.1.2`, is decided against the 2026 text. Naming the 2023 revision still selects the base text.

Affected: callers that expected only 第二部分第一章4.4, 第四部分第三章2.1, and 第四部分第三章3.3 to have 2026 text, or that still cite a renumbered path.

## Migration

1. Stop citing a path listed in `staleSections` of `packages/patent/patent-law/assets/law/cn-examination-guidelines.yaml`. Use the new path recorded in `packages/patent/patent-law/assets/authority/guideline-changes-2026.yaml`.

2. Pass `{ revision: '2023 年修订版（2024-01-20 施行）' }` to `verifyCitation` only when the decision must use the 2023 text. The default is the current revision.

3. Follow [the amendment runbook](../../../cookbook/patent-authority-amendment.md) for the next amendment, then run `pnpm run rehearse-patent-amendment`.

4. Confirm with `pnpm run verify-patent-law-freshness`.
