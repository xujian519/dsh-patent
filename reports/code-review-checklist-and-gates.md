# 审查执行卡与门禁定义（D2）

> 配套 [30 天计划](code-review-simplification-30-day-plan.md) 的第 5、7 节。计划给出领域规则与节奏；本卡给出每个审查者每天可直接勾选、可直接执行的条目。

## 1. 使用方式

- 每个 PR 合并前，作者与评审者各自过一遍第 2 节通用清单，结果贴进 PR 描述。
- 每个发现按第 3 节分级并写进风险登记册；没有具体失败输入的观察不登记。
- 每天收工前跑第 5 节中受影响领域的门禁命令；周五跑第 6 节全量门禁。

## 2. 通用审查清单（逐 PR）

### 2.1 行为与正确性

- [ ] 改动是否改变用户、模型或系统可观察的结果？改变则 PR 标题必须是 `fix`，并在描述给出修复前后对比。
- [ ] 纯精简 PR 是否保证既有测试 **零改动** 通过？有测试改动时逐条说明原因。
- [ ] 是否存在吞错、静默回退或“失败即通过”？失败路径是否显式返回结构化错误？
- [ ] 新分支是否有失败用例，而不只是 happy path？
- [ ] 边界输入（空集合、零值、超长、全角/半角、Unicode、闰年、月末）是否覆盖？
- [ ] 是否引入跨进程、并发或持久化状态？若是，恢复与重入是否有测试？

### 2.2 类型与结构

- [ ] 没有新增 `as unknown` / `as any`；确需保留的逐条说明为何无法收窄。
- [ ] 没有新增硬编码可调参数；部署差异进入校验过的 `Config`。
- [ ] 公共导出是否有当前消费者？无消费者的导出删除或降为包内。
- [ ] 是否把多个职责塞进一个文件？新增文件原则上不超过 400 行，超长文件拆分需单独 PR。
- [ ] 错误处理遵循 `dsh-error-handling`：typed、可行动、归属明确。

### 2.3 证据与文档

- [ ] PR 描述包含实际执行过的命令与结果，而不是“应该能过”。
- [ ] 模型可见输出、提示词或工具 schema 变更附带快照。
- [ ] Session 事件、持久化格式变更遵守版本与兼容规则，并有双人复核。
- [ ] README、JSDoc、Agent Note 随代码同步更新；文档变更跑 `doc-sync`。
- [ ] 每个 PR 可独立回退；跨包迁移采用“先委托、后删除”两步。

## 3. 发现分级与判定标准

| 级别 | 判定标准 | 处理时限 | 签字 |
|---|---|---|---|
| P0 | 法条/期限/费用/证据判定可能错误；数据丢失；安全或持久化不兼容；沉默失败进入生产路径 | 立即，暂停其他工作 | 领域负责人 + 轮值评审 |
| P1 | 常见路径结果错误；高风险路径缺少失败测试；能力声明与实现不一致；已验证的校验门可被绕过 | 当周 | 领域负责人 |
| P2 | 结构性债务，当前无可复现错误但有明确漂移风险；架构方向倒置 | 当周排期，可顺延 | 评审者 |
| P3 | 可读性、命名、报告格式、重复注释 | 批量处理 | 作者 |

**升级规则**：任何能写出“输入 → 期望 → 实际”的法律/专利正确性差异，至少 P1；影响权利有效性、期限或费用结论的，直接 P0。写不出具体输入的，不登记为缺陷，只作为观察记录。

## 4. 发现记录模板

```markdown
### R-NN 标题（级别）
- 域：patent / legal / document / video
- 证据：`文件:行号`，附归一化后的关键表达式
- 失败输入：`...` → 期望 `...`，实际 `...`
- 测试覆盖：`spec 文件:行号` 或 未覆盖
- 动作：最小修复 + 需要补的用例
- 验证：修复前失败、修复后通过的用例名
- 负责人 / 状态
```

## 5. 每日门禁（按受影响领域）

### 5.1 命令矩阵

