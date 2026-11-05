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

## 15. D7 失败路径矩阵

D7 范围：`subprocess-runner.ts`（80 行）、`ego-session.ts`（251 行）、`cnipr-channel.ts`（169 行）、`search-provider.ts`（31 行）、`nuo-channel.ts`（168 行）。`patent-data` 内没有凭据解析代码，见 §18。

| 路径 | 当前表现 | 已有覆盖 | 结论 |
|---|---|---|---|
| 排队前取消 | `AbortError`，不启动脚本 | 有 | 正常 |
| 运行中取消 | 空输出报 `receipt_missing`；有收据则照常返回；运行器因取消拒绝时报普通启动失败 | 无 | R-44，P2 |
| 正常超时 | `timedOut` → `timeout` 错误码 | 有 | 正常 |
| 收据缺失/不可解析 | `receipt_missing`，附尾部输出 | 有 | 正常 |
| 脚本级失败 | `login_required` / `page_state` | 有 | 正常 |
| 浏览器不可用 | `setup_required` | 有 | 正常 |
| 脚本启动失败 | 普通 `Error`，无通道错误码 | 无 | R-46，P3 |
| 排队等待中取消 | 等前序任务完成后抛 `AbortError` | 有 | 文档已声明，接受 |
| 检索行缺号 | 静默丢弃，`total` 不变 | 无 | R-45，P3 |
| 输出超限 | 按头部截断，收据可从 `stderr` 恢复 | 有 | 正常 |
| 连接探测失败 | 返回 `false`，不抛错 | 有 | 探测契约 |
| 失败后重试 | 无内置重试 | — | 由调用方按错误码决定 |

## 16. 错误码统一

| 类别 | 触发 | 可重试性 | 处理 |
|---|---|---|---|
| `setup_required` | 浏览器命令不可用 | 否，先修环境 | 保持 |
| `login_required` | CNIPR 登录失效 | 否，先登录 | 保持 |
| `page_state` | 页面结构或收据骨架变化 | 条件性，重跑一次可验证 | 保持 |
| `receipt_missing` | 脚本未回传收据 | 条件性，先看尾部输出 | 保持 |
| `timeout` | 运行超时 | 是，增大预算或退避 | 保持 |
| `AbortError` | 调用方取消 | 否 | 不新增 `aborted` 错误码；按 R-44 统一 |
| 启动失败 | 命令存在但 `spawn` 失败 | 否，先修环境 | R-46：归入通道错误 |
| Nuo 搜索异常 | `nuo` 引擎抛错 | 未知 | 暂不包装，见 §18 |

结论：CNIPR 的 5 个错误码足以表达通道级失败；取消不是通道失败，统一抛 `AbortError`。启动失败需要补一个通道错误入口（R-46），否则按 `code` 路由的调用方会漏掉。

## 17. D7 精简候选

| ID | 位置 | 候选动作 | 优先级 | 预期收益 | 等价性验证 |
|---|---|---|---|---|---|
| C-06 | `cnipr-receipt.ts`（418 行） | 拆为 `receipt/numbers.ts`（号码归类与日期）、`receipt/pdf.ts`、`receipt/legal.ts`、`receipt/search.ts`、`receipt/index.ts` 重导出；通道与包入口的公开导出不变 | P2 | 单文件降至约 150 行，超 400 行文件数 −1；三类收据的字段读取就近 | 仅移动与重导出；`cnipr-receipt` 与通道用例全绿，公开导出签名不变 |

## 18. D7 范围校正与不做项

- **凭据解析在本包没有实现**：`patent-data` 不解析用户名、密码或 token；CNIPR 登录态由 ego 浏览器 profile 与页面登录检测承担。D7 计划中的“凭据解析”若指其他包，应另立条目，不在本次审查中虚构实现。
- **不新增 `aborted` 错误码**：取消是控制流信号，不是通道失败；统一抛 `AbortError` 才能与超时、收据缺失区分。
- **不内置自动重试**：当前没有消费者按错误码选择重试；先由调用方按 §16 的“可重试性”决策，避免在通道内隐藏重试预算。
- **不把排队等待改成可取消**：`CniprCallOptions` 已声明取消不会跳过前序调用；改动会破坏顺序保证，换来的只是缩短等待。
- **不包装 Nuo 搜索异常为 `CniprChannelError`**：两者是不同通道、不同错误面；等出现统一路由的消费者再抽公共错误层。

