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
| [08-retrospective.md](08-retrospective.md) | 四张复盘表与下一周期建议 |
| [10-tool-metrics-plan.md](10-tool-metrics-plan.md) | 下一周期：十项工具调用指标的 45 天计划；执行记录写 `metrics/`，不改 `daily/` |
| [daily/day-01.md](daily/day-01.md) | 每日一页执行记录；`day-01` 至 `day-45` 同目录，另含计划外补充轮 [day-05b.md](daily/day-05b.md) |
| [metrics/day-01.md](metrics/day-01.md) | 工具指标的执行记录与试点题库；`day-01` 至 `day-45` 同目录，20 题在 [metrics/pilot-questions.md](metrics/pilot-questions.md)。D9–D12 的直接调用记录从 [metrics/day-09.md](metrics/day-09.md) 起 |

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
- 批次 A（复用收口）已实施：原子写 3/4 包、OOXML 限额与文档域插件默认值收口；typecheck、lint 与 5128 个用例通过。记录见 [05-findings.md](05-findings.md) 的修复记录；批次 A2 与随后的修复批次见 [06-priority.md](06-priority.md) 的批次执行状态。
- Day 6 已完成：A 安全维度第一轮（patent-data、patent-tools 的外部输入到危险汇点），新增 3 条发现；其中两条安全发现已修复。
- Day 7 已完成：专利域-2（SQL/FTS 参数化、资产路径、引用核验失败方向），新增 1 条发现；SQL 与资产路径均无问题。
- Day 8 已完成：专利域-3（HITL 审批、团队身份边界、模板注入），新增 1 条发现；团队身份与模板注入无问题，审批存在后台绕过路径。
- Day 9 已完成：文档模式 A 维度，未发现可执行缺陷；office-kit 的临时目录与清理、docx-kit 的解压边界、doc-template 的注入面均已处理。
- Day 10 已完成：法律模式与共享机制的 A 维度，未发现可执行缺陷；SQL 参数化、索引路径与未核验策略均 fail closed。
- Day 11 已完成：视频模式 A 维度，新增 1 条发现；ffmpeg 注入面与 provider 下载已处理，成本账本可被模型改写。
- Day 12 已完成：A 维度横向收尾，密钥扫描 0 命中、凭据不落日志、外部件仅 4 个成熟包；A 维度共 7 条发现（3 已修、4 未修）。
- Day 13 已完成：B 维度专利域-1（`patent-tools`、`patent-core`），新增 5 条发现并全部给出净减少量；死代码、未导出模块与未使用配置为零，claim/draft/rule 的 jscpd 克隆为 0，H01 判为推翻（不需要搬迁）。
- Day 14 已完成：B 维度专利域-2（`patent-workflow`、`patent-rule`、`patent-teams`），新增 3 条发现；状态机、两套存储、审批 seam、规则加载与转发面均判为非重复，重复集中在插件默认值与事件载荷。
- Day 15 已完成：B 维度专利域-3（`patent-knowledge`、`patent-data`、`patent-document`、`patent-filing`、`writing-patterns`），新增 5 条发现并把 F-PAT-024 扩到七个包；provider/mapper/cache 与写作范式的选择/编译均判为非重复，重复集中在子进程骨架、安全名判定与短函数。
- Day 16 已完成：B 维度文档模式全域（`docx-kit`、`office-kit`、`doc-template`、`doc-style`、`document-deliver`、`tool-office`），新增 1 条发现并给出净减少量；ZIP/OOXML 读写、模板变量与样式投影、office-kit 队列与磁盘存储、document-deliver 的三层职责均判为非重复，唯一重复是跨模块请求类型按字段重写。
- Day 17 已完成：B 维度法律模式与共享机制全域（`legal-evidence`、`legal-knowledge`、`legal-law`、`knowledge-core`、`law-core`），新增 4 条发现并给出净减少量；YAML 资产读取、引用文法与工具注册、SQLite+FTS 索引均判为非重复，`knowledge-core` 的跨域原语有 5–13 个消费者，分叉只在引擎骨架层（数据驱动 vs 抽象模板），因此不合并；4 类兼容层候选（两处空 `override search`、构造归一、`shared/` 再导出文件）逐个判定后全部保留。
- Day 18 已完成：B 维度视频模式全域（`video-mode`、`video-bundle`、`ui-video-studio`），新增 3 条发现并给出净减少量；`cloud-common`/`minimax-common` 的凭据、错误分类与下载已单源，未收口的是 submit/poll 骨架（ignore 标记掩盖，拷贝已漂移）、`messageOf` 三份与失败助手异序；工具动作分发与 sibling studio 骨架均判为非重复，重复集中在客户端第二份文档文法与 store 的写路径骨架。
- Day 19 已完成：B 维度横向复核与汇总。D13–D18 的 21 条新发现连同 2 条跨域发现按修法收敛为四簇（固定前导/尾部、schema 双源、同一概念多接受集、共享原语未复用），新增 2 条跨域发现：F-CROSS-001（四域另有 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有原语）与 F-CROSS-002（`patent-tools` 导入未声明的 `dsh-value`，`verify-package-dependencies` 只校验「声明→使用」方向，运行产物靠打包内联掩盖）；净减少去重后合计 −487~−572 行，按「零架构风险 → 需人工确认 → 需形态决策」切成 4 个批次；四域 63 条零外部提及导出中零死代码（62 条为多余 `export`、1 条为已登记的公开面）；preset 实为 8 个而非 4 个、56 个不同包，四道 preset 门禁已覆盖漂移，H09 判为推翻。
- Day 20 已完成：C 维度专利域-1（`patent-tools`、`patent-core`）。`benchmarks/` 没有专利用例（OBS-008），本地用合成文本测了规则评估、说明书校验、权利要求形式检查、IPC 索引与 `cloneState`。全量 125 条规则对约 4 万字的热调用中位数 10.67ms，默认输出门禁 14 条为 7.15ms；没有新的 C 维度发现。Day 19 关于「四份状态读取器等于四次全量解析」的交接不成立。
- Day 21 已完成：C 维度专利域-2（`patent-knowledge`、`patent-data`）。查询库是默认目录下的 `knowledge-lite.db`（81551 篇文档、144188 个分块）。FTS 命中中位数 75.15ms；8ms 假加载的缓存命中是 0ms。热路径索引都在，EXPLAIN 走查找。新增 F-PAT-032：判例零命中或凑不满条数的短查询会整表解压 LIKE，实测 4.57 秒与 4.77 秒。
- Day 22 已完成：C 维度专利域-3（`patent-workflow`、`patent-teams`）。工作流结束时写一次运行结果，1601397 字节的合成结果落盘中位数 11.01ms。团队由事件唤醒，没有轮询循环。一次状态投影的磁盘部分中位数 3.12ms。没有新的 C 维度发现。
- Day 23 已完成：C 维度文档模式（`office-kit`、`docx-kit`、`doc-template`、`document-deliver`）。约 40 万字的文书渲染单次 22.09ms，80MB 输出读取中位数 8.65ms。取消路径会杀掉本次 helper 并删除临时目录。H03 改为取消与异常路径未发现泄漏。没有新的 C 维度发现。
- Day 24 已完成：C 维度法律模式与共享机制（`legal-knowledge`、`legal-law`、`legal-evidence`、`law-core`、`knowledge-core`）。本机没有默认查询库。合成 40000 条法规的零命中中位数 8.47ms，20000 条判例 18.73ms。民法典首次解析 63.32ms，同一索引再取 0.02ms。没有新的 C 维度发现。
- Day 25 已完成：C 维度视频模式（`video-mode`、`ui-video-studio`）。运行时默认 250ms 醒一次，云 provider 的状态间隔是 2 秒或 10 秒；1000ms 窗口里桩状态接口只打了 1 次。8MiB 下载热中位数 0.68ms。睡眠脚本在中止后 217.69ms 退出，进程不在。没有新的 C 维度发现。
- Day 26 已完成：C 维度横向（子进程、临时文件、监听器、取消与并发）。配合退出的子进程在宽限 5000 下 32.88ms 以 SIGTERM 结束；忽略 SIGTERM 的子进程在宽限 400 下 435.3ms 以 SIGKILL 结束，进程不在。16 个立即退出的脚本 44.41ms。C 维度仅有的新发现仍是 F-PAT-032。
- Day 27 已完成：D 维度专利域-1（`patent-tools`、`patent-core`）。两包不在覆盖率豁免内。渲染与立案的失败、取消、超时已有分类断言。新增 F-PAT-033（渲染截止期的监听清理没有用例）和 F-PAT-034（成功下载后不检查清单 sha1）。
- Day 28 已完成：D 维度专利域-2（`patent-workflow`、`patent-rule`、`patent-teams`）。三包不在覆盖率豁免内。审批拒绝、运行恢复和规则失败路径已有断言。新增 F-PAT-035（团队等待的 abort 监听没有用例）和 F-PAT-036（未完成依赖没有锁住失败、取消和进行中）。
- Day 29 已完成：D 维度专利域-3（`patent-knowledge`、`patent-data`、`patent-document`、`patent-filing`）。四包不在覆盖率豁免内。空索引、损坏库、CNIPR 与缓存失败、立案内容校验已有断言。新增 F-PAT-037（PDF 渲染的宽限与 abort 监听没有用例）和 F-PAT-038（nuo 检索 provider 的抛错没有用例）。
- Day 30 已完成：D 维度文档模式、法律模式与共享机制。11 个包不在覆盖率豁免名单里。Office 失败与取消、DOCX 限额、空语料、未核验判定和证据缺字段已有断言。新增 F-DOC-007（Office 转换成功后的 abort 监听没有用例）和 F-LEG-010（未核验引用的处置没有锁住）。
- Day 31 已完成：D 维度视频模式全域（`video-mode`、`video-bundle`、`ui-video-studio`）。三包不在覆盖率豁免名单里。EDL 失败、provider 失败与超时、预算拒绝、项目锁冲突和界面渲染失败已有断言。没有新的 D 编号。
- Day 32 已完成：D 维度跨域失败路径（网络、权限、磁盘、部分写入）。超时、取消和权限拒绝已有断言。磁盘满没有单独的 `ENOSPC` 分支。新增 F-CROSS-003（知识库安装覆盖时先删输出，改名失败没有用例）。
- Day 33 已完成：D 维度覆盖率豁免审计与汇总。重套件豁免、平台排除和 Windows、pwsh 排除都不含四域。639 个四域 `src` 文件里，门禁不量的是 19 个包根 `types.ts` 和 1 个安装 `bin.ts`。没有新的 D 编号。D27–D32 的 9 条新缺口都在已纳入门禁的文件里。H06 改为部分推翻，H08 改为推翻。
- Day 34 已完成：E 维度专利域-1（`patent-tools`、`patent-core`）。新增 F-PAT-039 至 F-PAT-046。同一句权利要求在引用解析与 lint 解析里独立／从属结论相反；空 quote、所引权项缺少要素、同一格互相矛盾的映射，都会写出单篇全覆盖。未提取到技术问题时，阻断级法条缺口记为通过。H01–H10 不改。
- Day 35 已完成：E 维度专利域-2（`patent-workflow`、`patent-rule`、`patent-teams`）。新增 F-PAT-047 至 F-PAT-050。审批门中断后的续跑从第一个阶段重跑（复核旧登记 R-77），8 个内置 manifest 的门都在最后一级，门前 7–26 个阶段连同检索与模型调用会重复执行；通知书解析不出驳回理由时两条双输入规则判为通过；结构门禁与引用门禁不核对 `textArgs`，声明写错即静默放行；重规划把重复步骤全部判为已完成。H01–H10 不改。
- Day 36 已完成：E 维度专利域-3（`patent-knowledge`、`patent-data`、`patent-law`、`patent-fees`、`patent-deadline`）。新增 F-PAT-051 至 F-PAT-055。沿革快照按条号套到所有法律，实施细则条文取到专利法同号条的生效日与状态；指南 1241 个未修改节在 rule-lock 判已修订／已失效、在 law_verify 判已核验；费用工具把单一 `lateMonths` 套到每个年费年度；`designatedMonths` 可把驳回决定的 3 个月复审期缩成 1 个月；上游 JSON 含 null 元素时 `mapPatentData` 抛错。H01–H10 不改。
- Day 37 已完成：E 维度专利域-4 与文档模式（`patent-document`、`patent-filing`、document 全域）。新增 F-DOC-008 至 F-DOC-010。同一模板的 Markdown 只出一个标题、HTML 与 DOCX 出两个一级标题；DOCX 渲染的 Markdown 表格把转义竖线拆成新列，并把整行破折号当分隔行丢弃；`document_deliver` 的占位符判定不识别 HTML 代码块、注释与属性，代码示例被阻断。R-87（验收读取 DOCX 无归档预算）仍开放。H01–H10 不改。
- Day 38 已完成：E 维度法律模式与共享机制（`legal-evidence`、`legal-knowledge`、`legal-law`、`law-core`、`knowledge-core`）。新增 F-LEG-011 至 F-LEG-014。证人利害关系省略时关键规则报「证人与案件无利害关系」通过；电子数据与证人证言的 `formLegal: false` 在合法性评分中被忽略；法规检索先取 2 倍上限再按时间效力过滤，SQLite 与内存后端给出不同结果；默认判定日期取 UTC，与中国法域自然日相差 8 小时。F-LEG-001、F-LEG-002、F-LEG-004、F-LEG-010 仍开放。H01–H10 不改。
- Day 39 已完成：E 维度视频模式全域（`video-mode`、`video-bundle`、`ui-video-studio`）。新增 F-VID-011 至 F-VID-015。同一工程的并发生成会各自通过余额检查再分别结算，账本总额可超过预算；provider 被移除或记录被拒绝后 journal 没有工具侧清理路径；`status` 对 `artifacts: []` 的成功任务照常记账并清 journal；`init` 的绝对路径与其余动作的原始路径让同一工程在 studio 出现两次；EDL 音频区间的反向顺序晚到 ffmpeg 才失败。H04 的 Day 39 验证点完成：重复计费不成立，预算不变量部分成立；其余假设不改。
- Day 40 已完成：E 维度跨域（错误处理、静默降级、模型可见性与会话日志一致性）。新增 F-CROSS-004：四域中只有视频域的工具错误类接入 `HarnessError`，其余七个带 `code` 的错误类在 `tool/result.error` 与轨迹界面里只剩文案。模型可见面逐项对齐：系统提示、工具 schema、用户/合成上下文、工具调用与结果、专利工具内模型调用都有会话事件；外部 provider 原始响应与视频 journal 不是模型可见面，残留缺口只有 F-PAT-010。H07、H10 改为部分确认；D34–D40 的 E 维度共 29 条新编号，加本条 30 条，已按六个主题汇总并列出当时的合并候选。
- Day 41–42 已完成（缩短收敛，2026-11-17，对照 Merge PR #886）：不重测已修条目。Day 40 的六个合并组里，对比表、门禁缺输入与法律证据未知值三组已落地，沿革组只剩 F-PAT-051。下一轮要改代码的 E 项改为 confirmed。F-PAT-002、F-LEG-001、F-DOC-001 的总表对齐为 fixed。剩余队列在 [06-priority.md](06-priority.md)。
- Day 43 已完成（2026-11-18）：CI 门禁建议定稿。12 条建议逐条裁定——采纳 7 条、部分已落地 2 条、降级为可选观察 1 条、拒绝 2 条；拒绝依据是 H08、H09 已被推翻，降级依据是 H03 已被推翻且本机无 LibreOffice。`verify-patent-core-exports` 记为「导出面消费者校验」的部分落地。见 [07-ci-hardening.md](07-ci-hardening.md)。
- Day 44 已完成（2026-11-18）：抽样 10 条回到源码取证（P0 全取、P1 按域各取、另取 1 条 deferred）。9 条仍成立、1 条维持 deferred、误报 0。见 [daily/day-44.md](daily/day-44.md) 与 [05-findings.md](05-findings.md) 的「Day 44 抽样复核」。
- Day 45 已完成（2026-11-18）：复盘四张表填完。98 条发现、修复率 57%、误报 0、根因型 19 条；假设命中 1 条、部分命中 5 条、推翻 4 条。下一周期建议为专利域 30 天紧凑版、维度顺序改为先 E 后 B。见 [08-retrospective.md](08-retrospective.md)。
- 当前进度：D1–D45 全部完成，共 98 条编号发现，60 条已修复、38 条未修。未修 38 条按 P0 0 / P1 6 / P2 26 / P3 6 分布，分派顺序见 [06-priority.md](06-priority.md) 的「未修条目打分（Day 44）」与「批次 R-F1 首轮修复」。下一周期的范围、天数与待确认事项见 [08-retrospective.md](08-retrospective.md)。
- 工具指标周期：P0 已完成；P1 直接调用通过线在 [metrics/day-12.md](metrics/day-12.md)；P2 脚本场景（D13–D22）的闭环与恢复基线是 10/14 与 12/12，10/14 不是通过线，F-PAT-056 只登记。基线见 [metrics/script-baseline.md](metrics/script-baseline.md)，执行记录从 [metrics/day-13.md](metrics/day-13.md) 起。
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

