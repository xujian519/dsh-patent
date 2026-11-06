# Agent Note：拆分七个上帝文件（Issue #86）

Status: implemented

[English](2026-09-14-god-file-split-plan.md) | 中文

## Problem

Issue #86 要求拆分 `packages/` 下体量过大的文件。它的清单列了十二个文件（生成文件已由 issue 自身排除），并按体量从大到小排序：

| 文件 | 行数 | 形态 | 本 note |
| --- | --- | --- | --- |
| `packages/client/connection` 的 `src/client/fixture.ts` | 2288 | 随包发布的浏览器模式 provider（不是测试夹具） | 在 |
| `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` | 693 | 一份账本，行与检查器均已抽出 | 在 |
| `packages/typert/generator/src/analyzer.ts` | 1253 | 落在抽出的类型图与 Remote/RPC 分析器之上的包分析器 | 在——两刀均已落地 |
| `packages/experimental/code-runtime-python/src/index.ts` | 364 | 插件本体：注册、binding 校验、脚本落盘 | 在——两半均已落地 |
| `packages/core/session/src/index.ts` | 488 | store：发布协议、生命周期与 fork 路径 | 在 |
| `packages/core/tool-executor-ptc/src/ptc.ts` | 372 | 单个工具工厂，调度车道已抽出 | 在 |
| `packages/acp/acp/src/index.ts` | 503 | 单个 341 行的 `apply` | 在 |
| `state.ts`（better-sidebar，已删除） | 1900 | 克隆中心 | 不在 |
| `Sidebar.tsx`（better-sidebar，已删除） | 1775 | 克隆中心 | 不在 |
| `packages/core/tools/src/index.ts` | 1913 | ToolRuntime 加五个职责 | 不在 |
| `packages/self-evolve/self-evolve-basic/src/index.ts` | 1857 | 自审计以来持平 | 不在 |
| `packages/subagent/subagent/src/manager.ts` | 1475 | 上游的托管 activation 重写替换了这个 fork 模块 | 不在——issue 自行销案 |

五个条目在本 note 之外，各有一条明写的理由，而不是被略过。`continuation.ts` 已收敛，issue 自身建议销案；该文件随后随上游 v0.2.1-alpha.2 的 manager 重构删除。`better-sidebar` 的 `state.ts` 与 `Sidebar.tsx` 被 issue 点为克隆中心：它们的正解是去重，而切割两个本就互为镜像的文件，只会把一处文件内克隆变成一处跨文件克隆——那项工作属 M1 去重族，不在这里。`core/tools/src/index.ts` 与 `self-evolve-basic/src/index.ts` 已到或低于 issue 记录的行数，而本 note 自己的标准——每一刀都要由「某个测试变得可行」「某个接口变得显式」「某个方法变得可读」之一来证成——对它们尚无答案；它们留在 issue 上，而不是在没有理由的情况下进入某个批次。行数在每刀落地时实测，最近一次为 2026-09-15：即试点、会话折叠提取、fixture RPC 派发表提取、ptc 调度池提取、会话对象提取、行组件提取、analyzer 类型图提取、python 配置门禁提取、python 子进程监管器提取与 analyzer 的 Remote/RPC 分析器提取之后。

对在范围的七个文件的结构调研发现：**体量并不是它们难以拆分的原因**。每一个都有肉眼可见的切口——模块级纯函数、已经抽出的辅助函数、读者能看到的段落边界。它们真正缺的，是**切口边界该归谁**这个问题的定论；而且其中几个带着明确的契约，粗暴拆分会让它们悄无声息地失效：