## 19. D8 复核结果

D8 范围：`patent-knowledge`（法规/判例 FTS 引擎、KG 关键词检索、知识库打开协议）与 `patent-index-asset`（字段读取器、条目录入、来源记录、索引资产格式）。基线测试：两包 21 个测试文件 / 220 条用例全部通过；`patent-index-asset` 测试比 0.27（103 / 376）。

| 风险 | 复现输入 | 实际结果 | 处理 |
|---|---|---|---|
| R-47 | `search('专利审查', { limit: 2.5 })`；`search(kw, { limit: Number.NaN })`；`limit: -1` | 前两者抛 SQLite `datatype mismatch`；NaN 还使 `ftsAvailable` 变 false（粘性降级）；`-1` 绑定为 `LIMIT -1` | 已修：上限归一到 patent-core 的 `resolveResultLimit`，工具层与三个检索入口共用；四个 spec 补小数/0/负数/NaN 用例 |
| R-48 | `search('创造性\u0000判断')`；`KgStore.searchByKeyword('创造性\u0000判断')`；`searchByKeyword('\u0000')` | 法规/判例引擎 FTS5 抛 `unterminated string` 后永久降级；KG 把原始错误抛给调用方；NUL-only 在 LIKE 下返回 1 条 | 已修：`sanitizeSearchText` 进入 patent-core 的 FTS 工具并经 shim 再导出；检索入口去 NUL，三处补 NUL 用例 |
| R-49 | 资产 `topics: [" 新颖性 "]` + `text: null`，命题「该方案具备新颖性」 | `topicOverlap` 按原文比较，判 `unmatched` | 已修：`readEntryTopics` 返回 trim 后的关键词；双语 README 同步 |
| R-50 | `decideArticleCitation({ article: 33, paragraph: 99 }, cnPatentLaw, entry33)` | 第 33 条已转录、无 `paragraphs`，判定 `valid` 并附官方来源；对照第 22 条第 9 款正确报 `mismatch` | 未修：跨域判定语义与资产补录，留 D18–D19 |

结论：FTS 检索入口不再把调用方的错误输入当成 FTS 故障；索引读取的转录记录、重复条号与 YAML 结构边界有测试固定。R-50 是数据完整性 + 判定语义问题，D8 只登记，不在本日改判定。

## 20. D8 索引读取边界测试矩阵

| 输入 | 期望 | 覆盖 |
|---|---|---|
| `articles` 缺失 / null | 空列表 | `entries.spec.ts` |
| `articles` 非数组 / 条目非映射 | 拒绝并点名 `articles` | 同上 |
| article 缺失 / 0 / 小数 / 字符串 / 重复 | 拒绝；重复报 `article 重复：N` | 同上 |
| `paragraphs` 缺失 / null | 不产生该字段（保持未核验） | 同上 |
| `paragraphs` 空数组 / 标量 / 0 / 小数 / 字符串 | 拒绝并点名第 N 条 | 同上 |
| `topics` 缺失 / 空 / 含非字符串 / 含空白项 | 拒绝 | 同上 |
| `topics` 带首尾空白 | 返回 trim 后的关键词 | 同上 |
| `text` 与 `sourceDoc`/`verifiedOn` 只出现一部分 | 拒绝（全有或全无） | 同上 |
| YAML 重复键 / 多文档 | 拒绝（不静默取其一） | 同上 |
| FTS limit 小数 / 0 / 负数 / NaN / Infinity | 取整并夹在 `[1, max]`；非法值回退默认；`ftsAvailable` 不变 | `knowledge-law-search.spec.ts`、`case-law-search.spec.ts`、`kg-store.spec.ts` |
| FTS 检索词含 NUL / 仅 NUL | 去掉 NUL 后检索；仅 NUL 返回空；不降级、不抛原始错误 | 同上 |
| 共享上限/清洗函数直接边界 | 小数截断、非有限值回退、负值夹到 1、上限夹到 max；NUL 去掉 | `patent-core/tests/knowledge-query.spec.ts` |

