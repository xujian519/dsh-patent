# 45 天执行计划

默认 45 天，每天 1—2 小时。阶段按“定向 → A–E 五维轮换 → 收敛”排列，不在五维之间反复切换。

## 阶段总览

| 阶段 | 天数 | 维度 | 目标 |
|---|---|---|---|
| 定向与基线 | Day 1—5（含补充轮 Day 5b） | 结构、入口、工具链 | 建立地图、基线与假设；补充轮把结构观察落实为 B 维度发现 |
| A 安全缺陷 | Day 6—12 | 授权、输入汇点、密钥、依赖 | 找可利用路径 |
| B 代码质量与精简 | Day 13—19 | 死代码、抽象、复杂度 | 找可删除与可合并 |
| C 优化 | Day 20—26 | 慢路径、索引、资源生命周期 | 找有证据的性能问题 |
| D 测试缺口 | Day 27—33 | 未测、弱断言、happy path | 找高风险未覆盖面 |
| E 正确性与边界 | Day 34—40 | 错误处理、类型边界、不变量 | 找错误结论与静默降级 |
| 收敛 | Day 41—45 | 去重、排序、门禁、复盘 | 产出可执行队列与下一周期输入 |

## 远程跟踪

- 总跟踪：[#849](https://github.com/xujian519/dsh-patent/issues/849)
- 阶段 issue：[#842](https://github.com/xujian519/dsh-patent/issues/842)（P0）、[#843](https://github.com/xujian519/dsh-patent/issues/843)（P1）、[#844](https://github.com/xujian519/dsh-patent/issues/844)（P2）、[#845](https://github.com/xujian519/dsh-patent/issues/845)（P3）、[#846](https://github.com/xujian519/dsh-patent/issues/846)（P4）、[#847](https://github.com/xujian519/dsh-patent/issues/847)（P5）、[#848](https://github.com/xujian519/dsh-patent/issues/848)（P6）
- 每日执行记录以 `daily/` 为准；阶段 issue 不替代日卡。

## 缩放规则

- 30 天紧凑版：定向 3 天，A–E 每维 4 天，收敛 3 天。
- 45 天默认版：定向 5 天，A–E 每维 7 天，收敛 5 天。
- 60 天从容版：定向 6 天，A–E 每维 9 天，收敛 6 天；多出的天数用于深度抽样与交叉验证。

## 每日固定节奏（60—120 分钟）

| 时段 | 动作 | 产出 |
|---|---|---|
| 0—10 分钟 | 读昨日记录，确认今日范围 | 今日检查项 |
| 10—40 分钟 | 广度扫描：列文件、入口、外部调用点 | 结构笔记 |
| 40—90 分钟 | 深度抽样：读实现、追调用链、看测试 | 发现候选 |
| 90—110 分钟 | 写发现与证据 | 05-findings.md 条目 |
| 110—120 分钟 | 更新假设与明日第一件事 | daily/day-NN.md |

## 45 天表

| 天 | 日期 | 阶段 | 维度 | 审查范围 | 时间盒 |
|---|---|---|---|---|---|
| 1 | 2026-11-15 | 定向与基线 | 定向与基线 | 仓库状态、目录结构、四域包清单、工具链、CI 阶段、测试入口 | 120 分钟 |
| 2 | 2026-11-16 | 定向与基线 | 定向与基线 | 专利域核心入口：patent-tools、patent-core、patent-workflow | 90 分钟 |
| 3 | 2026-11-17 | 定向与基线 | 定向与基线 | 专利域外围：patent-rule、patent-law、patent-fees、patent-deadline、patent-document、patent-filing、patent-knowledge、patent-data、patent-teams、writing-patterns、methodology、tool-literature | 120 分钟 |
| 4 | 2026-11-18 | 定向与基线 | 定向与基线 | 文档模式、法律模式与共享机制：document 6 包、legal 3 包、law 2 包 | 120 分钟 |
| 5 | 2026-11-19 | 定向与基线 | 定向与基线 | 视频模式入口与基线补全：video-mode、video-bundle、ui-video-studio | 120 分钟 |
| 6 | 2026-11-20 | A 安全缺陷 | A 安全缺陷 | 专利域-1：patent-data、patent-tools 的外部输入到危险汇点 | 90 分钟 |
| 7 | 2026-11-21 | A 安全缺陷 | A 安全缺陷 | 专利域-2：patent-knowledge、patent-rule、patent-law、patent-fees | 90 分钟 |
| 8 | 2026-11-22 | A 安全缺陷 | A 安全缺陷 | 专利域-3：patent-workflow、patent-teams、patent-document、patent-filing | 90 分钟 |
| 9 | 2026-11-23 | A 安全缺陷 | A 安全缺陷 | 文档模式：office-kit、docx-kit、doc-template、doc-style、document-deliver、tool-office | 90 分钟 |
| 10 | 2026-11-24 | A 安全缺陷 | A 安全缺陷 | 法律模式与共享机制：legal-knowledge、legal-law、legal-evidence、law-core、knowledge-core | 90 分钟 |
| 11 | 2026-11-25 | A 安全缺陷 | A 安全缺陷 | 视频模式：video-mode、video-bundle、ui-video-studio | 90 分钟 |
| 12 | 2026-11-26 | A 安全缺陷 | A 安全缺陷 | 横向复核：密钥、凭据、依赖与 A 维度汇总 | 90 分钟 |
| 13 | 2026-11-27 | B 代码质量与精简 | B 代码质量与精简 | 专利域-1：patent-tools、patent-core | 90 分钟 |
| 14 | 2026-11-28 | B 代码质量与精简 | B 代码质量与精简 | 专利域-2：patent-workflow、patent-rule、patent-teams | 90 分钟 |
| 15 | 2026-11-29 | B 代码质量与精简 | B 代码质量与精简 | 专利域-3：patent-knowledge、patent-data、patent-document、patent-filing、writing-patterns | 90 分钟 |
| 16 | 2026-11-30 | B 代码质量与精简 | B 代码质量与精简 | 文档模式全域 | 90 分钟 |
| 17 | 2026-12-01 | B 代码质量与精简 | B 代码质量与精简 | 法律模式与共享机制全域 | 90 分钟 |
| 18 | 2026-12-02 | B 代码质量与精简 | B 代码质量与精简 | 视频模式全域 | 90 分钟 |
| 19 | 2026-12-03 | B 代码质量与精简 | B 代码质量与精简 | B 维度横向复核与汇总 | 90 分钟 |
| 20 | 2026-12-04 | C 优化 | C 优化 | 专利域-1：patent-tools、patent-core 的热点路径 | 90 分钟 |
| 21 | 2026-12-05 | C 优化 | C 优化 | 专利域-2：patent-knowledge、patent-data | 90 分钟 |
| 22 | 2026-12-06 | C 优化 | C 优化 | 专利域-3：patent-workflow、patent-teams | 90 分钟 |
| 23 | 2026-12-07 | C 优化 | C 优化 | 文档模式：office-kit、docx-kit、doc-template、document-deliver | 90 分钟 |
| 24 | 2026-12-08 | C 优化 | C 优化 | 法律模式与共享机制：legal-knowledge、legal-law、legal-evidence、law-core、knowledge-core | 90 分钟 |
| 25 | 2026-12-09 | C 优化 | C 优化 | 视频模式：video-mode、ui-video-studio | 90 分钟 |
| 26 | 2026-12-10 | C 优化 | C 优化 | C 维度横向：子进程、临时文件、监听器、取消与并发 | 90 分钟 |
| 27 | 2026-12-11 | D 测试缺口 | D 测试缺口 | 专利域-1：patent-tools、patent-core | 90 分钟 |
| 28 | 2026-12-12 | D 测试缺口 | D 测试缺口 | 专利域-2：patent-workflow、patent-rule、patent-teams | 90 分钟 |
| 29 | 2026-12-13 | D 测试缺口 | D 测试缺口 | 专利域-3：patent-knowledge、patent-data、patent-document、patent-filing | 90 分钟 |
| 30 | 2026-12-14 | D 测试缺口 | D 测试缺口 | 文档模式、法律模式与共享机制 | 90 分钟 |
| 31 | 2026-12-15 | D 测试缺口 | D 测试缺口 | 视频模式全域 | 90 分钟 |
| 32 | 2026-12-16 | D 测试缺口 | D 测试缺口 | 跨域失败路径：网络、权限、磁盘、部分写入 | 90 分钟 |
| 33 | 2026-12-17 | D 测试缺口 | D 测试缺口 | 覆盖率豁免审计与 D 维度汇总 | 90 分钟 |
| 34 | 2026-12-18 | E 正确性与边界 | E 正确性与边界 | 专利域-1：patent-tools、patent-core | 90 分钟 |
| 35 | 2026-12-19 | E 正确性与边界 | E 正确性与边界 | 专利域-2：patent-workflow、patent-rule、patent-teams | 90 分钟 |
| 36 | 2026-12-20 | E 正确性与边界 | E 正确性与边界 | 专利域-3：patent-knowledge、patent-data、patent-law、patent-fees、patent-deadline | 90 分钟 |
| 37 | 2026-12-21 | E 正确性与边界 | E 正确性与边界 | 专利域-4 与文档模式：patent-document、patent-filing、document 全域 | 90 分钟 |
| 38 | 2026-12-22 | E 正确性与边界 | E 正确性与边界 | 法律模式与共享机制 | 90 分钟 |
| 39 | 2026-12-23 | E 正确性与边界 | E 正确性与边界 | 视频模式全域 | 90 分钟 |
| 40 | 2026-12-24 | E 正确性与边界 | E 正确性与边界 | 跨域：错误处理、静默降级、模型可见性与会话日志一致性 | 90 分钟 |
| 41 | 2026-12-25 | 收敛 | 收敛 | 去重与合并 | 90 分钟 |
| 42 | 2026-12-26 | 收敛 | 收敛 | 优先级排序 | 90 分钟 |
| 43 | 2026-12-27 | 收敛 | 收敛 | CI 门禁建议定稿 | 90 分钟 |
| 44 | 2026-12-28 | 收敛 | 收敛 | 交叉验证 | 90 分钟 |
| 45 | 2026-12-29 | 收敛 | 收敛 | 复盘与下一周期 | 90 分钟 |

## 每日收尾检查

- 今日发现是否都有位置、证据、影响、最小修复建议、工作量与自动化可行性？
- 是否更新了 [03-hypotheses.md](03-hypotheses.md) 的状态？
- 是否在 `daily/` 写了“明日第一件事”？
- 是否避免了在未运行的命令上写“已运行”？