修复队列另有跟踪 issue：[#916 [代码审阅] 修复队列（跟踪）：四域 45 天计划余下 38 条](https://github.com/xujian519/dsh-patent/issues/916)。审阅周期已于 2026-11-18 执行完毕，此后各批修复在 #916 上跟踪，直到未修条目处置完毕。

每日执行记录仍以 `daily/` 为准；阶段 issue 只跟踪该阶段的范围、检查项与验收。

## 下一周期：工具调用指标

工具调用指标的 45 天计划以 [10-tool-metrics-plan.md](10-tool-metrics-plan.md) 为准，总跟踪是 [#931](https://github.com/xujian519/dsh-patent/issues/931)，P0 契约与题库是 [#932](https://github.com/xujian519/dsh-patent/issues/932)，P1 直接调用记录是 [#933](https://github.com/xujian519/dsh-patent/issues/933)，P2 脚本场景基线是 [#934](https://github.com/xujian519/dsh-patent/issues/934)。执行记录写 `metrics/`，与源码审阅的 `daily/` 不互相替代；`daily/` 在本周期不改。通过线写在 [metrics/day-12.md](metrics/day-12.md)，不回填计划文件里的空位。脚本场景的 10/14 不是这条通过线。

## 写作约束

- 一段一物理行，避免硬换行。
- 发现条目必须可执行；不确定的内容标记“假设”。
- 不记录任何密钥、token、密码明文；疑似密钥只记文件、行号、类型和“已脱敏”。
- 只引用存在的仓库文件；相对链接以本目录为基准。
