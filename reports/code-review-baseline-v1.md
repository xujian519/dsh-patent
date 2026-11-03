# 代码审阅基线快照 v1

> 采集时间：2026-11-03；分支 `trae/agent-gGNODt`；node v24.1.0 / pnpm 11.28.5。
> 统计口径：`src/` 下 `.ts` / `.tsx`；测试单独统计。依赖已安装，门禁可运行。
> 本快照是 30 天计划的对照基线，D20 与 D30 各复采一次。

## 1. 执行摘要

1. 范围共 27 个包、130,713 行源码、121,772 行测试；patent 占 83.6%。
2. 结构热点集中在 `patent-tools`（37k 行、129 个公共导出）与 `patent-core`（33.8k 行、89 个公共导出）。
3. 91 个文件超过 400 行，29 个超过 600 行，最大单文件 1,304 行。
4. 重复检测基线含 91 个收紧域配对与 14 个跨域配对；其中 legal 与 patent 之间存在**同构但已分叉**的实现，是最高风险项。
5. 源码中 65 处 `as unknown`（51 处在 `patent-tools`），另有 3 处 `: any` 与 10 处真实 TODO。

## 2. 规模基线

| 领域 | 包数 | 源码行数 | 测试行数 | 源码占比 |
|---|---:|---:|---:|---:|
| patent | 16 | 109,364 | 103,577 | 83.6% |
| legal | 3 | 5,446 | 4,964 | 4.2% |
| document | 5 | 7,208 | 6,515 | 5.5% |
| video | 3 | 8,695 | 7,078 | 6.7% |
| 合计 | 27 | 130,713 | 122,134 | 100% |

### 2.1 单包明细

| 包 | 源码文件 | 源码行数 | 测试文件 | 测试行数 |
|---|---:|---:|---:|---:|
| `patent/patent-tools` | 141 | 37,012 | 114 | 35,103 |
| `patent/patent-core` | 175 | 33,793 | 100 | 23,865 |
| `patent/patent-teams` | 20 | 5,552 | 16 | 5,962 |
| `patent/patent-rule` | 22 | 5,382 | 30 | 6,841 |
| `patent/patent-workflow` | 16 | 4,612 | 26 | 6,093 |
| `patent/patent-knowledge` | 28 | 3,806 | 21 | 3,463 |
| `patent/patent-document` | 23 | 3,723 | 26 | 5,243 |
| `patent/patent-law` | 13 | 2,838 | 15 | 3,672 |
| `patent/patent-deadline` | 10 | 2,816 | 10 | 1,886 |
| `patent/tool-literature` | 18 | 2,370 | 13 | 2,829 |
| `patent/patent-data` | 12 | 2,261 | 14 | 2,771 |
| `patent/patent-fees` | 7 | 1,516 | 6 | 1,320 |
| `patent/writing-patterns` | 7 | 1,347 | 10 | 1,380 |
| `patent/patent-filing` | 10 | 1,334 | 11 | 2,401 |
| `patent/methodology` | 5 | 626 | 6 | 645 |
| `patent/patent-index-asset` | 5 | 376 | 1 | 103 |
| `legal/legal-knowledge` | 16 | 2,246 | 9 | 2,335 |
| `legal/legal-evidence` | 12 | 1,695 | 5 | 1,248 |
| `legal/legal-law` | 8 | 1,505 | 5 | 1,381 |
| `document/doc-template` | 13 | 2,222 | 12 | 2,270 |
| `document/document-deliver` | 4 | 1,789 | 2 | 1,488 |
| `document/docx-kit` | 8 | 1,720 | 7 | 1,048 |
| `document/doc-style` | 7 | 821 | 5 | 593 |
| `document/office-to-pdf` | 6 | 656 | 4 | 1,116 |
| `experimental/video-mode` | 22 | 7,276 | 16 | 5,964 |
| `client/ui-video-studio` | 7 | 1,417 | 4 | 974 |
| `experimental/video-bundle` | 1 | 2 | 1 | 140 |

## 3. 复杂度基线

- 超过 400 行的文件：**91**
- 超过 600 行的文件：**29**
- 仓库级结构报告：`report-structure` 扫描 6,907 个文件；**186 个函数超过 150 行**；**89 个仓库级源文件超过 800 行**（其中 3 个生成文件单列）。

### 3.1 范围内最大的 15 个源文件

