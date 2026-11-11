# 代码审阅指标快照 v2（D20）

> 采集时间：2026-11-11；分支 `refactor/knowledge-core-d20`（基于 `fix/law-d18-citation-numerals`）；node v24.19.0 / pnpm 11.28.5。
> 统计口径与 [基线快照 v1](code-review-baseline-v1.md) 相同：`src/` 下 `.ts` / `.tsx` 行数，测试单独统计。
> v1 采集于 2026-11-03（分支 `trae/agent-gGNODt`）。两版之间仓库同时在做功能开发，因此规模差同时包含「审查轮修掉的」与「期间新增的」。

## 1. 执行摘要

1. 基线范围内的 27 个包，源码 130,713 行 → 133,114 行（+1.8%）；测试 122,134 行 → 127,976 行（+4.8%）。**计划里「下降 8%–12%」的规模目标没有达成**，原因见 §2.1。
2. 2026-11-06 新增的 `law/` 组（领域中立法条引用库 + 知识库查询库）不在 v1 口径内，单独计 1,885 行源码、1,102 行测试。
3. 最大单文件从 1,304 行（`patent-deadline/src/statutes.ts`）降到 1,250 行（`video-mode/src/media.ts`）；原先的最大文件已在 D10 拆掉。
4. 超长文件（>400 行）91 → 95，>600 行 29 → 33：审查轮修掉了最大的那几个，同时期内新增的图形与工作流代码更长。
5. 类型逃逸没有增加：源码 `as unknown` 65 → 65，`: any` 3 → 3，`@ts-ignore` 0 → 0。
6. 重复实现门禁：0 个仓库级克隆；94 个收紧域配对与 13 个跨域配对与基线一致。
7. 跨域依赖倒置已收口：`legal-knowledge` 对 `patent-core` 的引用归零。

## 2. 规模对比

### 2.1 领域合计

| 领域 | 包数 | v1 源码 | v2 源码 | 差 | v1 测试 | v2 测试 | 差 |
|---|---:|---:|---:|---:|---:|---:|---:|
| patent | 16 | 109,364 | 111,765 | +2,401 | 103,577 | 109,243 | +5,666 |
| legal | 3 | 5,446 | 5,446 | 0 | 4,964 | 5,140 | +176 |
| document | 5 | 7,208 | 7,208 | 0 | 6,515 | 6,515 | 0 |
| video | 3 | 8,695 | 8,695 | 0 | 7,078 | 7,078 | 0 |
| **基线范围合计** | **27** | **130,713** | **133,114** | **+2,401（+1.8%）** | **122,134** | **127,976** | **+5,842（+4.8%）** |
| law（v1 口径外） | 2 | — | 1,885 | 新增 | — | 1,102 | 新增 |

**规模目标为何没有达成**：审查窗口不是冻结窗口。期内专利域新增了图形与 FreeCAD 结构脚本（`patent-tools/src/figure/freecad-structure-script.ts` 762 → 1,233 行）、工作流运行工具（858 → 1,028 行）等功能；同一窗口内审查轮修掉的是缺陷与重复（D16–D19 共关闭 22 项风险，其中 R-03 让 1,304 行的 `statutes.ts` 消失），而这些修复本身也写入了新的用例。**行数下降不是本轮的目标函数**：本轮的可核查产出是关闭的风险项、判定一致性与依赖方向，行数指标更适合在 D30 用冻结口径复采。

### 2.2 单包明细（v1 口径 27 个包）

| 包 | v1 源码 | v2 源码 | 差 | v1 测试文件 | v2 测试文件 |
|---|---:|---:|---:|---:|---:|
| `patent/patent-tools` | 37,012 | 40,098 | +3,086 | 114 | 120 |
| `patent/patent-core` | 33,793 | 32,630 | −1,163 | 100 | 100 |
| `patent/patent-teams` | 5,552 | 5,757 | +205 | 16 | 18 |
| `patent/patent-rule` | 5,382 | 5,418 | +36 | 30 | 30 |
| `patent/patent-workflow` | 4,612 | 4,726 | +114 | 26 | 27 |
| `patent/patent-knowledge` | 3,806 | 3,817 | +11 | 21 | 21 |
| `patent/patent-document` | 3,723 | 3,730 | +7 | 26 | 26 |
| `patent/patent-law` | 2,838 | 2,835 | −3 | 15 | 16 |
| `patent/patent-deadline` | 2,816 | 2,803 | −13 | 10 | 11 |
| `patent/tool-literature` | 2,370 | 2,383 | +13 | 13 | 13 |
| `patent/patent-data` | 2,261 | 2,319 | +58 | 14 | 14 |
| `patent/patent-fees` | 1,516 | 1,556 | +40 | 6 | 7 |
| `patent/writing-patterns` | 1,347 | 1,347 | 0 | 10 | 10 |
| `patent/patent-filing` | 1,334 | 1,330 | −4 | 11 | 12 |
| `patent/methodology` | 626 | 632 | +6 | 6 | 7 |
| `patent/patent-index-asset` | 376 | 384 | +8 | 1 | 2 |
| `legal/legal-knowledge` | 2,246 | 2,286 | +40 | 9 | 9 |
| `legal/legal-evidence` | 1,695 | 1,695 | 0 | 5 | 5 |
| `legal/legal-law` | 1,505 | 1,465 | −40 | 5 | 6 |
| `document/doc-template` | 2,222 | 2,222 | 0 | 12 | 12 |
| `document/document-deliver` | 1,789 | 1,789 | 0 | 2 | 2 |
| `document/docx-kit` | 1,720 | 1,720 | 0 | 7 | 7 |
| `document/doc-style` | 821 | 821 | 0 | 5 | 5 |
| `document/office-to-pdf` | 656 | 656 | 0 | 4 | 4 |
| `experimental/video-mode` | 7,276 | 7,276 | 0 | 16 | 16 |
| `experimental/video-bundle` | 2 | 2 | 0 | 1 | 1 |
| `client/ui-video-studio` | 1,417 | 1,417 | 0 | 4 | 3 |