测试增量：`patent-index-asset` 测试行 103 → 263（测试比 0.27 → 0.69，源码 381 行），新增 6 个 describe 级分组；`patent-knowledge` 新增 5 条用例。

## 21. D8 精简候选

| ID | 位置 | 候选动作 | 优先级 | 预期收益 | 等价性验证 |
|---|---|---|---|---|---|
| C-07 | `knowledge-law-search.ts:422-427` | `searchLike` 在 `!options.level` 早返回后仍有 `if (options.level)` 复查（带 `v8 ignore`），删除复查与忽略注释，直接把 level 视为已定义 | P3 | 去掉一段不可达分支与一处覆盖率逃逸 | `typecheck`；等级过滤与降级用例不变 |
| C-08 | `patent-core/src/knowledge/fts.ts:37,50` | NUL 清洗已共享到 patent-core，但 `legal-knowledge` 的引擎入口还没有调用；把它并进 `escapeFtsPhrase` 或两条 legal 引擎入口，与 R-10/D19 的共享 FTS 核心一起做 | P2 | 两域共享一处查询清洗，不再依赖各引擎入口自觉 | `fts.spec` 与 `legal-knowledge` 的 `sqlite-search.spec` 同时通过；NUL 用例在 legal 侧同样成立 |
| C-09 | `wiki-card-loader.ts`、`graph-traversal.ts` | 把 `normalizeResultLimit` 同样用到 `list/search/byConcept/byDomain/getNeighbors/listByType`：负值目前经 `Array.slice(0, -1)` 丢掉末条，图谱入口直接绑定 `LIMIT -1` | P3 | 非 FTS 检索入口的上限语义与 FTS 一致 | 各方法补负值/小数为 `[1, ∞)` 的用例；现有正常路径不变 |

## 22. D8 范围校正与不做项

- **不给索引资产加未知键校验**：`readArticleEntries` 现在忽略未知键，是 `patent-index-asset` README 已声明的限制；收紧需按每个消费方声明允许键集合。`legal-law` 的 7,911 个资产文件与 `patent-fees` 的 `effectiveFrom` 扩展字段都依赖当前兼容性，留 D19/D20 与 R-10 一起评估。
- **不改款号窄化语义（R-50）**：跳过 `paragraphs` 缺失的条目是 `patent-law/tests/verify.spec.ts:156` 固定的行为；改成 `unverified` 会同时影响 `legal-law` 的判定与策略配置，属于跨域产品决策，不在 D8 落地。
- **不合并 `patent-knowledge` 与 `legal-knowledge`**：两包仍各自持有同构引擎（R-10）；D19 先做查询行为对比，再决定共享核心，避免在 D8 顺手移动 600+ 行。
- **不在本日清洗全部控制字符**：只处理在 SQLite 边界上会截断查询的 NUL；换行、制表符在短语内可正常匹配，扩大清洗面没有失败证据。

## 23. D9 复核结果

D9 范围：`patent-law`（13 个源码文件 / 2,838 行）与 `patent-fees`（7 / 1,516 行），复核三个判定面：引用判定（`reference.ts`、`verify.ts`、`citator.ts`、`rule-lock.ts`）、费用档位与滞纳金（`fees.ts`、`compute.ts`、`assets/fees/cn-fees.yaml`）、减缴（`compute.ts` 与同一资产）。基线：两包 19 个测试文件 / 386 条用例全部通过（patent-law 13 / 273；patent-fees 6 / 113）。复核后两包 20 个测试文件 / 405 条通过（patent-law 13 / 281；patent-fees 7 / 124），`patent-index-asset` 54 条（新增 1 条重复款号用例）。