| 文件 | 行数 |
|---|---:|
| `patent/patent-deadline/src/statutes.ts` | 1,304 |
| `experimental/video-mode/src/media.ts` | 1,250 |
| `patent/patent-tools/src/figure/render-check-findings.ts` | 951 |
| `patent/patent-tools/src/figure/section-diagram.ts` | 918 |
| `experimental/video-mode/src/comfyui.ts` | 910 |
| `patent/patent-tools/src/figure/leader-line.ts` | 908 |
| `patent/patent-workflow/src/workflow/manifests.ts` | 898 |
| `patent/patent-tools/src/tool/patent-workflow-run.ts` | 858 |
| `patent/patent-core/src/atoms/handlers/builtin/evidence-check.ts` | 842 |
| `patent/patent-tools/src/figure/dot-builder.ts` | 839 |
| `patent/patent-core/src/draft/validate.ts` | 811 |
| `patent/patent-core/src/ipc/ipc-classifier.ts` | 807 |
| `patent/patent-tools/src/atoms/eligibility.ts` | 797 |
| `patent/patent-tools/src/figure/render-check-scan.ts` | 792 |
| `patent/patent-tools/src/figure/freecad-structure-script.ts` | 762 |

### 3.2 超长文件分布

| 包 | >400 行文件数 |
|---|---:|
| `patent-tools` | 29 |
| `patent-core` | 19 |
| `patent-teams` | 6 |
| `patent-rule` | 5 |
| `patent-workflow` | 4 |
| `patent-knowledge` | 3 |
| `patent-document` | 3 |
| `video-mode` | 8 |
| 其余包 | 各 1–2 |

## 4. 类型安全基线

| 指标 | 源码 | 测试 |
|---|---:|---:|
| `as unknown` | **65** | 103 |
| `: any` | **3** | 5 |
| `@ts-ignore` / `@ts-expect-error` | 0 | 0 |

源码 `as unknown` 分布：`patent-tools` 51、`tool-literature` 4、`patent-teams` 4、`patent-core` 4、`document-deliver` 2。

## 5. 标记基线

真实 TODO/FIXME 注释共 **10** 处，全部位于 `patent-core/src/adversary/` 与其原子处理器，主题一致：当前是确定性骨架，完整版需要模型注入。

> 初次宽泛检索得到的 37 处包含 `XXXX` 编号占位与 `\uXXXX` 转义说明，属于误报，已剔除。

## 6. 测试密度基线

| 包 | 测试/源码行数比 |
|---|---:|
| `patent-index-asset` | 0.27 |
| `docx-kit` | 0.61 |
| `patent-deadline` | 0.67 |
| `ui-video-studio` | 0.69 |
| `patent-core` | 0.71 |
| `doc-style` | 0.72 |
| `legal-evidence` | 0.74 |
| `video-mode` | 0.82 |
| `document-deliver` | 0.83 |
| `patent-fees` | 0.87 |
| `patent-knowledge` | 0.91 |

测试密度只作为采样信号，不作为覆盖率结论；正式覆盖率在周度门禁采集。

## 7. 重复实现基线

`pnpm run duplication` 结果：**0 个仓库级新克隆**；91 个收紧域配对与 14 个跨域配对与 `scripts/duplication-baseline.json` 相符。

### 7.1 跨域同构（最高优先级）

| legal 侧 | patent 侧 | 性质 |
|---|---|---|
| `legal-evidence/src/engine.ts` | `patent-core/src/evidence/engine.ts` | 同构证据引擎 |
| `legal-evidence/src/rule-set.ts` | `patent-core/src/evidence/rule-set.ts` | 同构规则表 |
| `legal-law/src/asset-location.ts` | `patent-law/src/asset-location.ts` | 同构资产定位 |
| `legal-law/src/baseline.ts` | `patent-law/src/baseline.ts` | 同构基线装载 |
| `legal-law/src/index.ts` | `patent-law/src/index.ts` | 同构入口 |
| `legal-law/src/tool/law-verify.ts` | `patent-law/src/tool/law-verify.ts` | 同构工具 |
| `legal-law/src/verify.ts` | `patent-law/src/verify.ts` | 同构判定 |
| `legal-knowledge/src/types.ts` | `patent-knowledge/src/types.ts` | 同构类型面 |

同名文件内容已分叉，不是简单复制：

| 文件对 | 增加行 | 删除行 |
|---|---:|---:|
| `legal-law/reference.ts` ↔ `patent-law/reference.ts` | 146 | 144 |
| `legal-law/verify.ts` ↔ `patent-law/verify.ts` | 339 | 59 |
| `legal-law/tool/law-verify.ts` ↔ `patent-law/tool/law-verify.ts` | 111 | 114 |