新增的 `law/` 组：`law-core` 1,443 行（法条引用内核，D18 前从 `patent-core` 迁出）、`knowledge-core` 442 行（知识库查询内核，D20 从 `patent-core` 迁出）。

`patent-core` 的 −1,163 行 = 迁往 `law-core` 的 1,443 行 − 期内新增 ≈280 行；`patent-law` 的 −3 行与 `legal-law` 的 −40 行来自 D18 的判定表共享。

## 3. 复杂度对比

| 指标 | v1 | v2 |
|---|---:|---:|
| >400 行文件 | 91 | 95 |
| >600 行文件 | 29 | 33 |
| 最大单文件 | 1,304（`patent-deadline/src/statutes.ts`） | 1,250（`video-mode/src/media.ts`） |
| `patent-tools` >400 行文件 | 29 | 32 |
| `patent-core` >400 行文件 | 19 | 20 |

v2 范围内最大的 10 个源文件：

| 文件 | 行数 |
|---|---:|
| `experimental/video-mode/src/media.ts` | 1,250 |
| `patent/patent-tools/src/figure/freecad-structure-script.ts` | 1,233 |
| `patent/patent-tools/src/tool/patent-workflow-run.ts` | 1,028 |
| `patent/patent-tools/src/figure/render-check-findings.ts` | 988 |
| `patent/patent-workflow/src/workflow/manifests.ts` | 953 |
| `patent/patent-tools/src/figure/section-diagram.ts` | 918 |
| `experimental/video-mode/src/comfyui.ts` | 910 |
| `patent/patent-tools/src/figure/leader-line.ts` | 908 |
| `patent/patent-core/src/atoms/handlers/builtin/evidence-check.ts` | 842 |
| `patent/patent-tools/src/figure/dot-builder.ts` | 839 |

> `statutes.ts` 已不在表内：D10 把它拆为「数据 / 计算 / 查询」，文件降到 800 行以内。

## 4. 类型安全对比

| 指标 | v1 源码 | v2 源码 | v1 测试 | v2 测试 |
|---|---:|---:|---:|---:|
| `as unknown` | 65 | 65 | 103 | 103 |
| `: any` | 3 | 3 | 5 | 5 |
| `@ts-ignore` / `@ts-expect-error` | 0 | 0 | 0 | 0 |

源码 `as unknown` 分布（v2）：`patent-tools` 51、`patent-teams` 4、`tool-literature` 4、`patent-core` 4、`document-deliver` 2。审查轮没有新增逃逸；R-05 的 51 处集中在 `patent-tools`，仍按 D11 的边界分类等待专项 PR。

## 5. 标记对比

v1 记 10 处真实 TODO（集中在 `patent-core/src/adversary/` 与其原子处理器）。v2 用「注释行含 TODO/FIXME/XXX，排除字符串字面量与占位符模式」的口径重数，得 12 处，全部在同一模块，主题一致（当前是确定性骨架，完整版需要模型注入）；另有 3 处是占位符清单里的字面量（`patent-document` 的合规扫描正则、`patent-tools` 的占位标记、`doc-style` 的占位符表），不是未处置项。

## 6. 测试密度对比（测试行数 / 源码行数）

| v2 最低 | 比值 | v1 对应比值 |
|---|---:|---:|
| `law/law-core` | 0.46 | 新增 |
| `document/docx-kit` | 0.61 | 0.61 |
| `patent/patent-index-asset` | 0.68 | 0.27 |
| `client/ui-video-studio` | 0.69 | 0.69 |
| `document/doc-style` | 0.72 | 0.72 |
| `legal/legal-evidence` | 0.74 | 0.74 |
| `patent/patent-core` | 0.74 | 0.71 |
| `patent/patent-deadline` | 0.76 | 0.67 |
| `law/knowledge-core` | 0.98 | 新增 |

