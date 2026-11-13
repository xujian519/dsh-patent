# 代码审阅指标快照 v3（D30）

> 采集时间：2026-11-13；已合入 master 的审查树（含 D26，PR #804）；node v24.19.0 / pnpm 11.28.5。
> 行数是换行数，与 `wc -l` 相同。源码只计 `src/` 下的 `.ts` / `.tsx`，测试只计 `tests/` 下的 `.ts` / `.tsx`。
> 对照 [基线快照 v1](code-review-baseline-v1.md) 与 [指标快照 v2](code-review-metrics-v2.md)。v1 采集于 2026-11-03，v2 采集于 2026-11-11。
> 未合入的 PR #803、#805、#806、#807 不在这棵树上。

## 1. 执行摘要

1. 路径没变的 26 个包，源码 130,057 行 → 132,596 行（+2.0%）。v2 之后这 26 包只多 138 行。
2. `office-to-pdf` 在 2026-11-04 重组为 `office-kit` 与 `tool-office`。v2 的采集分支还停在旧包，所以 v2 的 document 合计仍是 7,208。把 `office-kit`（1,394 行）放回原来的第 27 包位置后，源码是 133,990 行，相对基线 130,713 为 +2.5%。`tool-office` 另计 672 行。
3. **计划里「下降 8%–12%」的规模目标没有达成。** v2 已说明行数下降不适合作为本轮目标；本快照用冻结路径把审查窗口和 Office 重组拆开。
4. 审查范围内超过 400 行的文件 91 → 95 → 97。相对 v2 只多两个文件：`office-kit/src/index.ts`（484）和 `tool-office/src/index.ts`（427）。超过 600 行的仍是 33 个。最大文件是 `video-mode/src/media.ts`，1,250 → 1,265。
5. 类型逃逸没有增加：源码 `as unknown` 65 → 65，分布与 v2 相同。注释里的真实 TODO 仍是 12 处，都在 `patent-core` 的 adversary 模块。
6. 重复实现门禁：0 个仓库级克隆；95 个收紧域配对与 13 个跨域配对与 `scripts/duplication-baseline.json` 一致。v2 的收紧域配对是 94。
7. `packages/legal` 与 `packages/law` 对 `@deepseek-ai/dsh-patent-core` 的引用仍是 0。`law/` 源码仍是 1,885 行，与 v2 相同，继续放在 v1 口径外。

## 2. 冻结口径

v1 的 27 个包里，26 个目录还在原处。比较「审查改了多少」时用这 26 个包。

`document/office-to-pdf` 不再存在。2026-11-04 的 Office 工具重组把它换成 `document/office-kit`，并增加 `document/tool-office`。这组变化单列，不写进 26 包的差额。

`packages/law`（`law-core`、`knowledge-core`）在 v1 之后出现，口径与 v2 相同，单独成行。

## 3. 规模对比

### 3.1 路径未改的 26 个包

| 领域 | 包数 | v1 源码 | v2 源码 | v3 源码 | v2→v3 | v1 测试 | v2 测试 | v3 测试 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| patent | 16 | 109,364 | 111,765 | 111,754 | −11 | 103,577 | 109,243 | 109,226 |
| legal | 3 | 5,446 | 5,446 | 5,514 | +68 | 4,964 | 5,140 | 5,919 |
| document（不含 Office 包） | 4 | 6,552 | 6,552 | 6,618 | +66 | 5,399 | 5,399 | 5,510 |
| video | 3 | 8,695 | 8,695 | 8,710 | +15 | 7,078 | 7,078 | 7,205 |
| **合计** | **26** | **130,057** | **132,458** | **132,596** | **+138** | **121,018** | **126,860** | **127,860** |

patent 的 −11 行全在 `patent-teams`（5,757 → 5,746）。其余 15 个 patent 包的源码行数与 v2 相同。

video 包合计多 15 行，与 `video-mode/src/media.ts` 的 1,250 → 1,265 相同。

legal 的 +68 行源码、+779 行测试，以及 document 四个未改名包的 +66 行源码、+111 行测试，落在 v2 之后合入的 D21–D24 窗口里。

### 3.2 Office 重组

| 包 | v1 源码 | v2 源码 | v3 源码 | v1 测试 | v2 测试 | v3 测试 |
|---|---:|---:|---:|---:|---:|---:|
| `document/office-to-pdf` | 656 | 656 | — | 1,116 | 1,116 | — |
| `document/office-kit` | — | — | 1,394 | — | — | 2,067 |
| `document/tool-office` | — | — | 672 | — | — | 1,003 |

用 `office-kit` 代替原来的第 27 包后，源码合计 133,990（相对基线 +3,277，+2.5%），测试合计 129,927。再把 `tool-office` 的 672 行源码和 1,003 行测试加进去，是这棵树上 document 域的实数：源码 8,684，测试 8,580。

### 3.3 `law/`（v1 口径外）