```bash
# patent 核心与工具
pnpm exec vitest run packages/patent/patent-core
pnpm exec vitest run packages/patent/patent-tools packages/patent/patent-rule
pnpm exec vitest run packages/patent/patent-workflow packages/patent/patent-teams

# legal
pnpm exec vitest run packages/legal

# document
pnpm exec vitest run packages/document

# video
pnpm exec vitest run packages/video packages/experimental/video-mode

# 类型与静态检查（每日至少一次）
pnpm run typecheck
pnpm run lint
```

### 5.2 追加门禁

| 改动类型 | 追加命令 |
|---|---|
| 模型可见输出、提示词、工具 schema | `pnpm run test:snapshot -t <快照名>` |
| 持久化类型或 Session 事件 | 持久化变更确认 + 快照更新 + 双人复核 |
| 文档、README、JSDoc | `pnpm run doc-sync` |
| 跨包移动或删除 | `pnpm run duplication` + `pnpm run change-scope` |
| 构建产物路径 | `pnpm run build:artifacts && pnpm run build:check` |

## 6. 每周门禁（周五）

```bash
pnpm run duplication
pnpm run doc-sync
pnpm run test:coverage
pnpm run report:structure
```

遵循仓库策略：CI 负责全量覆盖与平台矩阵，本地不默认跑全量。周度门禁只在本周合并的改动范围内解读，超出部分交 CI。

## 7. 四领域专项清单

详细规则见计划第 5 节；这里只列每个领域当天必须回答的问题。

### 7.1 patent

- 法条判定是否附来源，索引版本是否固定？
- 期限计算是否覆盖月末、闰年、节假日顺延、送达日？
- 费用档位与滞纳金是否用精确十进制或整数分？
- 工作流拒绝路径是否在执行器层验证，而不只测纯函数？
- 图形退化输入（零尺寸、共线、超长标签）结果是否确定？

### 7.2 legal

- 索引缺失时是否显式失败，而不是静默通过？
- 同一输入重复评分是否完全一致？
- FTS5 与内存回退是否返回相同结构？
- 与 patent 域同名能力是否只剩数据源差异？

### 7.3 document

- XML 转义、zip 边界、图片尺寸是否有恶意/超限输入测试？
- 模板变量缺失与注入是否有明确行为？
- 交付记录能否仅凭会话日志重建？
- LibreOffice 子进程是否超时并清理临时目录？

### 7.4 video

- provider 选择歧义与任务保留上限是否有测试？
- 预算门并发提交是否为“非预留”，失败是否不扣费？
- ComfyUI 占位符是否保持 JSON 类型，轮询是否节流？
- ffmpeg 参数是否走数组，字幕/音轨缺失是否告警？

## 8. 责任人与签字

| 范围 | 负责人 | P0 第二签字 |
|---|---|---|
| patent-core / data / law / fees / deadline | A | R |
| patent-tools / rule / workflow / teams | B | R |
| legal / document | C | R |
| video / 跨域共享 | D | R |

单人执行时，A–D 角色合并，但 P0 仍须由第二人（R）复核；无人复核时，P0 只允许提交测试与分析，不允许合入修复。

## 9. D4 已确认缺陷的回归测试清单

以下用例在对应修复 PR 中先加、后修；修复前必须是失败用例，修复后转绿。不要把当前错误行为写成期望。

| 风险 | 测试位置 | 输入 | 期望 |
|---|---|---|---|
| R-30 | `tests/claim-chart/chart-atom.spec.ts` | 有 `source_path` 的 D1，`not-found` 行 + 空 `pinCite` | 通过，不触发 pin-cite 格式错误 |
| R-31 | `tests/claim-chart/chart-atom.spec.ts` | 源文可读，`literal` 行 + 空 `quote` | 拒绝，报缺少引用证据 |
| R-32 | `tests/claim-chart/mapping-machine.spec.ts` | 权 1 无要素，权 2 引用权 1，仅 `2a` 为 `literal` | 权 2 不判全覆盖 |
| R-33 | `tests/claim-chart/pin-cite-validator.spec.ts` | `[0032]` 段为“壳体”、`[0034]` 段为“滤芯”；引用 `[0032]`、quote “滤芯” | 拒绝，quote 不属于所引段落 |
| R-34 | `tests/claim-chart/element-validator.spec.ts` | `claimNo: 5` 的要素文本取自权 1 | 拒绝，claim 5 段不存在 |