`patent-index-asset` 从 0.27 升到 0.68（D8 的索引读取边界用例），`patent-deadline` 从 0.67 升到 0.76（D10 的边界测试集）。`law/knowledge-core` 的 0.98 与 `law/law-core` 的 0.46 分别是新包与其后继：两个中立库的测试分别跟随其迁出的用例，`law-core` 的比值低是因为 D18 把判定表与用例一起搬了过去，而它此前在 `patent-core` 的分母里。

## 7. 重复实现对比

| 指标 | v1 | v2 |
|---|---:|---:|
| 仓库级新克隆 | 0 | 0 |
| 收紧域配对 | 91 | 94 |
| 跨域配对 | 14 | 13 |

`pnpm run duplication` 与 `scripts/duplication-gate.ts` 均通过：0 个仓库级克隆，94 个收紧域配对与 13 个跨域配对与 `scripts/duplication-baseline.json` 相符。跨域配对少 1 对，来自 D19 的查询入口对齐（法律侧不再与专利侧并列一份垫片实现）。

## 8. 公共导出面对比

| 包 | v1 `index.ts` 导出行 | v2 `index.ts` 导出行 |
|---|---:|---:|
| `patent/patent-tools` | 129 | 131 |
| `patent/patent-core` | 89 | 75 |
| `patent/patent-knowledge` | 42 | 42 |
| `document/doc-template` | 25 | 25 |
| `experimental/video-mode` | 26 | 26 |
| `legal/legal-knowledge` | 17 | 17 |

`patent-core` 的导出行减少 14 行，导出名一个没少：迁出的 18 个符号改为从 `dsh-knowledge-core` 一次性转导出。迁移前后按同一方法提取的导出名集合都是 578 个，差集为空。

## 9. 跨域依赖对比

v1：`legal-law` 与 `legal-knowledge` 的 `dependencies` 含 `@deepseek-ai/dsh-patent-core`。

v2：`legal-law` 依赖 `@deepseek-ai/dsh-law-core`；`legal-knowledge` 依赖 `@deepseek-ai/dsh-knowledge-core`；`packages/legal/*` 与 `packages/law/*` 对 `@deepseek-ai/dsh-patent-core` 的引用数为 **0**。专利域不依赖法律域，方向单向且正确。

## 10. 门禁状态

| 门禁 | 状态 | 结果 |
|---|---|---|
| `pnpm run typecheck` | 通过 | 5 passed，0 failed（45.8s） |
| `pnpm run lint` | 通过 | 0 errors |
| 定向测试（knowledge-core / patent-core / patent-knowledge / legal-knowledge / patent-tools） | 通过 | 见执行卡 §62；1 个失败为基线分支同样存在的环境问题（`patent-knowledge/tests/bin.spec.ts` 在 vitest 模块运行器里取不到 `import.meta.resolve`） |
| 新包覆盖率 | 通过 | `packages/law/knowledge-core/src/**` 逐文件语句、分支、函数均 100% |
| `pnpm run duplication` | 通过 | 0 克隆；94 + 13 对与基线一致 |
| `pnpm run doc-sync` | 通过 | 53 passed，0 failed |
| `pnpm run test:coverage` | 未运行 | 周度门禁，CI 负责全量覆盖 |

## 11. 与基线结论的差异

| v1 判据 | v2 结果 |
|---|---|
| 范围内源码下降 8%–12% | 未达成（+1.8%）。窗口内并行做功能开发；该判据需要冻结口径才有意义，改为 D30 用冻结快照复采。 |
| 超长文件 ≤ 60 个 | 未达成（95）。图形与工作流族的新代码更长，D12 的分层拆分方案尚未落地。 |
| 最大单文件 ≤ 800 行 | 未达成（1,250）。最大文件已从专利域移到 video 域；`patent-tools` 仍有 5 个文件超 900 行。 |
| 未处置标记 ≤ 20 | 达成（12 处真实 TODO）。 |
| 重复基线下降且不新增 clone | 达成（0 克隆；跨域配对 14 → 13）。 |
| 覆盖率不低于基线 | 达成（新增代码逐文件 100%）。 |
| P0 缺陷 0 个未关闭 | 达成（R-01 已关闭；R-02 属 D21–D23 范围）。 |
| 公共契约无未声明破坏性变更 | 达成（`patent-core` 导出名不变；本轮是新增包，非破坏性变更，无需升级指南）。 |

## 12. 复采方式

```bash
pnpm run duplication
pnpm run report:structure
find packages/patent packages/legal packages/document packages/law \
     packages/experimental/video-mode packages/experimental/video-bundle \
     packages/client/ui-video-studio \
     -path '*/src/*' \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + |
  awk '$2 != "total" && $1 > 400' | sort -rn
grep -rn --include='*.ts' --include='*.tsx' 'as unknown' <scope> | grep -v '/tests/' | wc -l
```