- `code-runtime-python` 原有两个 `/* jscpd:ignore-start */` 块，其注释声明这些块与兄弟 worker-thread 后端保持形状平行：构造／teardown／run 形状，以及定时器／abort／live 集合那一块。2026-09-15 逐个移除块的标记实测：第一处仍在压制真实克隆（去掉它就有 24 行、88 token 与兄弟后端的构造与 teardown 相同），第二处则什么都压制不住——两个后端的定时器、abort 监听与 live-run 记录已不再逐 token 相同。第二对标记已在其区域搬入 `src/supervisor.ts` 时撤除，只留下声明该平行关系的注释；第一处未动且仍承重。`fixture.ts` 不含这样的块；该包唯一的一处在 `fixture-projections.ts`，它镜像宿主时序而不 import 目标实现。
- `fixture.ts` 故意重新实现宿主行为而不去 import，以免一个 Web 客户端包染上宿主依赖。任何靠 import 来「去重」的拆分，都会把宿主包拖进客户端 bundle——正是这个文件被写出来要避免的退步。
- `code-runtime-python` 没有 `src/types.ts`，因此切出来的碎片本应共享的词汇无家可归；而给它安家会撞上 Issue #99 已经记录在案的例外。`ui-trajectory` 本来也没有，并在其批次 1 那一刀中新建了一个，与 `analyzer` 的做法相同。
- 测试经由源码路径导入内部符号（`code-runtime-python/tests/runtime.spec.ts` 从 `../src/index.ts`；`ui-trajectory/tests/table.client.spec.tsx` 从 `../src/client/TrajectoryTable.tsx`），所以拆分必须让入口模块保持今天这份再导出。

这几个问题放着不管，每一次评审都要重新吵一遍，而且答案会在文件之间漂移。按体量排序还指错了方向：最大的那个文件恰恰是最不该先切的安全项之一。

## Decision

四个边界问题一次定死，每个批次都照用；批次的排序依据是「一次切割需要保住多少行为」。

### 贯穿所有批次的四条规则

1. **`jscpd:ignore` 块是双向契约。** 切一侧就必须在同一次改动里切另一侧，或者显式修订那段注释、说明对称为何不再成立。这适用于 `code-runtime-python` ↔ `code-runtime-worker-thread`（构造／teardown／run 形状，以及定时器／abort／live 集合那一块），也适用于其余每个 `jscpd:ignore` 块所指名的兄弟。
2. **`fixture.ts` 是镜像，不是 import。** 它的切割在文件**内部**提取。任何会让它 import 宿主包的改动都在范围之外，无论那样能去掉多少重复。
3. **新的共享词汇落在 `src/types.ts`。** 包缺这个文件时，创建它是第一个需要共享词汇的那个批次的一部分，并在改动中援引 Issue #99 关于运行期值可居于其中的例外。入口模块继续再导出它今天导出的一切。
4. **保不住入口模块导出清单的切口，不是批次 1 的切口。** 搬运入口再导出的符号没问题；丢掉一个不行。

### 批次 1 —— 按构造即保行为的提取

每一项搬运的都是本已自足的代码：无实例状态、无新接口、无行为变更。入口模块保持再导出。

| 包 | 切口 | 行数（估算 → 实际） |
| --- | --- | --- |
| `code-runtime-python` | 字节计价与截断词汇 → `src/cost.ts`；日志台账 → `class OutputLedger` | ~200、~270 → 131、619 |
| `ui-trajectory` | 记录投影层 → `trajectory-record-model.ts`；六个展示辅助族各自落文件；共享的 record 词汇 → 新建 `src/types.ts` | ~260、~1050 → 248、1045，另加 94 行的 `types.ts` |
| `core/session` | 校验器与头部处理 → `validation.ts` | ~365 → 345 |
| `analyzer` | 节点文本辅助、`package.json` exports 解析、路径工具 | 各 ~250 → 397、111、201，另加 26 行的 `types.ts` |
| `acp` | cursor codec 簇 | ~56 → 75 |
| `ptc` | JSON 展示簇；flavor 表与解析器 | ~90、~107 → 103、110 |

试点选 `code-runtime-python`，因为它的台账切口握有全仓库最有力的一条证据：兄弟后端 `packages/code-runtime/code-runtime-worker-thread/src/index.ts` 已经有一个抽好的 `OutputLedger`。两者可以对拍同一组边界案例；而且该包只导出 `.` 且为 `private: true`，已发布面不可能移动。[字节计价与日志台账提取 note](../../implemented/simplification/2026-09-14-code-runtime-python-cost-and-ledger.zh.md) 记录了这一刀的产出与代价。