| 风险 | 复现输入 | 修复前实际结果 | 处理 |
|---|---|---|---|
| R-51 | `computeFees(loadFeeTable(), { patentType: 'invention', triggers: ['annual-fee'] })`；`triggers: ['filing'], specificationPages: 20` | 前者 `amount: '0.00', complete: true`；后者 `'950.00', complete: true`，而 `pending` 仍列着缺 `claims`/`priorityClaims` 的费种 | 已修：待补项进入 `unverifiedIds` 并使 `complete: false`；严格策略扣住合计 |
| R-52 | 年费条目有金额与 `verifiedOn`、无 `latePayment`；`annuityYears: [4], lateMonths: 3` | 只报年费一行，`total: { amount: '900.00', complete: true }` | 已修：追加未定价滞纳金行（`unrecorded`），合计 withheld |
| R-53 | `lockProvisions(['专利法第22条第9款'], testBaselines())` | `validityStatus: 'active'`、`unverified: []`（第 22 条只载明 3 款） | 已修：citator 在普通与沿革 `active` 路径检查款号；缺款判 `unverified` |
| R-54 | `queryValidity({ provision: '审查指南第二部分第四章3.2', revision: '2025 年修订版' }, shipped)` | 按基线文本 + `supersededBy` 判 `revised` | 已修：显式未知修订版判 `unverified`，与 `law_verify` 一致 |
| R-55 | `parseLawReference('专利法第22条第十十款')`；同形的 `第十十项`、`第（十十）项` | 降级为条级引用，`verifyCitation` 判 `valid`，`unrecognized` 为空 | 未修：共享解析器同时服务 legal-law，随 R-01 在 D18 收敛；D9 只登记失败用例 |
| R-56 | 减缴项目 `requiresFiling: false`、请求 `filed: false` | `notes` 含“本次减缴请求未办理费减备案。”，同时应付已按 85% 计算 | 已修：提示只在 `requiresFiling === true` 时输出 |
| R-57 | `paragraphs: [1, 1, 2]` | 载入成功，`law_verify` 报“共 3 款” | 已修：`readParagraphs` 拒绝重复款号 |

结论：费用侧的两处“未知当零”（待补输入、滞纳金规则缺失）已改为扣住合计；引用侧的 rule-lock 与 `law_verify` 对缺款、未知修订版的判定已一致。R-55 是解析器级的降级，改动会同时影响 legal-law 的引用语法，按 D18 的两域收敛处理，不在 D9 夹带。

## 24. D9 判定用例矩阵

### 24.1 引用判定

| 判定面 | 输入 | 期望 | 覆盖 |
|---|---|---|---|
| 条已转录、无命题 | `专利法第22条` | `valid` | `verify.spec.ts` “passes an article whose text is verified” |
| 主题词支撑 | `第22条` + 命题“不具备创造性” | `valid` | `verify.spec.ts` “passes a proposition the entry carries…” |
| 正文逐字支撑、主题词未命中 | 第 47 条 + “宣告无效的专利权视为自始即不存在” | `valid` | `verify.spec.ts` “accepts a verbatim clause…” |
| 命题落在别条 | 第 22 条 + “说明书充分公开” | `mismatch` 并点名第 26 条 | 同上 |
| 款号不存在（law_verify） | `第22条第9款`，条目载明 [1,2,3] | `mismatch`，理由含“共 3 款” | `verify.spec.ts` “reports a cited paragraph…” |
| 款号不存在（rule-lock） | 同上，走 citator | `unverified`，不进 `rule_lock_locked` 的 active | `citator.spec.ts:107`、`rule-lock.spec.ts:83`（R-53） |
| 条目未登记款号 | 条目无 `paragraphs`、引用第 9 款 | 跳过款号窄化、判 `valid`（R-50，待 D18） | `verify.spec.ts` “skips the paragraph check…” |
| 条目已索引未转录 | 细则第 5 条 | `unverified` | `verify.spec.ts` “reports an indexed article…” |
| 超出已核验上限 | 第 99 条，上限 82 | `out-of-range` | 同上 |
| 超出未核验上限 | 上限 82、`maxVerifiedOn: null` | `unverified` | 同上 |
| 条不在索引 | 第 78 条 | `not-indexed` | 同上 |
| 法律未随包 | 空索引 | `not-indexed` | 同上 |
| 指南节正文 | `第二部分第四章3.2` | `valid` | `verify.spec.ts` “passes a verified section…” |
| 指南容器由子节承载 | `第四部分第三章4.4` + 子节命题 | `valid`，理由点名 4.4.1 | `verify.spec.ts` “decides a section by what its subsections say” |
| 指南节被新版取代 | 2023 文本 + `staleSections` | `unverified`，点名取代版本 | `verify.spec.ts` “reports a citation to the stale section…” |
| 指南版本覆盖 | 指定 2026 覆盖版本 | `valid`，来源为 2026 修改对照表 | `verify.spec.ts` “decides against the named revision” |
| 指定未知版本 | `revision: '2025 年修订版'` | `verify` 与 `citator` 均 `unverified` | `verify.spec.ts` “reports a revision the index does not carry…”；`citator.spec.ts:122`（R-54） |
| 指南节不在索引 | `第九部分第九章9.9` | `not-indexed` | 同上 |
| 未识别片段 | “另见第99条” | `unrecognized` 含 `第99条` | `reference.spec.ts` “reports fragments…” |
| 条号数字非法 | `专利法第十十条` | 无引用 | `reference.spec.ts` “skips a statute reference…” |
| 款/项数字非法 | `专利法第22条第十十款` | 期望无引用并把片段列入 `unrecognized`；当前降级为条级 | 复现见 R-55（未修） |
| 续指继承 | `第22条、第23条第3款第（二）项` | 两条引用，后者 23/3/2 | `reference.spec.ts` “carries the context through a narrowing chain” |
| 政策映射 | 六个判定 × block/warn/allow | `valid` 恒 `allow`，其余按配置 | `verify.spec.ts` “maps each decision to its policy…” |
| 沿革覆盖 | lineage `active` / `repealed` | 状态取沿革；生效日取最近修订 | `rule-lock.spec.ts` “沿革快照接入” |
| 沿革 active + 缺款 | lineage active、第 22 条第 9 款 | `unverified`，仍带修订历史 | `citator.spec.ts:226`（R-53） |

