# Day 1 — 2026-11-15

## 今日维度与范围

- 维度：定向与基线
- 范围：仓库状态、目录结构、四域包清单、工具链、CI 阶段、测试入口
- 时间盒：120 分钟
- 预期产出：01-repo-map.md、02-baseline.md、03-hypotheses.md、daily/day-01.md

## 检查项

- [x] 确认工作树干净、当前分支与 HEAD。
- [x] 统计四域包数、src 行数与测试文件数。
- [x] 记录 Node、pnpm、oxlint、Vitest、外部工具版本与可用性。
- [x] 记录 typecheck、lint、test、coverage、build 的命令与未跑原因。
- [x] 建立仓库地图初稿、基线初稿与 10 条初始假设。

## 实际执行

Day 1 的实际命令与结果见 [02-baseline.md](../02-baseline.md) 的“命令与结果”表。摘要如下：

| 命令 | 退出码 | 结果摘要 |
|---|---|---|
| `git status --short` | 0 | 空，工作树干净 |
| `git ls-files \| wc -l` | 0 | 33335 个跟踪文件 |
| `node -v` | 0 | v22.22.3，低于 engines 下限 |
| `pnpm -v` | 0 | 11.28.5 |
| `oxlint --version` | 0 | 1.81.0 |
| `vitest --version` | 0 | 4.1.11 |
| `pnpm audit --json` | 1 | `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS` |
| `pnpm exec vitest run packages/law/knowledge-core/tests/result-limit.spec.ts` | 0 | 1 个测试文件、2 个用例通过 |

初始未执行：完整 typecheck、lint、test、coverage、build。同日经用户确认在 Node 24（v24.19.0）下补跑：

| 命令 | 退出码 | 结果摘要 |
|---|---|---|
| `pnpm run build:native-system` | 0 | native 构建成功 |
| `pnpm run build` | 0 | 10/10 gate 通过，118.04s |
| `pnpm run test:coverage` | 1 | 13 个测试失败；`ERROR: Coverage` 为 0；548.82s |

失败分类与限制见 [02-baseline.md](../02-baseline.md) 的“Node 24 构建与覆盖率基线”一节。

## 发现

代码级发现：暂无。Day 1 只建立基线。

观察：OBS-001 至 OBS-006，见 [05-findings.md](../05-findings.md) 的观察列表。OBS-005 已于同日按用户确认加入 manifest 豁免，复跑通过；OBS-001 已随 Node 24 构建通过关闭，覆盖率缺口记为 OBS-006。

## 假设验证/推翻

初始假设 H01—H10 已建立，Day 1 未做代码级验证。H01、H05、H10 可在 Day 2 起开始验证。

## 未决问题

1. 覆盖率基线需在 CI 覆盖率 lane 或提高测试超时后复跑，以获取百分比。
2. 13 个环境相关失败中，HMR watch-config 与 plugin-market git 两条仍需单独复核。

## 明日第一件事

Day 2：读 patent-tools、patent-core、patent-workflow 的入口与外部调用点，补全专利域核心数据流。