### 批次 2 —— 需要先把接口定形的切割

- `code-runtime-python`：fd-3 帧读取器[已落地](../../implemented/simplification/2026-09-14-code-runtime-python-frame-reader.zh.md)，其帧回调只携带重建后的帧——没有任何消费者读取帧的原始字节长度，因此本条原本预计需要的协议并未建立；台账与 `log` 帧分支之间的契约是双向的，因为该分支要回报「已发生截断」。
- `ui-trajectory`：inspector `<aside>`[已落地](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md)为 `RecordInspector`（~550 行，约 10 个值 + 4 个回调），其 pointer-capture 拖拽抽成 `useResizeHandle`。
- `core/tools` 的 `ptc.ts` 与 `acp/acp`：批次 1 的提取把它们缩短之后，那两个超大方法剩下的主体。`ptc.ts` 的那部分成为下面批次 3 的调度池切口；`acp` 的 `apply` 仍为 341 行。
- `fixture.ts`：历史脚本 `buildAlphaLog` 与投影 fold 家族均已[落地](../../implemented/simplification/2026-09-14-fixture-history-module-extraction.zh.md)。内存文件系统也已[落地](../../implemented/simplification/2026-09-14-fixture-file-system-module-extraction.zh.md)，并为该文件定下了本批次那个接口问题的答案：一个簇把世界的值作为参数收进来，自己持有它改动的状态。各自捕获一个世界状态绑定的三个 remote 簇，也依那个模板[落地](../../implemented/simplification/2026-09-14-fixture-configuration-remotes-extraction.zh.md)了，而该模板的退化情形是零参数工厂。`rpc` 派发表则[落地](../../implemented/simplification/2026-09-14-fixture-rpc-dispatch-extraction.zh.md)在一份 `FixtureRpcDeps` 清单之后，该清单位于其成员类型所在之处；`fixture.ts` 为 2288 行。

### 批次 3 —— 压在语义上的切割，逐项附证据

这些直到能证明自己保住了什么才落地。

