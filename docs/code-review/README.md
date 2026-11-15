# 代码审阅计划：专利域 / 文档模式 / 法律模式 / 视频模式

本目录是 2026-11-15 起的四域代码审阅坐标系，覆盖专利域（`packages/patent`）、文档模式（`packages/document`）、法律模式（`packages/legal` 与 `packages/law`）和视频模式（`packages/experimental/video-mode`、`packages/experimental/video-bundle`、`packages/client/ui-video-studio`）。

计划周期默认为 45 天，可缩放到 30 天或拉伸到 60 天；每天投入 1—2 小时，先广度覆盖，再对高风险区深度抽样。本目录只承载审阅文档，不改业务代码、依赖、CI 或基础设施配置。

## 目录

| 文件 | 用途 |
|---|---|
| [00-scope.md](00-scope.md) | 目的、范围、排除项、严重度定义、待确认假设 |
| [01-repo-map.md](01-repo-map.md) | 四域仓库结构地图与入口点 |
| [02-baseline.md](02-baseline.md) | 工具链、测试、覆盖率、安全检查的基线记录 |
| [03-hypotheses.md](03-hypotheses.md) | 本轮 10 条审查假设 |
| [04-daily-plan.md](04-daily-plan.md) | 45 天可缩放计划与每日节奏 |
| [05-findings.md](05-findings.md) | 统一发现清单与记录模板 |
| [06-priority.md](06-priority.md) | 严重度、可能性、紧迫性的排序规则 |
| [07-ci-hardening.md](07-ci-hardening.md) | 把反复出现的问题转为持续防线 |
| [08-retrospective.md](08-retrospective.md) | 复盘模板与下一周期输入 |
| [daily/day-01.md](daily/day-01.md) | 每日一页执行记录；`day-01` 至 `day-45` 同目录，另含计划外补充轮 [day-05b.md](daily/day-05b.md) |

## 每日节奏

每天按同一顺序推进，避免在五个维度之间反复切换：

1. 读昨日记录，确认今日维度、范围与时间盒。
2. 先做广度扫描：列文件、列入口、列外部调用点；只记录结构，不下结论。
3. 再做深度抽样：对高风险表面读实现、追调用链、看测试与错误路径。
4. 把可执行发现写入 [05-findings.md](05-findings.md)，写清位置、证据、影响、最小修复建议、工作量与自动化可行性。
5. 在 `daily/day-NN.md` 记录命令、结果、假设验证和明日第一件事。
6. 收尾时更新 [03-hypotheses.md](03-hypotheses.md) 的状态，不把未验证内容写成结论。

## 当前状态

- Day 1 已完成：仓库状态确认、四域结构地图、工具链与基线初稿、10 条初始假设。
- Day 2–5 已完成：专利核心与外围、文档/法律/共享机制、视频模式的定向；Node 24 下构建 10/10、typecheck 5/5、lint 均通过，覆盖率运行见 OBS-006。
- Day 5b 补充轮已完成：D1–D5 代码质量复审，产出 29 条发现、7 组根因与 5 个修复批次候选，见 [05-findings.md](05-findings.md) 与 [06-priority.md](06-priority.md)。
- 批次 A（复用收口）已实施：原子写 3/4 包、OOXML 限额与文档域插件默认值收口；typecheck、lint 与 5128 个用例通过。这是本计划唯一一次业务代码改动，记录见 [05-findings.md](05-findings.md) 的修复记录。
- 当前进度：Day 1–5 与补充轮完成；下一日为 Day 6（A 安全维度，外部输入到危险汇点）。
- 已确认：45 天周期、包含 `packages/law`、视频按实验特性、在 Node 24 补跑构建与覆盖率基线。
- 本目录的中文单语文档已加入 `scripts/translation-pairing.manifest.json` 的豁免清单；`verify-translation-pairing` 复跑通过。

## Issue 跟踪

远程仓库用 1 个总跟踪 issue 与 7 个阶段 issue 跟踪本计划：

- 总跟踪：[#849 [代码审阅] 四域 45 天计划（跟踪）](https://github.com/xujian519/dsh-patent/issues/849)
- P0 定向与基线（D1–D5）：[#842](https://github.com/xujian519/dsh-patent/issues/842)
- P1 A 安全缺陷（D6–D12）：[#843](https://github.com/xujian519/dsh-patent/issues/843)
- P2 B 代码质量与精简（D13–D19）：[#844](https://github.com/xujian519/dsh-patent/issues/844)
- P3 C 优化（D20–D26）：[#845](https://github.com/xujian519/dsh-patent/issues/845)
- P4 D 测试缺口（D27–D33）：[#846](https://github.com/xujian519/dsh-patent/issues/846)
- P5 E 正确性与边界（D34–D40）：[#847](https://github.com/xujian519/dsh-patent/issues/847)
- P6 收敛（D41–D45）：[#848](https://github.com/xujian519/dsh-patent/issues/848)

每日执行记录仍以 `daily/` 为准；阶段 issue 只跟踪该阶段的范围、检查项与验收。

## 写作约束

- 一段一物理行，避免硬换行。
- 发现条目必须可执行；不确定的内容标记“假设”。
- 不记录任何密钥、token、密码明文；疑似密钥只记文件、行号、类型和“已脱敏”。
- 只引用存在的仓库文件；相对链接以本目录为基准。
