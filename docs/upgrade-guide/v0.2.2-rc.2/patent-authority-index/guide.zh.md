---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-law 现在按 2026 年修改对照表核验指南引用，包括改编号的路径，而不再只覆盖三节。"
---

# 指南引用按 2026 年修改对照表判定

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-patent-law` 的 `verifyCitation` 不再把 2026 年指南文本当成三节覆盖、其余仍是未改动的 2023 年索引。随包索引里 `2026 年修订版（2026-01-01 施行）` 的 `versions` 收录从局令第84号转录的节，包括新增和改编号的节。`staleSections` 列出六条旧路径。引用 `第五部分第二章4.2.1.3` 得到 `unverified`。引用已转录的现行节，例如 `第一部分第一章4.1.2`，按 2026 年文本判定。指定 2023 年修订版时仍使用基础文本。

受影响的是仍指望只有第二部分第一章4.4、第四部分第三章2.1 和第四部分第三章3.3 带有 2026 年文本的调用方，以及仍在引用改编号前路径的调用方。

## 迁移

1. 不要再引用 `packages/patent/patent-law/assets/law/cn-examination-guidelines.yaml` 的 `staleSections` 里的路径。改用 `packages/patent/patent-law/assets/authority/guideline-changes-2026.yaml` 记录的新路径。

2. 只有判定必须使用 2023 年文本时，才向 `verifyCitation` 传入 `{ revision: '2023 年修订版（2024-01-20 施行）' }`。缺省是现行修订。

3. 下一次修订按[运行手册](../../../cookbook/patent-authority-amendment.zh.md)执行，然后运行 `pnpm run rehearse-patent-amendment`。

4. 用 `pnpm run verify-patent-law-freshness` 确认。