- `ptc.ts` 调度池：有序提交车道、独占屏障、背压、唤醒顺序防御全是行为，不是结构。[已落地](../../implemented/simplification/2026-09-15-ptc-dispatch-pool-extraction.zh.md)至 `src/ptc-dispatch-pool.ts`——`DispatchPool` 接收 `{ maxParallel, isRunOver }`，传输层负责提交、登记附带工作与排空，`tests/ptc-dispatch-pool.spec.ts` 用八个用例直接驱动该车道；`ptc.ts` 为 372 行。
- `core/session`：三个增量折叠已[落地](../../implemented/simplification/2026-09-14-session-folds-extraction.zh.md)到 `src/folds.ts`——`SessionFolds` 按引用接收日志数组与 surface，`Session` 保留三个一行委派，`index.ts` 为 904 行。`Session` 类已[落地](../../implemented/simplification/2026-09-15-session-object-extraction.zh.md)到 `src/session.ts`，并带上必须与它同址的 `attachments`/`SessionEntry` 对；两条发布路径都要用的两个监听器分发 helper 落 `src/observers.ts`。`@typert object` 类型字符串在 store 的注册里逐字不变，`index.ts` 为 488 行。
- `code-runtime-python`：配置门禁[已落地](../../implemented/simplification/2026-09-15-python-config-gates-extraction.zh.md)到 `src/config.ts`——`Config`、门禁所检查的上限、`resolveRuntimeConfig`、`resolveInterpreter`、`resolvePythonBin`、`hostFrameParseCeiling` 与 `pythonEnvironment`——进程监管器[已落地](../../implemented/simplification/2026-09-15-python-child-supervisor-extraction.zh.md)到 `src/supervisor.ts`：`superviseChildRun` 经 `ChildRunDeps` 接收单次运行的入参，掌管 spawn、fd-3 帧、回复通道、定时与中止接线、信号升级与结算。`index.ts` 为 364 行，接线块的 `jscpd` 标记在这里经实测撤除（它们没有压制任何克隆）。
- `ui-trajectory`：行渲染器[已落地](../../archived/simplification/2026-09-15-trajectory-row-extraction.md)为 memo 组件 `TrajectoryRow`，其选中、节与时间线聚焦标记都是账本算好的原语，三条用例数行渲染次数以钉住本条点名的那个风险边界。该模块已随 2026-11-04 的上游同步删除；行渲染现在位于 `TrajectoryTable.tsx` 内。
- `analyzer`：`Remote`/RPC 分析器与类型建模器在批次 2 待过一阵后回到批次 3，而把它们搬回来的那次阅读就是它们此前缺的证据。`allocateNodeId` 造出的是 `type:<文件>:<行>:<列>#<序号>`，序号是按位置计数的计数器，每次调用加一，因此一个 id 是**某个源码位置上的访问次序**的函数，而不是那个类型的函数。有两处让这个次序难以预测：`resolvedRemoteCodecType` 在它自己的 `convert` 闭包内、对着自己的 `completed`/`active` 两份缓存做分配——同一个书写位置会按缓存未命中的次序产出 `#1`、`#2`、`#3`；`convertType` 在递归之前就分配，于是共享 `getStart()` 的一个 union 及其首个成员，其次序由调用次序而非结构决定。两个簇写的是同一批五个 Map（`nodes`、`declarations`、`declarationStates`、`crossFaceLinks`、`nodeOrdinals`），而 `ensureDeclaration` 跨调用重入，靠 `declarationStates` 一道守卫挡着。`tests/__snapshots__/type-model.spec.ts.snap` 记录了这些 id 的 578 处出现，其中 282 个互不相同，因此一次重排会重命名 id，并以快照 diff 而非失败的形式出现。在补上一个钉住 `allocateNodeId` 的 id 稳定性、且覆盖它必须经受的那种重排的测试之前，这一刀不开始。已[钉住](../../implemented/testing/2026-09-15-node-id-stability.zh.md)：`tests/node-id-stability.spec.ts` 手写钉住两个 fixture 里每一处同址位置，并写出「哪个类型拿到了该序号」。[已落地](../../implemented/simplification/2026-09-15-analyzer-type-graph-extraction.zh.md)：类型建模器现在是 `src/type-graph.ts`（`class TypeGraph`，875 行），它拥有 `nodes`、`declarations`、`declarationStates` 与 `nodeOrdinals`，对外经 `declarationModels()`、`nodeModels()`、`setNode()` 与 `setDeclaration()` 暴露，并持有 id 分配以及两处原本直接够到这些 map 的 codec 侧写入。[已落地](../../implemented/simplification/2026-09-15-analyzer-remote-analyzer-extraction.zh.md)：Remote/RPC 分析器落 `src/remote-analyzer.ts`（`class RemoteAnalyzer`，1025 行），依赖清单 `RemoteAnalyzerDeps` 接 checker、face 程序、类型图、`registrationForFile` 与程序的已解析源文件；`validateInvocationIdentity` 成为「face + 已分析出的包」的导出函数，正是它让这道校验无需整个工作区即可测试。`analyzer.ts` 为 1253 行，出文件去写类型图状态的三处调用即 codec 的 `allocateNodeId`、`setNode` 与 `setDeclaration`。

## Alternatives considered

