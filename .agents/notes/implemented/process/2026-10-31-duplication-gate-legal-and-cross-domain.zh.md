# Agent Note: Duplication gate covers the legal domain and cross-domain clones

Status: implemented

[English](2026-10-31-duplication-gate-legal-and-cross-domain.md) | 中文

## Problem

收紧遍按「一次 jscpd 调用一个域」扫描,而 `packages/legal` 不在其中。jscpd 只比较同一次调用所给根目录内的文件,因此两个文件分属不同收紧域时根本不会出现在报告里;仓库级 60 token 阈值又挡住了本议题测到的全部对(最大 58 token)。legal 域因此没有 CI 信号,而共享 `patent-core` / `patent-index-asset` 的 legal/patent 两个域可能悄悄长出同一语义的两份实现。

## Decision

**`packages/legal` 加入收紧域。** `TIGHTENED_DOMAINS` 现在列出 `packages/patent`、`packages/legal`、`packages/document`。每个域仍作为独立的 jscpd 根运行,因此 91 对已接受的域内克隆路径保持稳定。

**第二遍一次扫描三个域。** `crossDomainPairs` 只保留两条路径解析到不同 `packages/<group>` 的对。这一遍报出基线之外的对,或已接受的对不再被报出,`pnpm run duplication` 都判失败。

**基线分开记录两类对。** `scripts/duplication-baseline.json` 持有 `pairs` 与 `crossDomainPairs`。`readBaseline` 拒绝缺少任一列表的文件:缺列表是损坏的基线,不是空的接受清单。

## Accepted pairs

15 对 legal 域内克隆直接登记进基线,不再逐对说明:它们是同一域内的平行 evaluator、检索模块与类型声明,与 patent、document 两域已接受过的形态相同。

14 对跨域克隆按三类理由接受:

| 对 | 接受理由 |
|---|---|
| `legal-evidence/src/engine.ts` ↔ `patent-core/src/evidence/engine.ts`;`legal-evidence/src/rule-set.ts` ↔ `patent-core/src/evidence/rule-set.ts` | 平行的域引擎。legal 引擎判关联性/合法性/真实性,patent 引擎另有类型特定维度、证明标准与举证责任分配。抽成共享模块会让一个域引入另一个域的词汇。 |
| `legal-evidence/src/rule-set.ts` ↔ `patent-rule/src/runtime/args-match.ts` | 只有参数归一化辅助函数。 |
| `legal-evidence/src/tool/evaluate-evidence.ts` ↔ `patent-teams/src/tools.ts`、`patent-tools/src/tool/analyze-patent-figure.ts`、`patent-tools/src/tool/parse-office-action.ts`、`tool-literature/src/tool/paper-download.ts` | 工具声明脚手架——入参 schema、描述、注册——不是领域逻辑。 |
| `legal-knowledge/src/types.ts` ↔ `patent-knowledge/src/types.ts` | 两者都声明数据目录与检索结果类型;存储、路径与记录字段不同。 |
| `legal-law/src/{asset-location,baseline,index,verify,types,tool/law-verify}.ts` ↔ `patent-law/src/{asset-location,baseline,index,verify,types,tool/law-verify}.ts`;`legal-law/src/types.ts` ↔ `patent-core/src/knowledge/article-decision.ts` | 同一能力缝在不同语料上的镜像脚手架。legal-law 经清单读取 7,910 个文件的语料,只解析引用点名的法律;patent-law 跑固定基线。重合的是目录解析、错误构造与工具注册。 |

2026-11-06 更新：`legal-law/src/types.ts` ↔ `patent-core/src/knowledge/article-decision.ts` 对因引用判定规则迁入 `@deepseek-ai/dsh-law-core` 而消失（见 law-core 说明）；跨域清单现为 13 对。

## Alternatives considered

**为 legal-law/patent-law 镜像抽取共享模块。** 否决:两条能力缝在语料访问、核验判定与类型上已经分叉(`baseline.ts` 427 对 236 行,`verify.ts` 196 对 487 行)。共享包必须同时承载两套策略,把 7,910 部法律的惰性索引与固定专利基线绑在一起,换来的只是约 200 行脚手架。

**只加 `packages/legal`,不做跨域遍。** 否决:本议题的主要发现是 legal↔patent 克隆不可见,而仓库级 60 token 阈值看不见它们。只覆盖域内挡不住 legal-law 里再复制一份 patent-law。

**用三根合并的一遍取代逐域遍。** 否决:一次合并调用会漏掉单根遍能报出的 3 对 patent 域内克隆,基线会因为这些从未变化的对标为过期。合并遍只用于挑出跨域对。

## Consequences

门禁多跑一次覆盖三域的 jscpd 调用;本地 `pnpm run duplication` 约 6 秒。新增 legal 克隆与新增 legal↔patent 克隆现在会在 CI 失败,而不是等评审发现。

14 对跨域克隆是固定的脚手架。将来若其中一对变得更大,门禁会失败,并要求缩小克隆或显式更新基线。
