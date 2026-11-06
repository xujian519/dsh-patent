---
kind: upgrade-guide
description: "OA 链路新增 `slop_gate` 阶段并带一次改写回路；门按参数读取文本键与篇幅预算，concision 按预算归一。"
---

# 反套话门覆盖答复正文

[English](guide.md) | 中文

## 变更

`patent_oa_response_v1` 由 13 个阶段增至 14 个：`slop_gate` 紧跟在 `draft` 之后。模型阶段数不变（仍为四个）——门是确定性的。本版本稍后的 `tighten` 再把链路推到 15 个阶段、5 个模型阶段。

```ts ignore-check
{ id: 'slop_gate', atom: 'slop-gate',
  params: { text_keys: ['draft'], char_budget: OA_RESPONSE_DRAFT_BUDGET.total },
  retry: { whenOutputMatches: '需修订', rewindTo: 'draft', maxRetries: 1 } }
```

放在 `draft` 旁边，回退就只重做 `draft`，不必连带 `adversary-review`。门判失败时整轮回退一次，修订意见（只有证据，不含分数）注入 `draft` 的提示；第二次仍失败则标记 `[WORKFLOW_RETRY_EXHAUSTED]`（降级），不会死循环。

`slop-gate`（`packages/patent/patent-tools`）不再写死受理文本：`text_keys`（缺省 `['claims_draft']`）指定参与判定的状态键，`char_budget` 声明篇幅预算。不传预算时行为与改前一致——撰写链路，读数不变。

concision 的参照变了：旧口径「段数 > 15 → 5 分」对八节意见陈述书是常数惩罚。现在按可见字符数与预算之比给分——预算内 `8`，不超过 1.25 倍 `6`，不超过 1.5 倍 `4`，再多 `3`。篇幅本身已在别处管住，这一维只问「是否守住了给定预算」。

四个判据会把正常法律行文读成套话：

- **directness** 改为读开头**正文**：标题、著录项抬头（`申请号：`…）、引用块与纯标记行一律跳过——用原始文本前 200 字判定，永远落在抬头上，每份答复都被判 4 分（满分 8）。套话式请求句（「恳请审查员重新考虑」）即便点明了争议也只得 5 分；争议词补入「异议」「驳回」。
- **evidence** 基线为中性 5/10；声明预算后取消短段落加分，且全文零证据锚点时封顶 4 分——从前两句话、一个锚点都没有，反倒因段落少而白拿加分。
- **empty_three_step** 只在没有证据锚点时命中（不含 `D1`、`¶0123`、权项号、法条、`F2`/`P1`、「见 3.1 节」）；标题与表格分隔行不参与扫描。
- **passive_voice** 在被动句之前已写明主体时不再命中；**reason_pile** 按不同条款计数，而不是引用次数。

`example.html` 改了两处，使参考成品通过它自己现在要过的门：总体立场不再以「申请人恳请审查员重新考虑…」开头，答复要点第二条把区别特征锚定为 `F2`。

标定读数（43 分制）：

| 文书 | 旧口径 | 新口径 |
| --- | --- | --- |
| `example.html`（3.1k 字） | 33，不过 | 42，过 |
| 快照旧草稿（8.4k 字） | 35，过 | 33，不过 |
| 两句话套话答复（无引用） | 35，过 | 33，不过 |

## 迁移

1. 若你在读 OA 链路的 `slop_score`，重新定基线；撰写链路不受影响。
2. 把门接到别的 manifest 时显式传 `char_budget`（取 `draft` 提示用的同一常量），并把 `rewindTo` 指向产出被判定文本的阶段。
3. `rewindTo` 不能跨过审批门——manifest 校验会拒绝，把门放在 `approval` 之前。
4. 读 `state` 的消费方不必处理 `slop_revision_hint`：故意不写进 `outputSchema`，否则回退时会在 `draft` 重跑之前被清掉。
5. 本次改动已重录 `patent-oa-chain`、刷新 `patent-oa-response`；后续仍随相邻改动一起重录，不逐阶段重录。