### 24.2 费用档位、滞纳金与减缴

| 判定面 | 输入 | 期望 | 覆盖 |
|---|---|---|---|
| 金额已核验 | `amount` + `verifiedOn` | `verified`，计入合计 | `compute.spec.ts` “totals a fully transcribed item” |
| 金额已记录未核验 | `verifiedOn: null` | `unverified`，扣合计 | 同上 |
| 金额未转录 | `amount: null` | `unrecorded`，扣合计 | 同上 |
| 零数量未转录行 | 说明书 20 页（免费基数 30） | 不扣合计 | `compute.spec.ts` “does not withhold the total…” |
| 待补输入 | 缺 `claims`、`annuityYears`、`priorityClaims` 等 | `pending` + 扣合计 + `unverifiedIds` 列该 id | `compute.spec.ts:188,271`；`tool.spec.ts:107`（R-51） |
| 环节未收录 | `grant-registration` | `uncoveredTriggers` + 扣合计 | `compute.spec.ts` “withholds the total when a named trigger…” |
| 按类型排除 | design + `substantive-examination` | 不当作未收录 | `compute.spec.ts` “does not treat a trigger with items excluded…” |
| 分档命中 | 第 2、5 年度 | 900 / 1200 | `compute.spec.ts` “prices each requested patent year…” |
| 分档未覆盖 | 仅 1–3 档、查询第 9 年度 | 无金额 + “未落在已转录的分档内” | `compute.spec.ts` “flags a year the transcribed tiers do not cover” |
| 无分档时用单价 | `amount: '900'`、无 tiers | 900 | 同上 |
| 滞纳金窗口内 | 第 5 年度 1200、`lateMonths: 1` | 60/月，累计 60 | `compute.spec.ts` “takes the surcharge base from the year tier” |
| 滞纳金超窗 | `lateMonths: 8`、`maxMonths: 6` | 不给金额 + 终止说明 + 扣合计 | `compute.spec.ts` “refuses the surcharge once the payment window…” |
| 滞纳金规则缺失 | 无 `latePayment`、`lateMonths: 3` | `unrecorded` 行 + 扣合计 | `compute.spec.ts:384`（R-52） |
| 无超期 | `lateMonths: 0` | 不追加滞纳金行 | `compute.spec.ts` “adds no surcharge without a delay” |
| 减缴 85% 已备案 | individual / filed | 应付 15% | `compute.spec.ts` “applies a reduction…” |
| 未备案 | filed false、需备案 | 全额 + 提示 | `compute.spec.ts` “keeps the full amount…” |
| 不要求备案 | `requiresFiling: false`、filed false | 减缴照算且无未备案提示 | `compute.spec.ts:456`（R-56） |
| 减缴范围未登记 | `reducible: null` | 全额 + 提示 | `compute.spec.ts` “reports an unrecorded reduction scope…” |
| 比例未转录 | `reductionPercent: null` | 不给应付 + 扣合计 | `compute.spec.ts` “refuses a reduced figure…” |
| 减缴未登记 | 索引无该 programme | 不给应付 + 说明 | `compute.spec.ts` “reports a reduction programme the index does not carry” |
| 年费减缴年度上限 | 第 7 年度、`reductionMaxYears: 6` | 全额 + 提示 | `compute.spec.ts` “stops the reduction at the year cap…” |
| 金额算术 | `parseYuan` / `formatFen` / `applyPercent` | 整数分；百分比半值向上 | `money.spec.ts` |
| 索引非法 | 重复 id、坏金额、分档重叠、缺 `freeUnits`、迟到规则挂在非年费项 | `FeeTableError` | `fees.spec.ts` “rejects …” |
| 款号列表重复 | `paragraphs: [1,1,2]` | 拒绝加载 | `entries.spec.ts:96`（R-57） |

