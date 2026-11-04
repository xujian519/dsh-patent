# Agent Note: upstream v0.2.2-rc.1 sync

Status: implemented

[English](2026-11-05-upstream-dsh-v0.2.2-rc.1-sync.md) | 中文

## Problem

上游发布 0.2.2 系列的首个候选版本 `dsh-v0.2.2-rc.1`。它的祖先链直接经过 fork 已吸收的 `dsh-v0.2.2-alpha.3`，因此该 release 只新增 387 处单行 manifest 变更：根、377 个 workspace 包与 9 个 vendor 包从 alpha.3 版本族移到 `0.2.2-rc.1`，vendor 家族移到 Cordis 4.1.0 版本族。fork 的 alpha.3 吸收以 [squash 提交](https://github.com/xujian519/dsh-patent/pull/719)落地，tag 的祖先链无法从 master 到达，对旧 merge base 做内容合并会报出 468 个冲突，而它们都已在上一轮同步中解决。

## Decision

- **用 ours 策略记录 tag 为合并父提交，再在后续提交应用 release 差异。** `git merge -s ours dsh-v0.2.2-rc.1` 保留双方父提交，又不重放 master 已有答案的冲突。重放会把 fork 决策伪装成冲突解决，并有回退 squash 内容的风险。
- **机械应用版本族。** 所有处于 `0.2.2-alpha.3` 的受跟踪 manifest 移到 `0.2.2-rc.1`，包括 fork 独有的专利、法务、文档与 self-evolve 包，延续「fork 独有包并入 release 版本族」的规则。
- **Vendor manifest 跟随 release 的发布版本**（`cordis` 4.1.0、`cosmokit` 1.9.0、`group`/`hmr`/`include`/`loader`/`logger-console` 1.1.0、`schemastery` 3.19.0、`timer` 1.2.0）。release 只改版本号；`vendor/README.md` 中记录的 vendor 源码 pin 保持原有上游提交。
- **ACP 握手快照随版本更新。** `agentInfo.version` 从包 manifest 读取，因此同一提交更新九个内嵌该版本号的 ACP 预期输出。
- **不新增 upgrade guide，也不写 persistence 记录。** 相对 alpha.3，该 release 没有外部可感知的行为变化、新的会话事件或持久化类型变化。

## Alternatives considered

- **重放内容合并并解决全部 468 个冲突。** 否决：冲突全是 alpha.3 同步以 squash 落地造成的假冲突。解决它们等于在 fork 已合并的改写与其文件祖先快照之间二选一，而没有上游变更需要调和。
- **cherry-pick 四个 release 提交。** 否决：cherry-pick 不记录上游祖先，下一轮同步仍会面对同一个断裂的 merge base。合并父提交才是同步的持久部分。
- **因为代码没变而跳过版本对齐。** 否决：ACP 握手广播包版本，发布产物与已发布 manifest 也携带它，且 fork 独有包不能偏离 release 版本族。
- **把 vendor 源码更新到 4.1.0 的 pin。** 否决：release 只提升 manifest 版本而不改源码；替换 vendor 源码属于按 `vendor/README.md` 流程执行的 vendor 同步。

## Consequences

fork master 现在以 `dsh-v0.2.2-rc.1` 为合并父提交，后续 release tag 与 fork 共享可达的 merge base，无需再做一次 ours 合并。全部 431 个受跟踪 manifest 报告 `0.2.2-rc.1`；vendor manifest 报告 release 版本，源码仍是 alpha.3 的 pin。下一个上游 tag 可以正常合并。

## Testing

`pnpm run build:artifacts` 在版本变化后重新生成目录与客户端元数据，`pnpm run build:check` 针对该产物编译聚合检查。ACP 快照回放（`pnpm run test:snapshot -t handshake`）确认握手广播 `0.2.2-rc.1`，`pnpm run hygiene` 校验已发布 manifest。