| 包 | v2 源码 | v3 源码 | v2 测试 | v3 测试 |
|---|---:|---:|---:|---:|
| `law/law-core` | 1,443 | 1,443 | 667 | 667 |
| `law/knowledge-core` | 442 | 442 | 435 | 435 |
| 合计 | 1,885 | 1,885 | 1,102 | 1,102 |

### 3.4 相对 v2 有源码行数变化的包

| 包 | v2 源码 | v3 源码 | 差 | v3 测试文件 |
|---|---:|---:|---:|---:|
| `patent/patent-teams` | 5,757 | 5,746 | −11 | 18 |
| `legal/legal-evidence` | 1,695 | 1,727 | +32 | 7 |
| `legal/legal-knowledge` | 2,286 | 2,305 | +19 | 10 |
| `legal/legal-law` | 1,465 | 1,482 | +17 | 6 |
| `document/doc-template` | 2,222 | 2,259 | +37 | 12 |
| `document/docx-kit` | 1,720 | 1,749 | +29 | 7 |
| `document/office-kit` | — | 1,394 | 新路径 | 11 |
| `document/tool-office` | — | 672 | 新路径 | 3 |
| `experimental/video-mode` | 7,276 | 7,291 | +15 | 16 |

`ui-video-studio` 的测试是 3 个 `.ts` 加 1 个 `.tsx`。v1 的包表记 4，v2 的测试文件列只数了 `.ts`，所以写成 3。测试行数仍是 974，与 v1、v2 的 video 合计相符。

## 4. 复杂度对比

统计范围是第 2 节的审查目录（patent、legal、document、law、video 三包），含 Office 新路径。

| 指标 | v1 | v2 | v3 |
|---|---:|---:|---:|
| >400 行文件 | 91 | 95 | 97 |
| >600 行文件 | 29 | 33 | 33 |
| 最大单文件 | 1,304（`patent-deadline/src/statutes.ts`） | 1,250（`video-mode/src/media.ts`） | 1,265（`video-mode/src/media.ts`） |
| `patent-tools` >400 行文件 | 29 | 32 | 32 |
| `patent-core` >400 行文件 | 19 | 20 | 20 |

相对 v2 的 95 个超长文件，没有文件掉出名单。新增的两个就是 Office 新路径上的 `office-kit/src/index.ts` 与 `tool-office/src/index.ts`。两者都不到 600 行，所以 >600 的个数不变。

v3 范围内最大的 10 个源文件：

| 文件 | 行数 |
|---|---:|
| `experimental/video-mode/src/media.ts` | 1,265 |
| `patent/patent-tools/src/figure/freecad-structure-script.ts` | 1,233 |
| `patent/patent-tools/src/tool/patent-workflow-run.ts` | 1,028 |
| `patent/patent-tools/src/figure/render-check-findings.ts` | 988 |
| `patent/patent-workflow/src/workflow/manifests.ts` | 953 |
| `patent/patent-tools/src/figure/section-diagram.ts` | 918 |
| `experimental/video-mode/src/comfyui.ts` | 910 |
| `patent/patent-tools/src/figure/leader-line.ts` | 908 |
| `patent/patent-core/src/atoms/handlers/builtin/evidence-check.ts` | 842 |
| `patent/patent-tools/src/figure/dot-builder.ts` | 839 |

`statutes.ts` 仍不在表内。D10 拆分之后它不再是最大文件。

仓库级 `pnpm run report:structure` 扫的是全部 `packages/`，含审查范围以外的上游代码：7,330 个文件（其中测试 3,320、生成文件 4）；189 个函数超过 150 行；96 个非生成源文件超过 800 行，另有 3 个生成文件超过同一门槛。v1 的对应数字是 6,907 个文件、186 个函数、89 个源文件。这组数字不拿来判定「超长文件 ≤ 60」。

## 5. 类型安全对比

| 指标 | v1 源码 | v2 源码 | v3 源码 | v1 测试 | v2 测试 | v3 测试 |
|---|---:|---:|---:|---:|---:|---:|
| `as unknown` | 65 | 65 | 65 | 103 | 103 | 103 |
| 含 `: any` 的行 | 3 | 3 | 3 | 5 | 5 | 3 |
| `@ts-ignore` / `@ts-expect-error` | 0 | 0 | 0 | 0 | 0 | 0 |

源码 `as unknown` 分布与 v2 相同：`patent-tools` 51、`patent-teams` 4、`tool-literature` 4、`patent-core` 4、`document-deliver` 2。

源码里 3 行 `: any` 都是英文句子，不是类型注解：`legal-law` 两处，`doc-style` 一处。测试里 3 行是 `legal-evidence` 夹具中的字符串 `check: any`。v2 的测试列是 5 行，本快照按同一种子串数到 3 行。

## 6. 标记对比

注释行里的 TODO / FIXME / XXX 仍是 12 处，全部在 `patent-core/src/adversary/` 与 `atoms/handlers/builtin/adversary-review.ts`，主题仍是确定性骨架、完整版需要模型注入。