## 10. D5 待验证项的处理结果

R-35–R-40 已各写一个最小复现并全部确认为真实缺陷；复现用临时 spec 运行后删除，未合入。契约复核另新增 R-41（重复/跳号权项号被切分静默接受）。

## 11. D5 已确认缺陷的回归测试清单

以下用例在对应修复 PR 中先加、后修；修复前必须是失败用例，修复后转绿。不要把当前错误行为写成期望；R-35 的既有测试已把部分错误行为写成预期，修复时同步修改。

| 风险 | 测试位置 | 输入 | 期望 |
|---|---|---|---|
| R-35 | `tests/claim-draft-atom.spec.ts` | 策略表含确定性从权 2、3，专员只返回权 2 | 回退确定性结果，`claims_draft` 保留权 3 |
| R-36 | `tests/claim-breadth-atom.spec.ts` | 模型记录省略 `parallel_lower_levels` | 判定为未通过或降级，不输出“通过” |
| R-37 | `tests/claim-chart/chart-atom.spec.ts` | 同一 `(elementId,targetId)` 同时有 `literal` 与 `not-found` 行 | 校验拒绝重复行 |
| R-38 | `tests/claim-chart/claim-refs.spec.ts` | `根据权利要求1-35所述`、`根据权利要求3-1所述` | 产出引用缺陷，不判 `independent` |
| R-39 | `tests/claim-chart/invalidity-conclusion.spec.ts` | `primaryTargetId: '产品A'`（accused-product） | 显式报错；渲染不同时出现“无对比文件目标”与“对比文件 1 篇” |
| R-40 | `tests/claim-chart/chart-atom.spec.ts` | `chart_targets` 含两个 `id: 'D1'` | 解析阶段拒绝重复 id |
| R-41 | `tests/claim-chart/chart-atom.spec.ts` | 权利要求原文重复 `1.` 或跳号 `1.`、`3.` | 图表输入解析拒绝，不静默丢弃或接受 |

## 12. D6 复核结果

D6 范围：`draft/validate.ts`（811 行）、`ipc/ipc-classifier.ts`（807 行），以及映射到 D6 的 R-15、R-17、R-19、R-27、R-28、R-29。六项均已复现确认，其中 R-27、R-28、R-29 由“待验证”转为“已确认”；另新增 R-42（模板 section/grounds 未知键被静默忽略，P2）与 R-43（必填字段为空时同时报“为空/缺失”，P3）。

| 风险 | 复现输入 | 实际结果 |
|---|---|---|
| R-15 | `figureFiles: []` + 空 `drawingDescriptions` | 抛“figureFiles 至少一项” |
| R-17 | `classifyIpcTop('一种高温阀门，包括阀体和密封结构')` | 归 E 部，命中 `结构`/`门` |
| R-19 | `claims: ['1.5wt%的乙醇溶液…']` | 报“自带项号”并拒绝 |
| R-27 | `reference_basis: 'priority'` | 报告标注“申请日”，无降级 |
| R-28 | 证据仅有 `id: 'E1'` | `passed=true`，无 `EVID-FORM-IDENTITY` |
| R-29 | 无期限 + `submittedAt: '2024-13-01'` | `_error` 为空，`passed=true` |
| R-42 | 模板 section / grounds 条目追加 `extra` | 不抛错，未知键被忽略 |
| R-43 | 必填 `title: ''` | 违规同时含“为空”与“缺失” |

复现用临时 spec 运行后删除，未合入产品代码或测试。

## 13. D6 精简候选清单