- **照 Issue #86 按体量排的顺序做。** 拒绝：最大的文件带着镜像约束，使它成为最不该先切的安全项之一；第二大的是纯构建期库，其风险是快照漂移而非体量。改为按「一次切割需要保住多少行为」排序。
- **把 `fixture.ts` 镜像的宿主实现改成 import 来拆分。** 拒绝：那会给 Web 客户端 bundle 加上宿主包依赖，反转该文件在自己注释里记录的决定。
- **只切一个后端的 `jscpd:ignore` 块。** 拒绝：那些注释声明了与兄弟后端的对称。悄悄打破它，等于把一份成文的契约变成一处无据可查的差异。
- **文件一超过行数阈值就抽走一大块。** 拒绝：体量本身说不出哪个边界安全。`core/session` 不是持久化混杂的文件——持久化早已在自己的包里——把它当成那样的文件来拆，会搬错东西。
- **在 `ui-trajectory` 引入翻译 context 以缩短 props 清单。** 拒绝：该包今天每个组件都把 `t` 当显式 prop 传。为了让一次拆分更省事而加第二套机制，是在分叉这个包的风格。
- **把批次 1 跨六个包一次做完。** 拒绝：上面那四条规则才是本 note 真正的交付物，而试点正是检验它们是否立得住的手段。六条并行改动会让规则在任何一个被确认之前就进入六次评审。

## Consequences

每个批次都落为各自的 pull request，试点先于批次 1 其余部分单独落地。每一个都过了同一道杠：所涉包的入口模块导出与之前同名，没有任何测试需要改导入路径，且该包自身的测试、`pnpm run typecheck` 与文档门禁全部通过。批次 1 不改行为——没有任何常量、默认值或 schema 取值被移动。批次 3 落地后本 note 迁入 `implemented/`，它的最后一项是 analyzer 的 Remote/RPC 那一刀。

- **对称欠账。** 每个被触碰却没带上对侧的 `jscpd:ignore` 块，都会留下一份未言明的契约。规则要求成对改动或修订注释，而唯一变动的那块已按实测撤除；下一处仍要评审者亲自核对。
- **藏在结构收益背后的性能退步。** `ui-trajectory` 的行渲染器是最清楚的一例：拆完看着更干净，却可能开始掉帧。三条数行渲染次数的用例钉住了它搬入的那道 memo 边界。
- **快照漂移。** 对 `analyzer.ts` 而言已不再是假设：`type-model.spec.ts.snap` 记录了 `allocateNodeId` 那些 id 的 578 处出现，而每个 id 的序号都来自其源码位置上的访问次序。如今 `tests/node-id-stability.spec.ts` 会指名失败，而快照只会给出一份 diff。
- **与 Issue #99 的词汇归属冲突。** 创建 `src/types.ts` 解决了「无家可归」，但也重新揭开一个已决问题；每一次这样的改动都必须援引既有例外，而不是重新论证一遍。
- **为拆而拆的空转。** 拆分本身只是搬行，不保证任何东西更好改。每一刀的证成理由——「某个测试变得可行」「某个接口变得显式」「某个方法变得可读」——都记在那一刀自己的 note 里。

## Related

- `.agents/audits/2026-09-11-tech-debt-issue-manifest.md` Issue #86
- `docs/TECH_DEBT.md`（M6，以及点名审计遗漏那两个文件的台账条目）
- [提取会话的增量折叠](2026-09-14-session-folds-extraction.zh.md)（批次 3 首刀落地）
- [提取 `run_code` 的子分发车道](2026-09-15-ptc-dispatch-pool-extraction.zh.md)（批次 3 第二刀落地）
- [提取 `Session` 对象与发布观察者](2026-09-15-session-object-extraction.zh.md)（批次 3 第三刀落地）
- [提取轨迹账本的行组件](../../archived/simplification/2026-09-15-trajectory-row-extraction.md)（批次 3 第四刀落地）
- [提取 analyzer 的类型图](2026-09-15-analyzer-type-graph-extraction.zh.md)（批次 3 第五刀落地）
- [提取 python 后端的加载期门禁](2026-09-15-python-config-gates-extraction.zh.md)（批次 3 第六刀落地）
- [提取 python 后端的子进程监管器](2026-09-15-python-child-supervisor-extraction.zh.md)（批次 3 第七刀落地）
- [提取 analyzer 的 Remote/RPC 分析器](2026-09-15-analyzer-remote-analyzer-extraction.zh.md)（批次 3 第八刀落地）
- `packages/code-runtime/code-runtime-worker-thread/src/index.ts`（`OutputLedger` 先例）
- `packages/experimental/code-runtime-python/src/index.ts`、`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`