## 25. D9 来源记录检查

| 记录 | 检查结果 | 证据 |
|---|---|---|
| 费用收费标准的文书、版本、核验日期 | `document`、`revision: 2026 年 8 月版`、`sourceDoc`、`verifiedOn: 2026-09-26` 均已记录 | `source-records.spec.ts:18` |
| 已定价费种的金额来源 | 17 个有金额或分档的条目全部有 `sourceDoc` + `verifiedOn` | `source-records.spec.ts:25` |
| 未定价费种 | `specification-surcharge`、`extension-fee` 有规则来源、`amount: null`、`verifiedOn: null`（没有金额就没有金额核验） | `source-records.spec.ts:34` |
| 法条依据 | 19 条 `legalBasis` 均非空；每条引用经 `patent-law` 索引判定为 `valid`（条、款均存在且已转录） | `source-records.spec.ts:82` |
| 年费档位 | 3 个年费条目：`amount: null`、tiers 从第 1 年连续、`reducible: true`、`reductionMaxYears: 10`、`latePayment: 5%/6 个月` 且来源与核验日期齐全 | `source-records.spec.ts:47,63` |
| 减缴 | 个人 85% / 企业 70%，均 `requiresFiling: true`，来源与核验日期齐全 | `source-records.spec.ts:72` |
| 费用生效日 | 全表 `effectiveFrom: null`：官方缴费指南未印生效日，资产不重复抄录发布日期；已由 `fees.spec.ts` 固定 | `fees.spec.ts` “loads the packaged index…” |
| 法条与指南的转录记录 | 37 条《专利法》、45 条《实施细则》全部有 `text` + `sourceDoc` + `verifiedOn`；两个上限均有 `maxSource` + `maxVerifiedOn` | `baseline.spec.ts:451,462` |
| 款号列表 | 随包每条法条的 `paragraphs` 无重复款号；加载器也会拒绝重复 | `baseline.spec.ts:472`、`entries.spec.ts` |
| 指南 | 83 条（65 条带正文 + 18 条容器）；3 条 2026 覆盖、3 条 stale 记录均指向已索引节 | `baseline.spec.ts:443`、`baseline.spec.ts` 的 stale/version 用例 |
| 沿革 | 37 条法条 × 5 个修订；每条历史的 `revision` 都在 `revisions` 目录中、日期与目录一致且按时间升序 | `lineage.spec.ts:79` |

结论：费用侧的金额、规则、减缴三类记录与法条依据均可逐项追到来源；法条/指南/沿革的转录记录仍由加载器的 all-or-nothing 规则兜底。两项已知内容缺口不在本轮修：R-50 的 13 条《专利法》条文未登记款数（D18/D19），以及指南 2026 年合订全文未随包（README 已声明 64 条基础节仍为 2023 文本）。

