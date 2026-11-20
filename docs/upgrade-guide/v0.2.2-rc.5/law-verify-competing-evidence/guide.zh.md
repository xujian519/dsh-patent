---
kind: upgrade-guide
description: "law_verify 把释义式命题判为未判定而不是不符，竞争条目助手改名。"
---

# 共享一个主题词不再证明引用错误

[English](guide.md) | 中文

## 变更

当另一条目与命题只共享一个主题词时，`law_verify` 与 `legal_law_verify` 会报「与所引命题不符」。这把概述式释义误读成引错条：关于某一条的命题常包含「申请日」「申请人」「申请文件」，而这些是其余好几条的主题词。现在报「不符」须有正面证据：另一条目由转录文本承载该命题，或由点到命题至少四分之一篇幅、或正文承载命题比例至少是所引条目两倍的主题词承载。窄化到款或项的引用只由另一条目的转录文本反驳。理由会引用承载它的原文或主题词，使措辞问题与引错条可区分。概述式释义、或一条复合命题配多条引用，现在报「未与条文对应（未判定）」并告警，不再拦截。

同一变更改了已发布包 `@deepseek-ai/dsh-law-core` 与 `@deepseek-ai/dsh-patent-core` 的一个助手：`findCompetingLabels(entries, index, proposition, threshold, cited, covered?)` 返回 `string[]`；`findCompetingEntries(...)` 返回 `PropositionCarrier[]`，每项带 `label`、`textBacked`、`evidence`。`supportMismatchReason(law, proposition, elsewhere)` 现在接收这些条目，而不是条号字符串。

配置键与判定词汇不变；`onMismatch` 与 `onUnmatched` 的含义与默认值保持原样。

## 迁移

1. 调用 `findCompetingLabels` 的代码改调 `findCompetingEntries`，原先读字符串列表的地方改读 `.label`；用 `.textBacked` 区分转录文本承载与主题词承载，用 `.evidence` 取理由中要引用的句子。
2. 把返回的条目传给 `supportMismatchReason`；原先传条号字符串的调用方改为构造 `{ label, textBacked, evidence }`。
3. 处理「与所引命题不符」的提示词与技能：先读回传证据再改写引用。「未与条文对应（未判定）」按措辞或复合命题缺口处理：一条引用只配一条命题、贴所引原文措辞，然后重核。
4. 用 `pnpm exec vitest run packages/law/law-core packages/patent/patent-law packages/legal/legal-law` 与 `pnpm run typecheck` 确认迁移完成。
