# Agent Note：案卷条目的阻塞档位与规划轮次上限

Status: implemented

[English](2026-10-12-case-docket-issue-grades-and-round-cap.md) | 中文

## 问题

案卷此前没有一等公民的「问题条目」。复核给回的是散文；案卷清单靠人工勾选，勾错了不会被任何东西拦住。由此有四条后果。问题没有封闭词表，因而没有「类别 → 怎么收口」的映射。无法区分「必须先拿到答案才能继续派工」与「下一轮改掉即可」这两类问题。计划可以无限次重规划。状态机也没有任何依据可以在一问未决时拒绝派工。

2026-09-30 的对照报告（`2026-09-30-patent-domain-external-benchmark.md` 的 P0-2 项）点出了前三条缺口，并对第四条的设计提出警告：二元的阻塞标记是最省事的做法，也是错的，因为它会让每次问人都停摆——包括那些答案此刻并不需要的问题。

## 决定

- `@deepseek-ai/dsh-patent-workflow` 新增 `docket-issue.ts`：一条案卷问题是 `{ id, summary, kind, disposition, status, blocking, round_opened }` 外加可选的 `anchor`。`kind` 是 TS 里的六值封闭词表（`machine_format`、`substantive`、`evidence_gap`、`scope_strategy`、`insufficient_disclosure`、`noise`）；`assets/issue-dispositions.json` 给出每个类别的默认处置与默认阻塞档位，由 `loadIssueDispositions()` 在载入时校验——每个类别恰好一行、取值在词表内、判据非空——不通过则抛 `IssueDispositionError`。`resolveDocketIssue(draft, round, dispositions)` 用该类别那一行补全缺省的处置或档位，状态置 `status: 'open'`，并写入 `round_opened`；条目自带的取值优先于行默认值。
- `blocking` 设三档。`none` 不拦派工，`blocking` 拦住派工直到该条闭合，`terminal` 让本轮只能收在终态。
- 随包默认值按「闭合这条问题实际要付什么代价」定，这正是让第三档不至于变成停摆的原因：可修改克服的缺陷是 `application_fix` 加 `none`，因为下一轮派工正是它的闭合手段；证据缺口是 `ask_human` 加 `blocking`，因为对话的这一侧没人能闭合它；无修改依据的缺陷（公开不充分，或修改超出原始记载范围，专利法第 26 条第 3 款与第 33 条）是 `ask_human` 加 `terminal`；范围与策略取舍是 `ask_human` 加 `none`，因为该问，但不该拦住写作。
- 不变量是三个纯谓词：`openBlockingIssues`（未闭合且不为 `none`）、`openTerminalIssues`（未闭合且为 `terminal`）与 `roundCapReached`。plantask 状态机在迁移守卫上执行它们：存在未闭合阻塞条目时拒绝进入 `executing`，存在未闭合终态条目或轮次已达上限时拒绝进入 `replanning`。被拒的迁移抛 `PlanTaskSemanticError` 并点名条目，与既有守卫一致。`finished` 本就没有出边，故「终态不能再派工」无需新增边。
- 轮次上限是 `Config.maxRounds`，`z.natural()`，默认值由 `resolveWorkflowConfig` 落定一次。达上限后，拒绝反馈不再驱动 `replanning`：计划转至 `finished`，并置 `PlantaskRunResult.roundCapExhausted`。轮次按 `caseId` 计在服务里，计划收到 `finished` 时清零，故同一案卷可以从头再规划。
- 状态机从 `PlanTaskTransitionContext.issues` 读该案卷的条目。省略表示该案卷未登记条目，守卫不据此拒绝——这正是既有调用方（都早于案卷出现）已经满足的契约。
- 同级的 checker schema 已不再随包。`#655` 删除了 `checker-verdict.ts`（`CheckerIssue` 及其解析器）：checker 层只产出散文，因此本工作流自己的条目记录是唯一的条目 schema。

## 考虑过的替代方案

