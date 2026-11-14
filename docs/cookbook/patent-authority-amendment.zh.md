---
description: "把一次专利法源变动依次带过沿革记录、索引、规则、模板和评测。"
---

# 手册：修订专利权威索引

[English](patent-authority-amendment.md) | 中文

法律、实施细则或审查指南的修订进入随包索引之后使用本手册。[权威决定](../../.agents/notes/implemented/architecture/2026-11-13-patent-authority-60-day-plan.zh.md)记录索引为什么是固定的一侧。演练命令用已经在库里的 2026 年指南修订走完五步。

## 步骤

1. 先记录修订，再改判定。指南修订更新 `packages/patent/patent-law/assets/authority/guideline-changes-2026.yaml`，写明修订版本和改编号。法律修订更新本包已经加载的沿革资产。确认文件写的是即将施行的版本。

2. 更新 `packages/patent/patent-law/assets/law/` 里的索引。转录新文本，让 `supersededBy` 指向正在施行的修订，只有旧路径的随包文本不再符合现行版时才把它写入 `staleSections`。运行 `pnpm run verify-patent-law-freshness` 和 `pnpm run verify-patent-law-coverage`。

3. 更新每条 `legalBasis` 引用了变动条文的随包规则，然后运行 `pnpm exec tsx scripts/verify-patent-rule-citations.ts`。索引拒绝的法律或指南引用会使命令失败。

4. 某个规则族、程序计算、文书模板或工作流 manifest 实现了变动条文时，更新 `packages/patent/patent-law/assets/authority/rule-procedure-alignment.yaml`。运行 `pnpm exec tsx scripts/verify-patent-rule-alignment.ts`。

5. 在 `packages/patent/patent-law/assets/authority/authority-eval-tasks.yaml` 里新增或调整任务，使新文本成为应当引用的条文，被取代的口径成为被拒绝的表述。运行 `pnpm run patent-authority-eval` 和 `pnpm run patent-authority-closeout`。引用正确率保持不低于 98%，错误口径保持为零。

用 `pnpm run rehearse-patent-amendment` 确认整条路径。随包的 2026 年修订缺任何一步，命令都会失败。
