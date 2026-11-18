# Day 44 — 2026-12-28

## 今日维度与范围

- 维度：收敛
- 范围：抽样复核。从 P0/P1 取 10 条，对照当前源码确认仍成立，并统计误报
- 时间盒：120 分钟
- 预期产出：daily/day-44.md；[05-findings.md](../05-findings.md)「复核记录」追加一节

## 检查项

- [x] 从 P0/P1 抽样，覆盖四域。
- [x] 每条回到源码取证，记录文件与行号。
- [x] 判定仍成立、已修、或误报。
- [x] 统计抽样误报率。
- [x] 把结论追加到 05-findings.md 的「复核记录」。

## 实际执行

抽样口径：P0 全取（1 条），P1 按域各取，尽量覆盖不同根因组；另取 1 条 deferred 条目验证其维持理由是否仍成立。基线是当前工作树，已含 R-E1 至 R-E5 的落地改动。

| 编号 | 分数 | 复核位置 | 复核结论 |
|---|---|---|---|
| F-PAT-045 | 12（P0） | `patent-core/src/atoms/handlers/builtin/claim-breadth.ts:217`；`patent-core/src/llm-json.ts:200` | 成立。`:217` 仍调 `parseOptionalJsonStringArray`，`:200` 仍把 `undefined` 读成 `{ ok: true, values: [] }`，省略字段继续判概括范围通过 |
| F-DOC-010 | 10（P1） | `document-deliver/src/checks.ts:596`–`:601` | 成立。`:596` 取 `fenceRanges(text)`、`:598` 取 `quotedRanges(text)`，`:601` 只用这两个范围判占位符；HTML 围栏、注释与属性仍不在覆盖内 |
| F-LEG-013 | 10（P1） | `legal-knowledge/src/legal/search.ts:199`、`:215` | 成立。SQLite 路径仍 `findRowsLike(..., limit * 2)` 后再过滤，内存路径仍 `searchInMemory(..., limit * 2)`，两种后端结果集不同 |
| F-PAT-050 | 9（P1） | `patent-workflow/src/plantask.ts:202`、`:209` | 成立。`prevByHash` 按哈希建表后每个新步骤读同一项，重复步骤全部拿到已完成状态 |
| F-PAT-055 | 9（P1） | `patent-data/src/mapper.ts:27`–`:34` | 成立。`extractNames` 的 `.map` 直接读 `item[key]`，邻接的 `parseJsonArray` 只校验外层是数组，null 元素仍抛 `TypeError` |
| F-CROSS-002 | 9（P1） | `patent-tools/package.json:40`；`patent-tools/src/tool/law-search.ts:16` | 成立。`package.json` 只声明 `@deepseek-ai/dsh-util-values`，源码导入的是 `@deepseek-ai/dsh-value` |
| F-VID-015 | 9（P1） | `video-mode/src/edl.ts:43`–`:44`、`:121` | 成立。`audioClipSchema` 仍只有非负/正数，`:121` 的顺序校验仍只遍历 `kind === 'video'` |
| F-VID-014 | 8（P1） | `video-mode/src/tools/project.ts:169`、`:186` | 成立。`presentationMeta` 仍发布原始 `value.path`，只有 `init` 返回 `ctx.fs.processPath` |
| F-PAT-024 | 7（P1） | `patent-teams/src/index.ts` 等七个包入口 | 成立。`patent-teams/src/index.ts` 仍是 10 处 `.default(` 对 10 处 `??`；`patent-data/src/index.ts` 仍是 15 对 16 |
| F-PAT-047 | —（deferred） | `patent-core/src/workflow/types.ts:190`；`patent-workflow/src/workflow.ts:481` | 维持 deferred。`:190` 的契约仍写「重跑从第一个阶段开始」，`:481` 的循环仍从 0 起；真实续接属独立立项，Deferred 理由未变 |

**误报统计**：抽样 10 条，成立 9 条、维持 deferred 1 条、误报 0 条，误报率 0%。另有 2 条观察在编号前已被否决，不计入本条。

**命令**：以上各条用 `grep -n`、`sed -n` 逐点取证，全部退出码 0 且命中预期行；无命中或行号漂移的条目会改判，本次没有出现。

## 发现

无新编号。抽样过程中未发现相邻代码新增缺陷。

## 假设验证/推翻

H07 与抽样交叉印证：F-PAT-045 属「缺失输入被读成通过」，与 Day 34–40 的结论一致，本日不改该假设。H04 的 F-VID-014 与 F-VID-015 仍在，维持部分确认。

## 未决问题

1. R-D1 的八条测试缺口未在抽样内，需单独一批验证。
2. F-PAT-024 的门禁必须等它修完才能加，顺序不能颠倒。
3. 抽样为 10/42，未修条目余下 32 条只做过 Day 43 的聚类归类，未逐条重取证。

## 明日第一件事

做 D45 复盘：填 `08-retrospective.md` 的四张表与下一周期建议，写 `daily/day-45.md`。