### 7.2 文件内部重复（自配对）

基线中以下文件与自己配对，说明单文件内部存在重复块，优先在 P2 拆分时消除：

- `patent-deadline/src/statutes.ts`
- `patent-core/src/adversary/dispute.ts`、`report.ts`
- `patent-core/src/atoms/handlers/builtin/reason.ts`
- `patent-core/src/evidence/judgment.ts`、`notice/grounds.ts`
- `patent-law/src/citator.ts`
- `patent-teams/src/tools.ts`
- `patent-document/src/document/draftSchema/generic.ts`、`tool/verify-deliverable.ts`
- `patent-knowledge/src/patent/patent-kg-adapter.ts`
- `patent-tools/src/figure/dot-builder.ts`、`office-profile.ts`、`tool/figure-input.ts`、`tool/figure-tool-schemas.ts`、`tool/patent-kg-query.ts`
- `legal-evidence/src/evaluators/other-types.ts`、`tool/evaluate-evidence.ts`
- `legal-knowledge/src/types.ts`
- `methodology/src/tool/triz.ts`
- `writing-patterns/src/pattern-store.ts`

## 8. 公共导出面

| 包 | `index.ts` 导出行数 |
|---|---:|
| `patent-tools` | 129 |
| `patent-core` | 89 |
| `patent-knowledge` | 42 |
| `video-mode` | 26 |
| `doc-template` | 25 |
| `tool-literature` | 19 |
| `patent-workflow` | 19 |
| `patent-data` | 19 |
| `patent-rule` | 18 |
| `legal-knowledge` | 17 |

## 9. 跨域依赖

`legal-law` 与 `legal-knowledge` 都依赖 `@deepseek-ai/dsh-patent-core`：

- `legal-knowledge/src/shared/fts.ts`、`fts-search.ts`、`keywords.ts` 是对 `patent-core` 的再导出垫片。
- `legal-law` 的引用解析也直接使用 `patent-core` 的引用工具。

这解释了 7.1 的同构来源：法律域是从专利域派生的。需要决定的是「共享核心放在哪里」，而不是继续复制。

## 10. 门禁状态

| 门禁 | 状态 | 结果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 通过 | 1m7s；node 24.1 触发 engines 警告 |
| `pnpm run duplication` | 通过 | 0 新克隆；基线与清单一致 |
| `pnpm run report:structure` | 通过 | 186 个函数 >150 行；89 个仓库级文件 >800 行 |
| `pnpm run typecheck` / `lint` | 未运行 | D1 不要求；改动前按包运行 |
| `pnpm run test:coverage` | 未运行 | 周度门禁，避免与 D1 冲突 |
| churn 热点 | 不可用 | 仓库仅有 2 个提交，无历史可分析 |

## 11. 采样清单

因无 churn 历史，采样按「公共面 × 规模 × 重复 × 测试密度 × 领域风险」排序。

| 优先级 | 对象 | 理由 |
|---|---|---|
| 1 | `legal-law` ↔ `patent-law` | 同构且已分叉，法律判定一致性风险 |
| 2 | `legal-evidence` ↔ `patent-core/evidence` | 同构评分引擎，规则漂移风险 |
| 3 | `patent-deadline/statutes.ts` | 最大文件，内部重复，法规与计算混排 |
| 4 | `patent-core` 公共面与 `adversary` | 89 个导出；10 处「完整版需模型」TODO |
| 5 | `patent-tools` 工具层与 `figure/` | 51 处 `as unknown`；29 个超长文件 |
| 6 | `video-mode/media.ts` + 三个 provider | 1250 + 910 行；预算与并发语义 |
| 7 | `document-deliver` + `docx-kit` | 测试密度最低；交付可重建性 |
| 8 | `patent-rule` / `patent-workflow` / `patent-teams` | 拒绝路径、状态机、生命周期 |
| 9 | `patent-knowledge` / `legal-knowledge` | 同构类型与查询层；跨域依赖方向 |

## 12. 复采方式

```bash
pnpm run duplication
pnpm run report:structure
find packages/patent packages/legal packages/document \
     packages/experimental/video-mode packages/client/ui-video-studio \
     -path '*/src/*' \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + |
  awk '$2 != "total" && $1 > 400' | sort -rn
grep -rn --include='*.ts' --include='*.tsx' 'as unknown' <scope> | grep -v '/tests/' | wc -l
```
</content>