只列行为等价的结构调整；每项单独 PR，先补守护测试，再移动代码。当前 811/807 行的两个文件都超过 400 行阈值。

| ID | 位置 | 候选动作 | 优先级 | 预期收益 | 等价性验证 |
|---|---|---|---|---|---|
| C-01 | `draft/validate.ts` | 拆为 `validate/shared.ts`（`DraftValidationError`、`available`、`reportUnknownKeys`、读取原语，约 140 行）、`validate/spec.ts`（meta/章节/块/表格/附图，约 260 行）、`validate/template.ts`（字段/槽位/数据行/理由/配额，约 380 行）、`validate/index.ts` 仅重导出；`draft/index.ts` 改一行导入路径 | P2 | 单文件降至约 380 行，超 400 行文件数 −1；校验规则按域就近 | 仅移动与重导出；现有 1740 个用例、`typecheck`、公开导出签名全部不变 |
| C-02 | `ipc/ipc-classifier.ts` | 把 `IPC_DOMAINS`（34-441 行）与 `IPC_DETAIL_DOMAINS`（448-715 行）移到 `ipc/domains/`：`sections-a-d.ts`、`sections-e-h.ts`、`details.ts`、`index.ts`；分类逻辑留在原文件并从 `domains/index.ts` 导入、重导出两张表 | P2 | 分类器 807 → 约 170 行；三个数据文件均 <400 行，超 400 行文件数 −1；关键词表按部分组，修改一部不触碰其余 | 移动前后对导出表做 JSON 深比较；`ipc-classifier` 全部用例与 `classifyIpcTop` 边界一致 |
| C-03 | `tests/ipc-classifier.spec.ts` | 增加规则表不变量：A-H 八部唯一、每部关键词非空、同一组内无重复词、细分 `section` 必须存在且 `detail` 唯一 | P2 | 守住 8 部 + 10 细分、434 个关键词的现状；数据搬移/编辑时立即暴露断链 | 当前数据 18 组、434 词、组内重复 0，测试应直接通过；删一部或复制一词应失败 |
| C-04 | `draft/validate.ts:125,139-149`；`ipc/ipc-classifier.ts:774-779` | 删除 `Array.isArray` 后多余的 `as unknown[]`；把单次使用的 `readStringListWith` 并入 `readStringList`；将 `classifyIpc` 返回类型改为非空元组，删除 `classifyIpcTop` 的不可达分支与 `v8 ignore` | P3 | 去掉三处类型/分支噪声，减少一个私有间接层 | `typecheck` 通过；现有 IPC 与草案用例不变；若不愿改公开返回类型，可只保留前两项 |
| C-05 | `ipc/ipc-classifier.ts:718`；`draft/validate.ts:719` | 修正 `classifyIpc` 注释（代码只返回命中部，不返回未命中部）；重复槽位文案的“可用项”只列 schema 槽位，不再包含已出现的重复 id | P3 | 文档与实现一致，错误信息不再自指 | 新增一条重复槽位文案断言；JSDoc 由 `doc-sync` 覆盖 |

## 14. D6 明确不建议的合并

- **不合并** `validateSpecDraft` 与 `validateTemplateDraft`：两者的槽位模型、错误词汇与准入条件不同，合并会把分支集中到一个函数。
- **不把 IPC 关键词表改为 YAML 资产**：`classifyIpc` 目前是同步纯函数；走资产需要 loader、路径候选与解析校验（同 `ipc-standards-loader.ts`），增加失败面而没有共享收益。
- **不把 IPC 置信度阈值改为配置**：这些是模型注入策略的固定常量，没有部署差异证据；随意暴露会扩大配置面。
- **不预先缓存小写关键词**：单次分类约 434 次 `toLowerCase`，无测量证据表明构成热点；先做基准再决定。
- **不冻结导出的 IPC 表**：没有外部改写证据；改为 `readonly` 会带来公开类型变动，留待真实需求。
- **不引入通用校验框架**：`meta`、规格草案、模板草案三套结构差异明显，通用框架会把当前直白的分支藏进抽象。