- **把同一目录下的 `CheckerIssue` 扩成案卷的字段集。** 这样模型 JSON 边界上只有一个 schema。它输在两点。该 checker schema 自称复核结论的移植，并把自己的角色定为「模型输出的机读复核结论，它对任务的影响由调用方裁决」——而 `status` 与 `round_opened` 是工作流写的，不是模型能知道的。合并后的字段集还会把两个事实各写两遍：`summary` 与 `description` 并列，`blocking` 与 `severity` 并列，而后者的三档与前者映射到同一个三分。
- **从会话日志里数轮次** —— 事件已经记录了每个状态，计数因此可持久、可跨重启。它输在同步读接口（`snapshotEvents`、`ownEvents`）已弃用且禁止新增调用，而本包不持有会话读路径，要拿到实时状态就得依赖 surface 存储。
- **让状态机自己持有案卷**（在状态机上开 `openIssue` / `closeIssue`，守卫读自己的字段）。这样能彻底消掉「省略 `issues`」这一情形。它输在状态机实例停在服务私有的 `pending` 表里，由它持有的案卷任何产出方都够不着；而迁移上下文是每个状态机调用方本来就要传的入参。
- **把耗尽事实记进 `patent/plantask` 事件。** 该事实改为落在 run 结果上。事件是已声明的持久化类型，改它要配一份确认记录；而耗尽是对调用方的一次运行结论，不是日志必须复现的状态。

## 后果

- 基于条目的拒绝只在调用方给出 `issues` 时生效。产出面是专利工具层的 `patent_plan_task`——模型可见入参由那一层持有：它的 `transition` 入参带 `issues` 与规划轮次 `round`，用随包处置表补全默认值、回显解析后的条目并交给这些守卫。包内的 `runPlantask` 路径仍不传该字段，故它只走没有案卷的那条路径。
- `maxRounds` 按进程计数，不入日志：重启即清零，会话记录里也不带这个计数。计划收到 `finished` 也会清零登记，故上限封的是一轮规划周期，而非一个案卷。
- 案卷不持久化。目前没有任何持久记录承载条目清单，条目的历史长度取决于谁持有它。
- 轮次耗尽不在会话日志里。`patent/plantask` 事件记录的是 `finished` 状态，读者把它与该案卷的轮次一比，也分不出这次终态是封顶还是别的原因。
- `@deepseek-ai/dsh-patent-workflow` 得到了此前没有的 `Config`、对 `@deepseek-ai/schemastery` 的运行时依赖，以及发布 `files` 里的 `assets/`。
- 日后要挪动上限的位置很便宜：守卫只有一次谓词调用，策略只有一个配置字段。

## 测试

- 单元，`packages/patent/patent-workflow/tests/docket-issue.spec.ts`（11 例）：随包资产恰好覆盖词表且取值在词表内、判据非空；默认值让可修改的缺陷不阻塞、让证据缺口阻塞；解析器拒绝缺数组、缺行、词表外的 kind、词表外的取值、空判据与重复行，并在报错里点名来源；`resolveDocketIssue` 补默认值、尊重条目的覆盖、带上锚点，并在处置表缺该类别时拒绝；三个谓词区分三档并忽略已闭合的条目；`roundCapReached` 在上限之下为假、在上限及其之上为真，含 `maxRounds: 0`。
- 状态机，`packages/patent/patent-workflow/tests/plantask.spec.ts`：`blocking 禁止派工` —— 未闭合的阻塞条目与未闭合的终态条目都拒绝 `executing` 且消息里点名该条，而已闭合的、不阻塞的、以及完全没有案卷的三种情形都放行；`轮次上限封顶` —— 达上限的反馈被拒且消息带上限，未达上限的正常重规划，终态条目拒绝 `replanning`。
- 服务，`packages/patent/patent-workflow/tests/service.spec.ts`：同一案卷的三次拒绝都落在 `replanning` 且无耗尽标记，第四次落在 `finished` 且 `roundCapExhausted: true`，此后该案卷可重新起一轮；`maxRounds: 0` 时首次拒绝即收在终态；上限为零不影响 `approve`。
- 工具，`packages/patent/patent-tools/tests/patent-plan-task.spec.ts`：缺 `round` 或非正 `round` 被拒；草案经随包处置表补全并回显；未闭合的阻塞条目拒绝 `executing`，闭合后放行；终态条目或已达上限拒绝 `replanning`；迁移文案渲染解析后的条目。
