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

## 10. D5 待验证项的处理

R-35–R-40 目前只有源码阅读证据，没有可执行复现。进入 D5 时先各写一个最小复现；无法复现的条目从风险登记册删除，不进入修复排期。
