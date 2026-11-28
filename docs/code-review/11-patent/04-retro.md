# 收口

执行日期：2026-11-28。本文件是专利域全量审阅（B0–B9）的收口记录：四条验收标准的对照结论、规模与签收证据、剩余风险，以及下一轮应优先处理的事项。

## 四条验收标准的结论

| 标准 | 判据 | 结论 |
|---|---|---|
| 代码质量高 | 每包测试+覆盖率、`tsc -b`、`oxlint`、三个静态校验全绿；本批新增 `v8 ignore` 为 0 | **达成**。九个批次的改动源文件均 100% 覆盖；新增 `v8 ignore` 为 0（`docs/TECH_DEBT.md` 计数未变）；`verify-export-jsdoc`、`verify-no-unknown-casts`、`verify-empty-catch` 全程绿 |
| 无断链 | 运行时 import 命中 `dependencies`；每个 `provideService` 有消费者或书面 waiver；工具数三方一致 | **达成**。B1 修掉两条 `dsh-value` 错置并补 `verify-published-imports`（365 个入口 0 违规）；六个接缝服务全部有消费者；专利工具目录与 `docs/tool-catalog.md` 一致 |
| 能接线 | presets 与装配探针全绿；四个 preset verifier 全绿 | **达成**。`patent-preset-mount.spec.ts` 真实装载 16 个插件行；两个 UI 包在 `web-app/cordis.patch.yml` 挂载且 `slot-catalog` 收录 5 个注册点；`verify-preset-mode-baseline`、`verify-cordis-config`、`verify-agent-preset-config`、`verify-module-graph`、`verify-preset-tool-refs` 全绿 |
| 端到端跑通 | 装配探针断言 fiber active、服务同 realm、工具全集一致、门禁拒绝路径生效；`test:snapshot -t patent` 11 个场景全绿 | **达成**（关键无 key 路径）。装配探针含一条会变红的负控制；11 个 keyless 回放场景全部通过。真实 API 的端到端评测需 `DEEPSEEK_API_KEY`，不在本轮范围 |

## 规模与签收

- 台账 564 行，**全部 signed**，无 `waived`、无 `pending`；覆盖 121,661 行 src。
- 批次分布：B2 59、B3 114、B4 42、B5 21、B6 102、B7 109、B8 94、B9 23。
- 规模从 B0 基线（119,440 行）增长到 121,661 行，全部增长都发生在被审文件内并已重签（`blob_sha` 漂移检查未发现未重签项）。

## 发现分布

100 条发现：**65 条已修**、32 条待决策（[03-decisions.md](03-decisions.md)）、3 条复核为误报或在 B0 单独修复。

按严重度：

- **P0**：0 条。
- **P1**：10 条，**全部已修**。B7 六条（判例检索不收窄类型、`node_type` 别名映射掉真实类型、引用门误拒未索引法律、显式 manifest 失效静默退化、移除成员复活终态任务、审批门缺 handler 被文本顶替）；B8 一条（rule-lock 把已转录的专利法第 71 条报成「未判定」）；B9 两条（DAG 节点几何与 CSS 常量不一致、Teams 标签页逐任务状态只有颜色）；F-PAT-130（15/18 法源未登记 `paragraphs`）于收口后补齐——577 条有条文的条文现全部登记款列表，不存在的款号不再通过核验。
- **P2 / P3**：其余，多为「边界上的成功判定」与「模型可见文案与规则口径」两类。

## 剩余风险

1. **项号仍只报不查**：款号已全量核验，但「第 X 条第 Y 项」仍按条与款判定、项号只回显。需要项级索引或独立检查才能拒绝错项。
2. **F-PAT-157 / F-PAT-158**：需要实机测量（DAG dim 幅度与头像对比度、回溯 400 页的成本）。一次 Web 端实测可同时解决。
3. **F-PAT-079 / F-PAT-122**：两处结构性依赖（跨进程 upsert 无锁、`patent-teams` 只为取一个纯函数而依赖 `patent-tools`），各自独立可做。

## 方法上的记录

- **代理结论必须回源核验**：B9 中三路评审共 33 条候选，采纳 22 条、降级 3 条、否决 1 条（「品牌名与文档标题不一致」——`DEFAULT_CLIENT_TITLE` 早已是 `DSH Patent`）。否决与降级的依据都是仓库里的一手事实，不是判断。
- **「既有模式」不等于「没问题」**：B9 的 `inject` 抛错导致标签退役与 `ui-trajectory` 同构、且有测试断言 fails loud，因此只记观察不记缺陷；但同一批里 .dagNode 的 content-box 几何也被当作既有代码，实测却是真缺陷。两者的差别是**有没有可命名的用户坏结果**。
- **金标重录要先验证能跑**：B9 的 web 金标因 Playwright 被 `display: contents` 祖先误导而无法直接重录。处理方式是把真实渲染跑通（临时改 `attached` 等待）拿到金标，再还原测试文件，并在批次记录里写清原因与范围。
- **覆盖率门禁抓不住的问题**：`stylesheet-scan` 只校验圆角例外表，不检查字重与 token 存在性——21 处 `font-weight > 500` 与一个不存在的 token 都能进主干。这类问题只能由人读出来。
- **改共享引擎要把消费方的测试一起跑**：B7 改了 `patent-workflow` 的结构化耗尽标记与审批门前置校验，只跑了六个接缝包，而作为消费者的 `patent-tools` 有两条 spec 因此一直红着——一条断言 `completed === true`、`degraded === false`（与 B7 的标记直接相反），一条因前置校验提前拦截而走不到它要测的路径。两条都在 B9 收口后跑全量时才暴露。批次按包切分时，「谁 import 这个包」的测试要一并纳入。
- **两个 spec 期望相反时先判断谁的语义对**：上面的语义冲突不是补一条断言能解决的。`revisions[].outcome='exhausted'` 已经是可消费的结构化记录，把「检出缺口」标成 `degraded` 会让它被读成「流程没跑完」，所以修正的是 B7 的判断，不是 `legal_gaps` 的期望。

## 命令与结果

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `pnpm run typecheck` | 0 | 5 个门禁通过 |
| `npx tsc -p tsconfig.client.json` | 0 | Client 面聚合通过 |
| `pnpm vitest run <B9 两包>` | 0 | 4 文件 / 64 用例通过 |
| `pnpm vitest run packages/client/ui-theme` | 0 | 24 文件 / 186 用例通过 |
| `pnpm run verify-client-ui-i18n` | 0 | 1469 个文件 |
| `pnpm run verify-brand-assets` | 0 | 10 资产 / 6 个 mark 源已钉 |
| `pnpm run test:docs` | 0 | 30 门通过 |
| `pnpm run test:snapshot -t patent` | 0 | 11 个 keyless 回放场景全部通过（321 条其余场景按过滤跳过） |

各批次的完整命令与退出码见 [02-batches/](02-batches/) 下对应的文件。