另外 3 处是字面量，不是未处置项：`patent-document` 的合规扫描正则、`patent-tools` 的占位标记、`doc-style` 的占位符表。与 v2 的分类相同。

## 7. 测试密度对比（测试行数 / 源码行数）

| 包 | v3 | v2 |
|---|---:|---:|
| `law/law-core` | 0.46 | 0.46 |
| `document/docx-kit` | 0.62 | 0.61 |
| `patent/patent-index-asset` | 0.68 | 0.68 |
| `client/ui-video-studio` | 0.69 | 0.69 |
| `document/doc-style` | 0.72 | 0.72 |
| `patent/patent-core` | 0.74 | 0.74 |
| `patent/patent-deadline` | 0.76 | 0.76 |
| `experimental/video-mode` | 0.84 | 0.82 |
| `legal/legal-evidence` | 0.89 | 0.74 |
| `law/knowledge-core` | 0.98 | 0.98 |

`legal-evidence` 从 0.74 升到 0.89，测试行数 1,248 → 1,530。其余低密度包与 v2 差在 0.02 以内。密度只作采样信号，不代替逐文件覆盖率。

## 8. 重复实现对比

| 指标 | v1 | v2 | v3 |
|---|---:|---:|---:|
| 仓库级新克隆 | 0 | 0 | 0 |
| 收紧域配对 | 91 | 94 | 95 |
| 跨域配对 | 14 | 13 | 13 |

`pnpm run duplication`：3,853 个文件、795,924 行、0 个克隆。`pnpm exec tsx scripts/duplication-gate.ts`：0 个仓库级克隆；95 个收紧域配对与 13 个跨域配对与基线文件相符。收紧域比 v2 多 1 对，跨域配对没有回升。

## 9. 公共导出面对比

v2 比较过的六个 `src/index.ts` 导出行，v3 一行没变：

| 包 | v2 导出行 | v3 导出行 |
|---|---:|---:|
| `patent/patent-tools` | 131 | 131 |
| `patent/patent-core` | 75 | 75 |
| `patent/patent-knowledge` | 42 | 42 |
| `document/doc-template` | 25 | 25 |
| `experimental/video-mode` | 26 | 26 |
| `legal/legal-knowledge` | 17 | 17 |

这里数的是以 `export` 开头的行，不是导出名集合。

## 10. 跨域依赖对比

v3 与 v2 相同：`legal-law` 依赖 `@deepseek-ai/dsh-law-core`，`legal-knowledge` 依赖 `@deepseek-ai/dsh-knowledge-core`。`packages/legal` 与 `packages/law` 的源码和 `package.json` 里都没有 `@deepseek-ai/dsh-patent-core`。

## 11. 本快照跑过的命令

| 命令 | 状态 | 结果 |
|---|---|---|
| `pnpm run duplication` | 通过 | 0 克隆；3,853 文件，795,924 行 |
| `pnpm exec tsx scripts/duplication-gate.ts` | 通过 | 0 仓库级克隆；95 + 13 对与基线一致 |
| `pnpm run report:structure` | 通过 | 189 个函数 >150 行；96 个非生成源文件 >800 行 |
| `pnpm run build:artifacts` / `build:check` / 定向测试 / 快照 / `test:coverage` | 未运行 | D29 的门禁记录在 PR #807，测的是并入 #804 之前的树。本快照不把那组用例数写成含 D26 的结果 |

## 12. 与计划判据的差异

| 判据 | v3 结果 |
|---|---|
| 范围内源码下降 8%–12% | 未达成。26 个未改路径的包 +2.0%；用 `office-kit` 填回第 27 包后 +2.5%。 |
| 超长文件 ≤ 60 个 | 未达成（97）。相对 v2 的增量是 Office 重组的两个文件。 |
| 最大单文件 ≤ 800 行 | 未达成（1,265）。`patent-tools` 仍有 5 个文件超过 900 行。 |
| 未处置标记 ≤ 20 | 达成（12 处真实 TODO）。 |
| 重复基线下降且不新增 clone | 达成（0 克隆；跨域配对 14 → 13，v2 之后没有回升）。 |
| 覆盖率不低于基线 | 本快照未跑 `test:coverage`。已合入改动的逐文件门槛由当时的 PR 与 CI 承担。 |
| P0 缺陷 0 个未关闭 | 达成。R-01、R-02 都已关闭。登记册现为 93 项：已关闭 29、已确认 60、待验证 4。 |
| 公共契约无未声明破坏性变更 | 达成。本结项不新建升级指南。已有指南见结项报告。 |

结项结论、未合入的 PR 和下一轮建议写在 [结项报告](code-review-closeout.md)。

## 13. 复采方式

```bash
pnpm run duplication
pnpm exec tsx scripts/duplication-gate.ts
pnpm run report:structure
find packages/patent packages/legal packages/document packages/law \
     packages/experimental/video-mode packages/experimental/video-bundle \
     packages/client/ui-video-studio \
     -path '*/src/*' \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + |
  awk '$2 != "total" && $1 > 400' | sort -rn
```
