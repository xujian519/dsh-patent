# Agent Note: 把侧边栏编辑器的实时文本移出 React，并把每行派生键的推导次数降为一次

Status: implemented

[English](2026-09-16-editor-draft-and-derived-keys.md) | 中文

## Problem

三处客户端界面在每次事件上都重算本只需在同类事件第一次发生时完成的工作。

**侧边栏编辑器把整份文档在每次按键时复制进 React state。** `TextEditor` 的 CodeMirror update listener 对每次文档变更都执行 `setDraft(update.state.doc.toString())`，因此在 N 字节文件里打字，每次按键都要付一次 O(N) 字符串复制加一次组件重渲染；同一个 listener 的弹窗记账还会写入一个已经隐藏的弹窗。`previewText` 更糟：`rewriteLocalImageUrls`（对整份文档做五遍正则加一个 mask 数组）位于 `useMemo` 之外，于是每次渲染都会运行——包括编辑模式，而消费它的预览此时是 `display: none`。

**Chat 快照 builder 在每次比较中推导排序键。** `orderedVisibleChatNodes` 在比较器内部调用两次 `presentationPosition`，在 O(R log R) 次比较中的每一次都分配两条位置记录并重复 turn presentation 查找；`turnProcessPresentations` 对每个折叠的节点复制一次该 turn 的记录（`{ ...current, field }`）；结构变更检查则通过在两侧各拼一个 `kind:turn:step` 字符串来比较 Location。

**文件树用扫描数组判断行状态。** 每个渲染出来的行都执行 `expanded.includes(path)` 与 `revealed.includes(path)`，在深层树上使整趟行渲染成为 O(rows × expanded) 次字符串比较。

## Decision

- **编辑器自己持有实时文本。** 脏态期间文档由 `draftRef` 持有，`dirty` 仍留在 React state 中，因为宿主工具栏要读它；预览在下一次渲染时从该 ref 派生 `mdText`。只有从干净转为脏的那一次会提交，而 `save()` 依旧写出 `view.state.doc.toString()`。
- `previewText` 移入 `useMemo`，只在预览渲染时计算重写后的源文本，否则回退到原始源文本，与它旁边的 `mdBlocks`、`htmlInfo` 两个 memo 保持一致。
- `hidePopup` 在没有弹窗时直接返回，因此 CodeMirror 每次更新的隐藏动作不再写入同值 state。
- `orderedVisibleChatNodes` 每次调用为每个节点派生一次位置，存成 `{ node, position }` 条目后排序，再映射回节点；`key.localeCompare` 兜底保留。
- `turnProcessPresentations` 每个 turn 只保留一条可变记录，首次使用时创建。为支持该折叠，`TurnProcessPresentation` 的字段去掉了 `readonly`；返回的仍是 `ReadonlyMap`，且该记录的唯一消费者对空记录与对缺失记录返回相同结果。
- 结构变更检查改为逐字段比较 Location（`sameLocation`），不再拼一个只用于立即比较的键字符串。
- `FileTree` 为每行判断记忆化 membership Set，而它的 props 保持数组。

## Alternatives considered

- **让 draft 留在 state，用 `useSyncExternalStore` 或订阅来阻止重渲染。** 已否决：编辑器在保存路径上本就持有文档，因此 ref 是既有的唯一事实来源，而不是新增的一个 store。
- **保留逐次 `setDraft`，靠 `setDraft(previous => previous ?? text)` 的 bailout。** 已否决：bailout 在更新之后比较 state，因此 listener 仍会在每次按键复制整份文档。
- **只在模式切换时由 effect 发布 draft。** 已否决：effect 在预览首次绘制之后运行，预览会显示一帧编辑前的文档。
- **改回以节点 key 为键的 `Map<string, PresentationPosition>`。** 已否决：比较器需要一次它无法证明存在的查表，而条目数组把配对关系写进了类型里。
- **直接把 `FileTree` 的 props 改成 Set。** 已否决：那个加载所有已展开目录的挂载 effect 依赖 prop 的身份，改成 Set 只会把新的抖动推给调用方，而这里并无收益。
- **在结构检查里保留字符串键。** 已否决：该键的唯一用途就是被立即比较，而其中 `?? ''` 的回退让两个 undefined 坐标等于空字符串而不是彼此相等。

## Consequences

已实测，且比促成这项工作的那次审计所估计的小。

- `TextEditor`：新用例钉住十七个字符的一次输入过程只产生一次 React 提交，且编辑模式下预览源文本重写次数为零。把逐次 state 写入与非记忆化的源文本恢复后，同一个用例报告每次按键一次提交、一次重写（19 次提交与 20 次重写，对照 3 次与 2 次）。
- `ChatSnapshotBuilder`：必需的 fold 基准没有变化——`pnpm exec vitest run --config vitest.bench.config.ts benchmarks/conversation-fold` 在改动前对它两个窗口报告 7.2 ms / 5.8 ms，改动后为 8.2 ms / 6.2 ms。重排序路径在该 fold 中不占可测量的比例，因此如实的主张是算术上的：O(R log R) 次位置记录与 turn 查找变为 O(R)，顺序不变。
- `FileTree`：整趟行渲染从 O(rows × expanded) 次数组扫描变为 O(rows) 次 membership 判断。未单独测量。

编辑器的草稿在按键之间对 React 不可见，因此由其他原因（配色切换、弹窗）触发的渲染也通过 ref 看到实时文本，而不是看到首次按键时的文本。

## Testing

- `packages/client/better-sidebar/tests/text-editor-draft.client.spec.tsx`（新增，jsdom）挂载真实编辑器，经 `EditorView.findFromDOM` 取得它的 `EditorView`，并用 `Profiler` 统计 React 提交：十七个字符的一次输入只增加一次提交且不调用任何预览重写；模式切回时预览渲染最新文本；保存写出编辑器文档并清除宿主侧的脏标记。重写次数来自对 `markdown-images.ts` 的 `vi.mock`。
- 负向控制（已运行并回退）：恢复逐次 `setDraft` 与非记忆化的 `previewText` 会让前两个用例失败（19 次提交、20 次重写），而保存用例仍然通过。
- `pnpm exec vitest run packages/client/better-sidebar packages/client/ui-chat packages/client/ui-conversation packages/client/ui-trajectory` —— 229 个文件 2687 项通过、5 项跳过；`chat-view.client.spec.tsx` 与 `conversation-node-definitions.client.spec.ts` 中的 Chat 顺序与身份断言未改动且仍然通过，这正是本次改写必须保持的契约。
- `pnpm exec vitest run packages/client apps/web` —— 7328 项通过、5 项跳过，唯一无关的 `ui-sidebar-documentpreview` 打包产物失败见[认领生命周期笔记](../architecture/2026-09-16-conversation-target-claim-lifetime.zh.md)。
- `pnpm run lint` 与两个 TypeScript face 均干净。

## Related

- [本 fork 移除 better-sidebar](../architecture/2026-11-01-fork-removes-better-sidebar.zh.md) —— 原先拥有编辑器草稿与文件树工具栏契约的包；本笔记里的草稿/键规则在该 UI 现存落点上仍然适用。
- [ui-chat](../../../../packages/client/ui-chat/README.zh.md) —— 拥有这些排序键所服务的文本记录顺序的 target。
