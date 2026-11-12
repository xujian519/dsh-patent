# Agent Note: 由 profile 安装的客户端插件失败时仍启动浏览器应用

Status: implemented
Archived: 2026-11-12

[English](2026-09-27-profile-installed-client-entry-tolerance.md) | 中文

## 问题

客户端启动审计（[`packages/client/web/src/boot-client.ts`](../../../../packages/client/web/README.zh.md)）把每个非 active 的 Loader entry 都视为致命：`loader.await()` 之后一次性聚合抛错。其包由当前 profile 安装的行，是部署方并不拥有的插件的浏览器半边，而图同步对账会重试失败的 entry（`ClientEntries.reconcile` 调用 `fiber.update`），因此一个 entry 可能首次激活尝试抛错、片刻后激活成功。

`@niyongsheng/free-vision-skill` 正是此例。它的客户端 `apply` 调用 `ctx.slots.register('conversation.input.right', …)`，而它的 fiber 只等待 `slots` 服务，`ui-conversation` 稍后才在自己的 `slots.inject('main', …)` 链路里声明该 key。在 Web 组合中实测：首次 `apply` 在 144 ms 抛出 `slot "conversation.input.right" is not declared`，审计在 199 ms 下判，重试在 621 ms 成功。审计的判定是终局的，页面此后不再复审，于是桌面端报告启动致命失败、保留启动页，并且只提供「禁用全部第三方插件」这一种恢复手段。报告把该 entry 记为 `failed`，丢掉了背后的激活错误，因此崩溃报告与对话框都无法解释它。

宿主半边早已做出这一区分：[启动审计](../../../../packages/boot/app-boot/README.zh.md)只对必需条目 id 拒绝启动，其余只记警告。客户端半边没有这一概念，于是一个插件的浏览器半边能让应用无法启动，而它的宿主半边只是一条警告。

## 决策

除非当前 profile 安装了其所在包，否则 boot 行是必需的；`auditClientActivation` 对两类行施加同一套口径：

- **类别由 profile 自身的清单决定。**[`PluginPackages.installedByProfile`](../../../../packages/boot/app-boot/README.zh.md) 报告运行时解析里的 `localPackageNames`——当前 profile 声明、且已安装在其自身 `node_modules` 中的依赖。[`clientModules` 宿主半边](../../../../packages/client/modules/README.zh.md)把这类行在启动图上标记为 `required: false`；其余行以及图外的任何 entry 都是必需的。
- **非 active 的必需 entry 拒绝启动**，并点名整个非 active 集合；**非 active 的 profile 安装 entry 只记警告**，由运行中的应用承载：「设置 → 插件 → 插件列表」报告失败的客户端 entry 及其消息并可重试（[`ui-settings-plugin-inventory`](../../../../packages/client/ui-settings-plugin-inventory/README.zh.md)）。
- **每行都写明原因**：`import failed: <已记录的导入错误>`、`pending (waiting for services: …)`，或 `failed: <fiber 已落定激活错误的消息>`——审计通过 `fiber.await()` 读取它。拦停报告中必需条目带 `(required)` 标记。
- 对未声明的 slot key，`SlotCore.register` 仍然抛错，[客户端编写规则](../../../../packages/client/AGENTS.md)仍然要求跨包注册使用 `ctx.slots.inject(name, () => ctx.slots.register(…))`。改变的只是违反它的启动后果，且仅限 profile 所拥有的行。

## 备选方案

**修好插件的注册方式，审计保持严格。** 插件确实违反了编写规则，其 `slots.inject` 形式可用。但审计判定的条件在 400 ms 后就自行解决，下一个用户安装的插件犯同样错误仍会让应用无法启动；向上游反馈插件问题也替代不了这条口径。

**让 `SlotCore.register` 等待迟到的声明。** 注册会自行落地，entry 永不失败。代价是失去捕获拼错或范围错误 key 的失败信号，而 `slots.inject` 的存在正是为了显式表达这种依赖；声明契约（「声明即主张」）保持不变。

**在审计内部重试非 active entry 后再判定。** 审计时刻该 key 仍未声明——声明稍后才在 `ui-conversation` 自己的激活链路里到达——所以立即重试仍会失败，而等待则要在启动路径里放一个任意期限。真正成功的重试搭的是宿主图同步，其到达时机不由启动内核约束。

**保持严格审计，依赖桌面端的恢复按钮。** 它禁用全部第三方插件而非出错的那一个，能用的插件一并丢失，而且崩溃报告依旧缺少它本应承载的激活错误。

**把审计结果对每一行都降级为警告。** 这样仓库自带行激活失败时，shell 会在不完整的 roster 上挂载，而启动页与挂载交接都无法如实报告这一点；必需类别让这类失败继续大声。

## 测试

| 证据 | 行为 |
|---|---|
| [boot-client.client.spec.ts](../../../../packages/client/web/tests/boot-client.client.spec.ts) | profile 安装的行在 `apply` 抛错时 boot 正常结束并带激活消息告警；必需行仍以整个非 active 集合、原因与 `(required)` 标记拒绝；图外的 entry 视为必需；不重抛原因的失败 fiber 与重抛非 Error 值者都会被报告。 |
| [loader.client.spec.ts](../../../../packages/client/modules/tests/loader.client.spec.ts) | 协议携带 `required: false`，未标记的行归一为必需，非布尔标记被拒绝。 |
| [node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) | 宿主只标记 profile 安装的行；没有包查询服务时每一行都保持必需。 |
| [profile-resolution-service.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution-service.spec.ts) | `installedByProfile` 跟随解析及其被替换的世代；没有解析的服务报告为空。 |

在 Web 组合中用装在 profile 里的 `@niyongsheng/free-vision-skill@0.3.1` 实机验证：启动页被应用取代，控制台出现 `web boot: warning: 1 entry did not activate / @niyongsheng/free-vision-skill: failed: slot "conversation.input.right" is not declared (a parent entry's children table must declare it)`，该插件 entry 在图同步后激活。同一个包在 profile 之外解析（必需）时仍然停在启动页，报 `web boot: 1 required entry did not activate / … (required): failed: slot …`。

## 后果

- 用户安装插件的浏览器半边不再能阻止应用启动；其失败在启动时是一条控制台警告，此后是「设置 → 插件」中可重试、可见的条目。
- 仓库自带行失败、以及自带行依赖的 pending 行，仍会拦停启动，因此 shell 挂载所依据的 roster 在部署方拥有的面上仍然完整。
- 启动页与桌面端崩溃对话框现在给出失败 entry 的激活错误，而不只是状态词。
- 启动图新增 `required`（为真时省略）。不发送该字段的宿主产出必需行，即此前行为。
- 客户端启动内核新增了对一项宿主服务的读取，用于判断包是否由 profile 安装。没有它时（未挂载包查询服务的 profile，以及单元夹具），每一行都是必需的。
- 长期失败的 profile 安装 entry 在该页面生命周期内保持非 active，直到在「设置 → 插件」中重试；在此之前它不对 UI 做任何贡献。