## 26. D9 精简候选

| ID | 位置 | 候选动作 | 优先级 | 预期收益 | 等价性验证 |
|---|---|---|---|---|---|
| C-10 | `compute.ts` 的 `annuityLine` 与 `annualFeeAmount` | 两处都在做 “year 落在哪个 tier” 的同一查找，抽 `tierAmount(item, year)`；`annuityLine` 额外保留“未覆盖”的说明分支 | P3 | 分档查找只有一处，滞纳金基数与年费行不会漂移 | `compute.spec.ts` 全部年费用例零改动通过 |
| C-11 | `citator.ts` 的 `resolveGuidelineView` 与 `verify.ts` 的 `buildGuidelineView` | 两份版本合并实现已发生漂移（R-54 即其一）；抽 `guideline-view.ts`，两边共用并各自保留缓存 | P2 | 同一 baseline + revision 在两个入口得到同一视图 | 对随包指南与 3 个构造 baseline 做逐节深比较；`verify.spec.ts`/`citator.spec.ts` 全绿 |
| C-12 | `patent-core/knowledge/article-decision.ts` 的 `checkNarrowing` 与 `citator.ts` 的 `paragraphGap` | 缺款判断现在有两份文案（`mismatch` / `unverified`）；抽一个纯谓词，状态映射留在各入口 | P3 | 款号存在性只有一处实现，两个判定面的文案不会再次分叉 | `verify.spec.ts` 缺款用例与 `citator.spec.ts` 新增用例同时通过 |
| C-13 | `rule-lock.ts` 的 `RuleLockEntry` | `ValidityResult.reason` 在 `lockOneProvision` 之后被丢弃，报告只有四态标签；给条目加 `reason` 并仅在非 active 时渲染 | P3 | 规则锁定门能说明“为什么未判定”，不必再调 `law_verify` | 现有 `rule-lock.spec.ts` 的 `toMatchObject` 用例不回归；新增一条缺款理由断言 |

## 27. D9 范围校正与不做项

- **不改 R-50 的款数语义**：`entry.paragraphs === undefined` 时跳过款号窄化是 `patent-law/tests/verify.spec.ts` 固定的行为，改成 `unverified` 会影响 `legal-law` 与规则资产，留 D18/D19 的跨域决策。
- **不在 D9 改共享引用解析器（R-55）**：`readStatuteArticleCandidate` 同时被 `patent-law` 与 `legal-law` 使用；把不可解析的款/项从“静默降级”改为“整条拒绝”会同时改变两域语法，应随 R-01 的解析器收敛一次完成。
- **不合并 `patent-law` 与 `legal-law`**：同构实现的分叉仍是 R-01/R-10；D18 先做行为等价矩阵，再抽共享核心。
- **不把指南 2026 全文补进索引**：本地只有官方修改对照表，没有 2026 合订全文；README 已声明 64 条基础节仍按 2023 文本判定，且 3 条已确认改动已用 `versions` 覆盖。
- **不检查项号（`第X项`）**：索引只登记到款，项号只回显、不判定；要拒绝错项需要项级索引（README 已列为限制）。
- **不给 `asOf` 加时间感知判定**：`rule_lock_as_of` 已读取但沿革数据没有 repealed/修订生效的时间语义；`ValidityQuery.asOf` 仍为预留字段。
- **不裁决 `amount` 与 `tiers` 并存**：加载器允许条目同时声明两者，`compute` 在 `tiers` 非空时只用分档；这是“先录单价、后补分档”的迁移形态，`fees.spec.ts` 的 complete-table 用例也按此形态写。是否拒绝留待分档价格字段真正扩展时决定。
- **不为库调用补整数校验**：`lateMonths` 等数量在工具层已要求非负整数；`computeFees` 是类型化同进程 API，按仓库规则不在该边界加运行期校验。非整数 `lateMonths` 经直接库调用会产生不足一分的金额，属调用方违约，D9 不扩大公开面。
- **不把 `grant-registration` 映射到授权当年年费**：需要授权年度，查询不带；索引保持未收录并扣合计（README 已声明）。
