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

## 28. D11 工具层抽样结果

D11 范围：`patent-tools` 的工具层（schema、结果结构、错误码、结果上限）。源码基线 145 个文件 / 37,012 行；`index.ts` 131 条 `export` 语句、373 个导出名（含类型）；`wiring.ts` 实际注册 37 个 `create*Tool` 工厂。模块注释写「36 个工具」（`index.ts:2`）与「35 个工具」（`wiring.ts:2`），两处计数与 37 个工厂不一致，属文档漂移，随 R-09 记录，不单列风险。

抽检 27 个入口：查询 8（`patent_search`、`patent_metadata`、`patent_legal_status`、`law_search`、`patent_case_search`、`patent_wiki_search`、`patent_kg_query`、`search_patent_figure`）、判定/校验 7（`evaluate_evidence`、`rule_check`、`claim_lint`、`domain_check`、`validate_specification`、`patent_eval`、`parse_office_action`）、状态机/写盘 7（`patent_plan_task`、`flexible_plan`、`patent_workflow_run`、`patent_workflow`、`knowledge_note_save`、`matter_log_append`、`workbench_link_patent_case`）、报告/下载/图形/契约校验 5（`patent_analysis_report`、`claim_chart_build`、`patent_pdf_download`、`analyze_patent_figure`、`patent_worker_validate`）。另读 `tool/internal/` 的 `tool-input.ts`、`tool-output.ts`、`query-limit.ts`、`bounded-retry.ts`、`approval-gate.ts`、`knowledge.ts`、`upstream-channel.ts`。`generate_patent_figure` / `generate_structure_figure` 的几何与渲染路径留 D12，只核对 schema 与错误映射。

方法：逐入口读参数 schema、execute 的边界读取、输出 schema 与 render 的取值；可疑路径写临时 spec 直接执行，并用 `executeToolFixture` 校验输出 schema。复现 spec 11 组（10 组契约输入 + 1 组空白输入阴性对照）运行后删除，未进入产品测试。

## 29. D11 工具契约问题清单

以下 9 项均已用最小输入、schema 检查或代码路径确认，详情见风险登记册 R-58–R-66。级别按第 3 节标准判定。

| 风险 | 类别 | 证据 | 最小复现 / 实际结果 | 级别 |
|---|---|---|---|---|
| R-58 | 错误码 | `law-search.ts:210-216`、`patent-case-search.ts:165-171` | 注入的检索函数抛 `SQLITE_BUSY: database is locked` → `setup_required`，文案要求重装 knowledge.db | P2 |
| R-59 | 错误码 | `patent-search.ts:305-328`、`patent-metadata.ts:361-382` | 上游抛 `socket hang up` → 只尝试 1 次，抛出裸 `Error`（无 `code`、无 channel、无 attempts） | P2 |
| R-60 | 结果结构 | `patent-search.ts:341` 对照 `patent-wiki-search.ts:153`、`patent-kg-query.ts:144,161`、`law-search.ts:234`、`patent-case-search.ts:184`、`search-patent-figure.ts:319` | 3 条命中、limit 2 → `total: 2`；`patent_search` 50 条命中、上游 total 120 → `total: 120`；同名 `total` 两种语义 | P2 |
| R-61 | schema | 12 个工具文件的 26 个输出字段；如 `evaluate-evidence.ts:174`、`patent-analysis-report.ts:180-186`、`claim-chart-build.ts:297` | `{type:'json'}` 不做字段校验，28 处 `as unknown as JsonValue` 因此存在 | P2 |
| R-62 | 结果上限 | `patent-search.ts:299`、`patent-wiki-search.ts:148`、`search-patent-figure.ts:290` | `limit: 100` → 50 条命中、`warnings: []`；`limit: 2.5` 直接进入 `Array.slice`，未按 `resolveResultLimit` 取整 | P3 |
| R-63 | 结果上限 | `analyze-patent-figure.ts:369` | 5000 字 `claim_context` → 提示词 4033 字，无截断标记，参数说明未给上限 | P3 |
| R-64 | schema | `patent-kg-query.ts:148-161,254-255` | `node_type: 'Case_typo'` → `total: 0`、无错误；schema 未把类型列为 enum | P3 |
| R-65 | schema / 结果 | `patent-legal-status.ts:233-236` | `patents: []` → 成功返回 `{results: [], warnings: []}`，渲染“0 result(s)”；参数声明 1–20 条 | P3 |
| R-66 | schema | `patent-metadata.ts:363`、`patent-legal-status.ts:236` | `timeout: 0` 原样传给抓取（上游按 0ms 超时）；`maxConcurrency: 0` → 1、`2.5` → 2，均无提示 | P3 |

## 30. D11 结果上限与错误码矩阵

### 30.1 查询工具的 limit 归一

| 工具 | 归一实现 | 默认 / 上限 | 超限 | 小数 |
|---|---|---|---|---|
| `patent_search` | `Math.floor` + 夹取（`patent-search.ts:299`） | 10 / 50 | 静默截到 50，无告警 | 向下取整 |
| `patent_wiki_search` | `Math.max/min`（`patent-wiki-search.ts:148`） | 5 / 10 | 静默截到 10 | 原样传入 loader，`slice` 再截 |
| `search_patent_figure` | `Math.max/min`（`search-patent-figure.ts:290`） | 5 / 10 | 静默截到 10 | 原样传入检索，`slice` 再截 |
| `law_search` | `resolveResultLimit`（`law-search.ts:192`） | 5 / 10 | 截到 10 | `Math.trunc` |
| `patent_case_search` | `resolveResultLimit`（`patent-case-search.ts:160`） | 5 / 10 | 截到 10 | `Math.trunc` |
| `patent_kg_query` | `resolveResultLimit`（`patent-kg-query.ts:247`） | 5 / 10 | 截到 10 | `Math.trunc` |

结论：同一工具层存在两套上限实现；R-47 已把 FTS 的上限归一到 `resolveResultLimit`，工具层还剩 3 个入口使用各自的夹取。`patent_search` 是唯一按 50 条截断的查询工具，且不像 CNIPR 第二通道那样写截断告警。

### 30.2 错误码映射

| 场景 | 工具 | 当前 code | 结论 |
|---|---|---|---|
| 服务未注入 / dbPath 不存在 | 查询工具 | `setup_required` | 正常 |
| `asOf` 非法 | `law_search` | `invalid_tool_input` | 正常 |
| 检索函数抛任意异常 | `law_search`、`patent_case_search` | `setup_required` | R-58：瞬时锁、SQL 错误、程序错误都被读成“未安装” |
| 上游检索 / 抓取抛异常 | `patent_search`、`patent_metadata` | 无（裸 `Error`） | R-59：绕开稳定 code 与重试；与工具描述“重试两次并点名通道”不一致 |
| 图索引读取抛非 `setup_required` | `search_patent_figure` | `tool_execution_failed` | 正常（保留 `setup_required`） |
| 写盘 / 审批 / 取消 | `knowledge_note_save`、`patent_workflow_run`、`workbench_link_patent_case` | `tool_execution_failed` / `tool_aborted` | 正常 |

结论：20 个 `PatentToolErrorCode` 中 `patent-tools` 实际只用到 7 个（`invalid_tool_input`、`tool_execution_failed`、`setup_required`、`file_not_found`、`tool_aborted`、`tool_timeout`、`model_cannot_accept_image`）；未使用的 13 个多数是 Sati 协议遗留，D11 不删（可能被下游按码路由），但 R-58/R-59 说明“按码路由”本身还不完整。

### 30.3 输出 schema 的 `type: 'json'` 字段

| 工具 | 字段 |
|---|---|
| `patent_analysis_report` | `ipc`、`technicalFeatures`、`featureStatistics`、`scores`、`innovationInsights`、`expertConsiderations`、`searchStrategy` |
| `claim_chart_build` | `chart`、`infringement_conclusion`、`invalidity_conclusion` |
| `triz_contradiction_analysis` | `contradictions`、`parameter_gaps`、`unmapped` |
| `evaluate_evidence` | `judgment`、`burden` |
| `patent_workflow_run` | `evidenceLedger`、`graphState` |
| `patent_eval`、`patent_flexible_plan`、`patent_metadata`、`patent_workflow` | 各 2 / 2 / 1 / 1（`details`+`searchStrategy`、`plan`+`run`、`data`、`interrupted`） |
| `law_search`、`patent_case_search`、`parse_office_action` | 各 1（`searchStrategy`、`searchStrategy`、`parsed`） |

共 12 个文件、26 个字段。固定结构的 DTO（如 `judgment` 的四个分项、`scores`、`details`）应先换成具体 schema；动态键映射可以保留 `json` 并在字段说明里写明。

## 31. D11 已确认缺陷的回归测试清单

以下用例在对应修复 PR 中先加、后修；修复前必须是失败用例，修复后转绿。不要把当前错误行为写成期望。

| 风险 | 测试位置 | 输入 | 期望 |
|---|---|---|---|
| R-58 | `tests/law-search.spec.ts`、`tests/data-knowledge.spec.ts` | 注入的 `searchLaw` / `search` 抛 `SQLITE_BUSY: database is locked` | 抛 `tool_execution_failed`，消息保留原始错误；不得出现安装指引 |
| R-59 | `tests/data-tools.spec.ts` | `search` / `scrape` 抛 `socket hang up` | `PatentToolError`，code 为 `tool_execution_failed`，消息含通道与尝试次数；若决定保留裸抛，则同步改工具描述并加注释，不保留两者不一致 |
| R-60 | `tests/data-knowledge.spec.ts`、`tests/knowledge-tools.spec.ts` | 12 条命中、limit 5；3 条命中、limit 2 | `total` 语义按选定方案固定：保留“返回条数”则改名/补 `matchedTotal`，保留“命中总数”则被截断的工具返回未截断计数 |
| R-61 | 新增工具 schema 断言（可用 `executeToolFixture`） | 固定结构输出少一个必填字段 | 输出校验失败；固定结构字段不再声明为 `type:'json'` |
| R-62 | `tests/data-tools.spec.ts` | `limit: 100`、`limit: 2.5` | 超限有告警或 `invalid_tool_input`；小数按 `resolveResultLimit` 取整，行为与 FTS 入口一致 |
| R-63 | `tests/analyze-patent-figure.spec.ts` | 5000 字 `claim_context` | 有截断标记或工具先报明确上限；参数说明与实际上限一致 |
| R-64 | `tests/knowledge-tools.spec.ts` | `node_type: 'Case_typo'` | 抛 `invalid_tool_input` 并列出可用类型，或 schema 用 enum 直接拒绝 |
| R-65 | `tests/data-tools.spec.ts` | `patents: []` | 抛 `invalid_tool_input`（至少 1 条），不返回成功空批 |
| R-66 | `tests/data-tools.spec.ts` | `timeout: 0`、`maxConcurrency: 0` / `2.5` | 抛 `invalid_tool_input`；若要夹取，写告警，与 `patent_pdf_download` 的 `requireIntRange` 一致 |

## 32. D11 精简候选

| ID | 位置 | 候选动作 | 优先级 | 预期收益 | 等价性验证 |
|---|---|---|---|---|---|
| C-14 | `patent-search.ts:299`、`patent-wiki-search.ts:148`、`search-patent-figure.ts:290` | 三个入口改用 `resolveResultLimit`；`patent_search` 的超限截断补一条 warnings | P3 | 工具层与 FTS 入口共用一套上限语义，R-62 不再漂移 | 现有查询用例零改动通过；新增 100 / 2.5 / 0 / 负数用例 |
| C-15 | `patent-search.ts:305-328`、`patent-metadata.ts:361-382` | 把抛错路径收进 `internal/upstream-channel.ts` 的统一映射：`asUpstreamFailure(error, channel, attempts)`，再由两工具决定是否重试 | P3 | 抛错也有稳定 code 与通道名，R-59 的两份重复逻辑只剩一处 | 现有“rethrow original”用例改为断言包装后的 message/code；新增两次重试用例 |
| C-16 | `evaluate-evidence.ts:174-175`、`patent-analysis-report.ts:180-186`、`patent-eval.ts:329`、`patent-workflow-run.ts:359-361` | 先为固定结构 DTO 写具体输出 schema，替换 `type:'json'`；动态键映射（`scores` 的分项、`plan`/`run` 快照）保留并注明原因 | P2 | 输出契约真正校验字段；删除约 39 处 `as unknown as`（R-05 的 51 处中 11 render + 28 JsonValue） | schema 断言用例；`typecheck`；模型可见渲染零差异 |
| C-17 | `index.ts` 全文件 | 按包外引用把 352 个无引用导出分成“公共 API 保留 / 降为包内 / 删除”三类，另立 PR 处理，不与工具契约混做 | P2 | 公共面从 373 收敛到有当前消费者的集合；R-09 有可执行清单 | `change-scope` + 全仓引用搜索 + `typecheck`；外部集成方清单需人工确认 |

## 33. D11 范围校正与不做项

- **R-05（类型逃逸）只分类不改代码**：51 处 `as unknown as` 中 11 处是 render 取值、28 处是输出值转 `JsonValue`、5 处是入参断言、7 处是 render 内部的域类型转换。前两类共 39 处与 R-61 同根，按 C-16 先补 schema 再删断言；入参断言可直接按 `defineTool` 已校验的类型收窄。D11 的方案是后续 PR 的输入，不在本次一并改 51 处。
- **R-09（导出面）只审计不删除**：`index.ts` 373 个导出名中，352 个在 `packages/`、`apps/`、`scripts/`、`snapshots/`（排除本包与 `lib/`）没有引用，9 个只有一个消费者，12 个有多个消费者。该计数不覆盖文档与下游仓库，二进制/外部集成方仍可能依赖；删除需要 owner 决策与 `change-scope`，D11 只给候选清单（C-17）。
- **不在 D11 改 `total` 语义（R-60）**：`patent_search` 的 `total` 是上游命中总数，其余检索工具是截断后的返回条数。改名或新增 `matchedTotal` 会改模型可见输出与使用方断言，需产品决策；D11 先固定现状并登记。
- **不把 R-58/R-59 的错误码改动夹带进文档 PR**：两处都会改变模型可见错误与既有测试（`data-tools.spec.ts` 已把裸抛写成期望），应与对应回归测试同一 PR。
- **不给 `patent-tools` 的库调用补运行期校验**：`resolveResultLimit`、`computeFees` 等同进程类型化 API 按仓库规则不重复校验；只在工具边界处理模型输入。
- **不覆盖 `figure/` 的几何与渲染实现**：`render-check-*`、`section-diagram`、`leader-line`、FreeCAD/Graphviz/Inkscape 的数值确定性与退化输入留 D12。
- **不启动真实 knowledge.db、网络或浏览器通道**：D11 的复现全部用注入的 fake 依赖，覆盖契约分支；真实 provider 的端到端覆盖仍由 CI 与 D7 的通道测试负责。
- **不把 20 个错误码裁到已用集合**：`PatentToolErrorCode` 是 Sati 协议面，可能被下游按码路由；R-58/R-59 暴露的是映射缺口，不是码表冗余。

## 34. D12 渲染族复核范围与方法

D12 范围：`packages/patent/patent-tools/src/figure` 的渲染族（几何、数值确定性、退化输入、CJK 字体）。七个 >700 行文件逐一过读（导出面、校验、几何/落位与发射分段，关键函数逐行）：`freecad-structure-script.ts` 1,233、`render-check-findings.ts` 988、`section-diagram.ts` 918、`leader-line.ts` 908、`dot-builder.ts` 839、`render-check-scan.ts` 792、`circuit-diagram.ts` 749；合计 6,427 行。支撑模块按调用关系抽读：`glyph-box.ts`（CJK/字宽模型）、`mm-primitives.ts`（数值格式）、`vector-figure.ts`（片段上限）、`plot-diagram.ts` 与 `sequence-diagram.ts`（另两条直绘通路）、字体解析（`wiring.ts` 的 `resolveDotFont`）与 Graphviz 产物收尾（`graphviz-renderer.ts`）；`svg-viewport.ts`、`submission-page.ts`、`section-source.ts`、`freecad-section-geometry.ts`、`freecad-hatch-geometry.ts` 只按导出、常量与依赖核对，未逐行复核。

方法：先按 §5.1「图形渲染」与 D12 行的四类检查项（退化输入、数值确定性、CJK 字体、几何）读实现与既有测试；每个可疑路径用临时 spec 直接调用纯函数或 `dot` CLI 复现，记录实际输出后删除；可长期保留的输出另建回归快照（§37）。复现覆盖 12 组输入：零面积/共线轮廓、空集合、常量序列、超长标签、CJK 混排、XML 实体文字、巨大轮廓、微小 `stroke-dasharray`、20 万点多边形、重复/冲突节点 id、自连电路、缺失字体。未启动 FreeCAD、Inkscape 或真实模型渲染；真实渲染链路由 CI 的 `figure-*-real-render.spec.ts` 覆盖。

结论：渲染族的正常路径有较完整的几何校验与既有测试，退化输入的主要问题集中在「按输入规模展开、缺少上限」与「同一度量存在多份实现」。本次复核确认 10 项风险（P2 7 项、P3 3 项），全部登记为后续修复/拆分 PR 的输入；D12 本身只新增回归快照与拆分方案，不改产品代码（见 §39）。

## 35. D12 渲染族问题清单

以下 10 项均以最小输入或 CLI 实测确认，详情见风险登记册 R-67–R-76。级别按第 3 节标准判定。

| 风险 | 类别 | 证据 | 最小复现 / 实际结果 | 级别 |
|---|---|---|---|---|
| R-67 | 正确性 / id | `dot-builder.ts:253-257,485-486,593-594`；对照 `:668,723` | 流程图 id `a.b` 与 `a_b` → 两个 `"a_b"` 节点、`"a_b" -> "a_b"`；框图重复 id `a` → 两行同名节点，标号同为 100 | P2 |
| R-68 | 检查正确性 / 文字度量 | `render-check-scan.ts:716,616-628`；对照 `svg-annotate.ts:100-102` | `<text>A&amp;B</text>` 量成 `A&amp;B`（5 字符）：框宽 15.75 mm，实际 7.35 mm；x=16 的线未穿真实文字，却报 `text-crossed-by-line` | P2 |
| R-69 | 正确性 / 标号匹配 | `leader-line.ts:824-825,887-891` | 节点「泵体」「泵」与参考 `[{泵,1},{泵体,2}]` → 两个节点都标 1，参考「泵体」报未命中 | P2 |
| R-70 | CJK 字体降级 | `wiring.ts:220-237`、`dot-builder.ts:444`、`graphviz-renderer.ts:237-248` | `dot` 用不存在的 `fontname` 渲染中文：退出码 0、无 stderr，SVG 仍写 `font-family="…"`；工具不报 | P2 |
| R-71 | 退化输入 / 上限 | `render-check-scan.ts:281-291`、`render-check-findings.ts:557-577` | 160 mm 线 + `stroke-dasharray="0.001 0.001"` → 8 万段、11 ms；模式再小 10 倍即 80 万段，无上限 | P2 |
| R-72 | 退化输入 / 上限 | `section-diagram.ts:469-504`、`vector-figure.ts:83-85` | 100,000 mm 见方轮廓 → 3,608,928 字节片段、30 ms；跨度再放大 10 倍即 36 MB，且 `too_large` 在生成之后才检查 | P2 |
| R-73 | 退化输入 / 崩溃 | `render-check-findings.ts:211-215,725,789` | 20 万点、约 0.8 MB 的合法多边形 → `RangeError: Maximum call stack size exceeded` | P2 |
| R-74 | 参数校验 | `dot-builder.ts:300-315,329-347` | `pageSize: 'a4', marginCm: 30` → `size="-15.35,-11.93"` 负值 | P3 |
| R-75 | 输入校验 / 几何 | `circuit-diagram.ts:641-660,700-710,741` | 元件自连 → `polyline 10.5,13 7,13 10.5,13` 与引脚上的实心结点 | P3 |
| R-76 | CJK / 数值一致性 | `glyph-box.ts:16-25,38-51,78-88`、`leader-line.ts:138-147,268-271`、`plot-diagram.ts:126-130,200-203`、`freecad-structure-script.ts:344-347,361-363`、`freecad-section-script.ts:191`、`mm-primitives.ts:2` | 同一字符在三处分别是 0.6/0.75/1、0.55/1、0.62；Hangul 与扩展 B 只在 `glyph-box` 按全角；Python `%.3f` 与 JS `Math.round` 在 4 位小数的半值上 941/20,000 次不同 | P3 |

## 36. D12 退化输入与数值确定性矩阵

| 输入类别 | 覆盖对象 | 当前行为（实测/快照） | 结论 |
|---|---|---|---|
| 零面积轮廓 | `buildSectionDiagram` | 不产生剖面线；重心退化为顶点平均位置，标号引线仍画出 | 已固定（§37 快照） |
| 共线顶点 | `buildSectionDiagram` | 切线交点为零长线段时跳过；画布仍由顶点与文字框撑开 | 已固定（既有用例 + 快照） |
| 空可选集合 | 剖视/电路/曲线/时序构建器 | 缺省 `outline`/`labels`/`connections`/图例等按空集合处理；必需集合为空时抛 `empty_input` | 已固定（快照/既有用例） |
| 常量序列（零跨度） | `buildPlotDiagram` | 按 `DEGENERATE_HALF_SPAN = 1` 展开范围，刻度与折线仍可画 | 已固定（快照） |
| 超长标签 | `buildCircuitDiagram` | 全部候选落位越界时退回首选位置，由渲染复核报出 | 既有用例；不新增 |
| CJK 混排 | 全部文字量测 | 复核侧全角 1.0、大写 0.75、其余 0.6；放置侧 0.55/1.0 且 CJK 正则更窄；Hangul/扩展 B 只在 `glyph-box` 按全角（R-76） | 快照锁定当前口径 |
| XML 实体文字 | `scanSvg` / 渲染复核 | 实体不解码，框按原文变宽，可产生假穿字（R-68） | 待修 |
| 微小 `stroke-dasharray` | `scanSvg` / `dashSegments` | 按 `长度 / 模式` 展开，无段数上限（R-71） | 待修 |
| 巨大坐标轮廓 | `buildSectionDiagram` | 剖面线条数与跨度成正比，先建片段后查 2 MB 上限（R-72） | 待修 |
| 超大顶点集 | `measureInkBounds` / `outlineOverlaps` | `Math.min(...xs)` 在 20 万点时抛栈溢出（R-73） | 待修 |
| 重复/清洗碰撞 id | 四个 DOT 构建器 | 流程图/框图静默合并；层级图/状态图已拒绝（R-67） | 待修 |
| 自连与同格元件 | `buildCircuitDiagram` | 自连画出往返零面积折线与结点；同格元件完全重叠（R-75） | 待修 |
| 缺字体 | Graphviz 渲染链 | CLI 退出 0、无告警；SVG 保留缺失字族（R-70） | 待修 |
| 重复构建 | 全部纯函数构建器 | 相同输入逐字节一致（无随机、时钟、`toLocale*`） | 已固定（§37 用例外） |

数值确定性补充：`formatMm` 以 `Math.round(value * 1000) / 1000` 输出三位小数，JS 侧重复构建稳定；Python 侧 `freecad-structure-script.ts` 用 `"%.3f"`、`freecad-section-script.ts` 用 `round(..., 3)`，与 JS 的半值舍入在约 4.7% 的 4 位小数输入上不同（R-76）。这不是同一次构建内的随机性，而是跨引擎复现同一图面时的口径差异。

## 37. D12 渲染回归快照清单

新增 `packages/patent/patent-tools/tests/figure-render-regression.spec.ts` 与同名 `__snapshots__`。全部输入为固定字面量、不依赖本机字体与外部程序；拆分文件时必须零改动通过（除 import 路径外不得改测试）。

| 用例 | 锁定内容 | 类型 |
|---|---|---|
| 剖视图（外轮廓 + 双向剖面线 + 中心线 + 断裂线 + 剖切符号 + 引线标号） | 完整 `body`、画布尺寸、`labels`（含组号、线宽、坐标） | 文件快照 |
| 剖视图退化（零面积轮廓） | 无剖面线、退化重心、引线与文字框 | 文件快照 |
| 电路图（中文元件名/连线名 + T 形结点） | 符号、走线、文字落位与结点顺序 | 文件快照 |
| 曲线图（双序列、网格、中文轴标目） | 轴、刻度、网格、标记与图例坐标 | 文件快照 |
| 曲线图退化（常量序列） | 零跨度范围的默认展开 | 文件快照 |
| 时序图（同步/返回/异步 + 激活条） | 生命线、箭头、虚线样式与消息文字 | 文件快照 |
| 引线标注（两中文节点 + 边） | 组平移换算、引线端点、标号文本、画布扩边 | 文件快照 |
| 流程图 DOT（中文步骤 + 决策边 + A4 页边距） | 完整 DOT 文本与页面属性 | 文件快照 |
| 框图 DOT（语义填充 + 跨图续号） | 完整 DOT 文本与标号 | 文件快照 |
| FreeCAD 结构线稿脚本 | 全文 SHA-256 + 双重 JSON 参数 + 自动锚点 `null` 传递 | 内联摘要 |
| 渲染复核：合规 / 缺陷 / 空 SVG | 报告的字段、范围、发现类别、文案与顺序 | 文件快照 |
| CJK 文字度量 | `textWidthMm('壳体 R1', 3.5)` 与 `glyphBox` 的精确值 | 内联断言 |
| 重复构建确定性 | 剖视/电路/曲线/时序/DOT/脚本连续两次输出逐字节相等 | 断言 |

更新规则：只有渲染行为被有意改变时才用 `vitest -u` 重录，并在 PR 描述说明差异；拆分文件一律不重录。`freecad` 摘要变化时，同时人工核对 `manifest` 字段与脚本版本注释。

## 38. D12 拆分方案（几何 / 渲染 / 检查分层）

目标：把七个 >700 行文件按 P2 第 3 项「几何计算 / 渲染 / 检查」分层，单文件收敛到 600 行以内；公共导出面与既有测试保持不变，拆分 PR 只做移动。

| 源文件（现状行） | 现状职责（行段） | 目标模块（预计行） |
|---|---|---|
| `section-diagram.ts`（918） | 类型/校验 28-427；剖面线 429-504；标号、断裂线、剖切符号 506-683；SVG 发射 685-751；组装 753-918 | `section-hatch.ts`（约 150：剖面线参数/裁剪）；`section-annotations.ts`（约 230：重心、标号引线、断裂线、剖切符号、点划线）；`section-diagram.ts`（约 520：类型、校验、组装） |
| `render-check-findings.ts`（988） | 类型/常量 25-178；线段与区间数学 179-358；各项判据 358-815；公开入口 817-988 | `render-check-geometry.ts`（约 300：包围盒、多边形内点、遮挡切分、虚线展开、区间合并）；`render-check-rules.ts`（约 430：穿字/净距/点划线/剖面线/叠压/字高/越界/版面）；`render-check-findings.ts`（约 260：类型、`checkFigureRendering`、`measureInkBounds`、`blockingFindings`） |
| `leader-line.ts`（908） | 类型/常量 37-218；SVG 与文本解析 220-480；候选与落位 485-700；画布扩边与标注入口 700-908 | `leader-line-parse.ts`（约 280：标签/属性/组平移/画布/障碍解析）；`leader-line-place.ts`（约 280：候选、碰撞、画布扩边）；`leader-line.ts`（约 350：类型、入口、片段发射） |
| `dot-builder.ts`（839） | 类型/常量 23-195；标号/清洗 196-257；页面 259-356；转义、头、四个构建器 358-838 | `dot-numerals.ts`（约 110）；`dot-page.ts`（约 120）；`dot-diagrams.ts`（约 430：四个构建器与模板）；`dot-builder.ts`（约 180：类型、头/转义、再导出） |
| `render-check-scan.ts`（792） | 类型 40-148；标签/属性/变换 150-390；路径与图元几何 390-660；遍历与汇总 660-792 | `svg-scan-attrs.ts`（约 270：标签、行内样式、长度/字号、变换）；`svg-scan-geometry.ts`（约 270：path/points/圆椭圆、折线化）；`render-check-scan.ts`（约 250：帧遍历、`scanSvg`、`textQuad`） |
| `circuit-diagram.ts`（749） | 类型/常量 25-161；发射与符号画法 163-405；走线与落位 405-660；校验与组装 660-749 | `circuit-symbols.ts`（约 330：符号发射、十种画法、端口、外接框）；`circuit-routing.ts`（约 230：正交走线、连线说明落位、结点）；`circuit-diagram.ts`（约 190：类型、校验、组装） |
| `freecad-structure-script.ts`（1,233） | 类型/常量 35-226；构建器 228-292；Python 模板 294-1,233 | `freecad-structure-python-geometry.ts`（约 500：模板前半：参数、投影、几何事实、锚点）；`freecad-structure-python-render.ts`（约 450：模板后半：视图、SVG、manifest、main）；`freecad-structure-script.ts`（约 300：payload、文件名、模板拼接） |

拆分原则与顺序：

1. **先检查、后渲染**：第一批拆 `render-check-scan` + `render-check-findings`（判据最多、最独立）；第二批 `section-diagram` + `circuit-diagram`；第三批 `leader-line`；第四批 `dot-builder`；最后 `freecad-structure-script`。
2. **依赖单向**：`geometry`/`parse` 不得反向 import 入口模块；入口模块保留同名导出（`index.ts` 与工具层不改），必要时从新模块再导出。
3. **纯移动**：每个 PR 只移动函数与常量并改 import；`git diff --color-moved=dimmed-zebra` 不得显示逻辑改动；预计 diff 超过 400 行的单日 PR 规则，但按 §3.2「纯移动单独 PR」处理，不与修复混做。
4. **等价性证据**：§37 快照零改动通过；FreeCAD 脚本 SHA-256 不变；`pnpm exec vitest run packages/patent/patent-tools/tests/figure-*.spec.ts` 全绿；`pnpm run typecheck`、`pnpm run lint`。
5. **修复不与拆分混做**：R-67–R-75 的修复各自成 PR 并先加失败用例（§35 的复现即用例设计）；R-76 的文字度量收敛在拆分完成后单独评估（改比例会改模型可见图面，需要快照差异评审），不要顺手合并。

拆分收益（按当前行数估算）：最大文件从 1,233 行降到约 520 行；七个文件合计仍约 6,427 行，不追求删行；收益是职责边界、可测试性与后续修复的落点（R-68/R-71/R-73 落在 check 层，R-67/R-74 落在 DOT 层，R-72 落在 section 层，R-70/R-76 落在文字度量与字体解析）。

## 39. D12 范围校正与不做项

- **不改产品代码**：D12 的交付是「渲染回归快照 + 拆分方案」；R-67–R-76 只登记，修复与拆分各自 PR。这样 review 结论与行为改动不混在一个 diff 里，也符合 §3.2「simplification 与 behavior fix 不得混在一个 PR」。
- **不做真实渲染的端到端复核**：FreeCAD/Graphviz/Inkscape 的真实输出依赖本机二进制与字体；D12 只用纯函数、固定 SVG 与 `dot` 的缺字体实验取证，真实链路仍由 CI 的 `figure-*-real-render.spec.ts` 与 `figure-graphviz-ci-signal.spec.ts` 负责。
- **不在 D12 统一 Python 与 JS 的数值格式（R-76）**：统一会改 FreeCAD 产物的坐标文本，进而改模型可见附图；需要先决定「谁迁就谁」并重录快照，留给拆分后的独立 PR。
- **不在 D12 决定缺字体时的产品行为（R-70）**：可选方案是预检并报错、输出字族回退列表、或默认开启文字转路径；三者对宿主环境与交付物的承诺不同，需要 owner 决策。D12 只固定「当前静默降级」的事实。
- **不删既有测试**：渲染族已有 46 个 `figure-*.spec.ts`（连同 5 个复核/分析入口 spec 共约 1.7 万行）；D12 只新增快照，不合并或删除既有细粒度用例。细粒度用例定位缺陷，快照锁定整体输出，两者用途不同。
- **不把快照当覆盖率**：快照验证「输出未变」，不验证「输出正确」；R-67–R-75 的修复仍需各自的定向失败用例（§35 的复现输入即起点）。
- **不扩大拆分到 `figure/` 之外**：`submission-page`、`section-source`、`freecad-renderer` 等 ≤512 行模块本轮只在被上述七个文件依赖时抽读，不纳入拆分范围。

## 40. D14 复核范围与方法

D14 范围：`packages/patent/patent-workflow` 的执行器、manifest 目录、运行持久化与 plantask 状态机，对应计划第 165 行的「`manifests.ts` 状态机、恢复、幂等、HITL 审批」，交付物为恢复/重复调用测试。逐行过读 `workflow.ts`（520）、`workflow/executor.ts`（187）、`workflow-store.ts`（282）、`plantask.ts`（227）、`index.ts`（305）；`workflow/manifests.ts`（953）作为数据目录按阶段顺序、门位置与参数核对，不逐条重读阶段文案。跨包只读消费面：`patent-core/src/workflow/manifest.ts`（`rewindTo`/`routes` 不得跨门的校验）、`patent-core/src/atoms/handlers/builtin/gate.ts`（放行标记只进局部执行态）、`patent-tools/src/tool/patent-workflow-run.ts`（manifest 路径的 `approveStageIds`、live 门与持久化装配）与 `patent-tools/src/tool/patent-plan-task.ts`（无状态 transition/sync/replan）。

方法：先把状态推进画成「线性序号 + 回退 + 中断 + 并行窗口」四条路径，逐条找可复现输入；再用临时 spec 直接调用 `runWorkflow`、`runPlantask` 与 store 复现（保留为 §42 的用例），包括暂停后带放行/不带放行重跑、重新打开 store、同 runId 连续两次、相邻双门、放行名单拼错、空计划、重复决策与轮次封顶。状态机封闭性检查两处：manifest 校验拒绝跨门的回退；plantask 转移表以用例固定「六态齐全、目标在词表内、finished 无出边、全部可达」。

结论：正常路径的状态推进与门禁顺序完整，问题集中在「恢复语义」和「人工决策的来源与时机」。本次确认 6 项风险（P1 1、P2 4、P3 1）：R-78/R-79/R-81 本轮修复并带用例；R-77/R-80/R-82 只登记，修复需要接口或部署策略决策。

## 41. D14 问题清单

| 风险 | 类别 | 证据 | 最小复现 / 实际结果 | 级别 | 状态 |
|---|---|---|---|---|---|
| R-77 | 恢复语义 | `workflow.ts:97,481`；`workflow-store.ts:243,274` | 门暂停后带放行重跑：门前阶段全部再执行，暂停记录不被复用 | P2 | 已确认 |
| R-78 | HITL 时机 | `workflow.ts:269-277`；`tests/workflow.spec.ts` 的 parallel-interrupt | `[gate_a, gate_b, deliver]` 拒绝 a → 修复前 b 也被追问（`['a','b']`）；修复后只问 a | P2 | 已关闭 |
| R-79 | 放行诊断 | `workflow/executor.ts:88`；修复前无校验 | `approvalGrants: ['gtae']` → 修复前再次暂停且无诊断；修复后运行前 `WorkflowError` | P3 | 已关闭 |
| R-80 | 持久化 / 恢复 | `index.ts:148,150,264-272`；`types.ts` 的 plantask 事件注释 | 重启后 `approve` 抛 no pending；批准后同 case 再发起视为新计划；轮次跨周期累计 | P2 | 已确认 |
| R-81 | 挂起锁 | `index.ts:204`；`plantask.ts` 的 executing 守卫 | `runPlantask(agent,'case',[])` → 先问审批，批准后抛语义错误并可能留下 pending | P2 | 已关闭 |
| R-82 | HITL 信任边界 | `patent-tools/src/config.ts:116,179`；`patent-workflow-run.ts:439-448,607-608`；`patent-workflow-run.spec.ts:337-348` | 默认配置 + `approveStageIds:['review_gate']` → 直接完成，不产生 `approval/request` | P1 | 已确认 |

## 42. D14 恢复/重复调用测试矩阵

新增 `packages/patent/patent-workflow/tests/workflow-recovery.spec.ts`，并在 `service.spec.ts`、`plantask.spec.ts`、`manifest-atoms.spec.ts` 补集成、状态机与 manifest 结构用例。全部输入为固定字面量，临时目录每例自建并清理。

| 用例 | 锁定内容 | 对应风险 |
|---|---|---|
| 暂停记录落盘后带放行重跑 | 暂停结果含 `interrupted`、`completed=false`；带 `approvalGrants` 重跑完成并覆盖同一 runId；门前 `draft` 执行两次 | R-77 |
| 不带放行重跑两次 | 两次暂停结果与磁盘 JSON 逐字相同；同 runId 只有一条记录 | R-77 |
| 新 store 实例重读暂停记录 | 暂停的 stage 列表与 `interrupted` 可跨实例恢复 | R-77 |
| `requireAllSteps:false` 下的暂停 | 没有降级阶段也报告 `completed=false` | R-77 |
| 落盘失败后恢复 | 暂停结果带 `persistWarning`，后续带放行运行仍可写成完成记录 | R-77 |
| 完成运行重复两次 | 两次结果与磁盘 JSON 逐字相同，阶段不追加 | 重复调用 |
| 相邻双门逐个取决策 | 拒绝第一个门后第二个门不再被询问 | R-78 |
| 放行只作用于点名的门 | 批准 gate_a 后仍停在 gate_b，交付阶段不执行 | R-78 |
| 放行名单未知阶段 / 非门阶段 | 执行前 `WorkflowError`，执行器未被调用 | R-79 |
| 空计划 | 不取审批、不落 pending、不写 `patent/plantask`；同 caseId 随后可发起 | R-81 |
| 暂停与恢复的会话事件 | 同一 runId 两次运行各追加一条 `patent/workflow-run`（先 interrupted、后 completed） | R-77 / 重复调用 |
| 重复决策 | `approve` 后再次 `approve`/`reject` 抛 no pending | R-80 |
| 批准后同 caseId 重新发起 | 只锁 `awaiting_approval`；执行态无服务端状态可查 | R-80 |
| plantask 转移表封闭 | 六态齐全、目标在词表内、finished 无出边、全部从 planning 可达 | 状态机 |
| 内置 manifest 门位置 | 每个 manifest 恰好一个门、位于最后、不声明 consumes/retry | manifests 状态机 |

门禁命令：`pnpm exec vitest run packages/patent/patent-workflow packages/patent/patent-tools/tests/patent-workflow-run.spec.ts packages/patent/patent-tools/tests/patent-flexible-plan.spec.ts packages/patent/patent-tools/tests/approval-gate.spec.ts`；类型与静态检查按 §5.1。

## 43. D14 范围校正与不做项

- **不做「从暂停记录真续接」**：`WorkflowRunStore.loadRun` 目前没有生产消费者；真正续接要先决定哪些阶段可跳过、恢复后的证据账本与回退留痕如何合并、以及重跑的幂等承诺边界。D14 只把「恢复 = 带放行重跑」写成测试与 README 语义（R-77）。
- **不落盘 plantask 状态**：跨重启恢复需要新增持久化格式与「谁驱动 `awaiting_feedback`→`finished`」的产品决定；D14 只固定内存语义并登记（R-80）。
- **不改 `approveStageGates` 默认值**：把默认改为 `true` 会要求部署挂载审批服务，并改变既有工具契约；是否收紧属于 owner 决策（R-82）。
- **不重构执行器**：`runWorkflow` 的单文件 520 行与「串行/并行/回退/中断」四路径耦合是已知结构债，但拆分需要单独 PR 与等价性测试，不与本轮行为修复混做。
- **不动 `manifests.ts` 的阶段文案与顺序**：本轮只固定门的位置与结构；文案属模型可见输出，改动需单独评审快照。
- **不覆盖 graph 路径的检查点恢复**：`resumeCheckpointId` 的检查点语义在 patent-core 的 graph 适配器，D14 范围是 manifest 路径与 plantask 状态机；graph 恢复另列。

## 44. D16 复核范围与方法

D16 范围：`packages/patent/writing-patterns`（7 个源文件）、`packages/patent/methodology`（5 个源文件 + 3 个 JSON 资产）、`packages/patent/tool-literature`（18 个源文件），对应计划第 172 行的「语料选择、TRIZ 表、文献连接器」，交付物为语料/矩阵边界测试。

方法：逐行过读三包源码与既有测试（writing-patterns 7 个 spec、methodology 6 个 spec、tool-literature 12 个 spec），先确认现有断言已覆盖的正常路径与拒绝路径，再用一次性探针复现疑点：(1) `fromInverted({ a: [1e7] })` 135 ms、`{ a: [1e8] }` 1,246 ms，耗时随最大位置线性增长；(2) 给 `validateTrizAssets` 注入 `signals: [123, null, {}]` 直接通过，而 triz 输出 schema 在首次对角查询时才报 `must match exactly one oneOf branch`；(3) `paper_search({ db: 'arxiv', query: '   ' })` 不报错，实际请求 `search_query=all%3A`。矩阵方向用已知经典单元交叉核对：`lookupMatrixCell(14, 1) = [1, 8, 40, 15]`，与转置 `(1, 14) = [28, 27, 18, 40]` 不同。

结论：三包的语料加载、词法选择与资产结构校验整体完整，问题集中在「响应体边界」——外部源的超大数值、非文本信号、空白查询都能穿过现有校验。本次确认 4 项风险（P2 4）：R-83/R-84/R-85 本轮修复并带边界用例；R-86（PDF 下载无字节上限）只登记，修复需要流式读取与测试桩迁移。

## 45. D16 问题清单

| 风险 | 类别 | 证据 | 最小复现 / 实际结果 | 级别 | 状态 |
|---|---|---|---|---|---|
| R-83 | 响应边界 / 资源上限 | `tool-literature/src/runtime/shared/text.ts:117`；`openalex.ts:69` | `fromInverted({ a: [2 ** 32 - 2] })`：修复前按位置建密集数组，`filter` 需走访 4.29e9 个槽位；修复前 1e8 位置实测 1,246 ms | P2 | 已关闭 |
| R-84 | 资产校验 | `methodology/src/data.ts:180-188`；`triz.ts:75,97` | `signals: [123]` 通过 `validateTrizAssets`，插件正常加载；首次对角查询被输出 schema 拒绝 | P2 | 已关闭 |
| R-85 | 工具输入边界 | `tool-literature/src/tool/paper-search.ts:118-121` | `query: '   '` 修复前返回成功并请求 `all:`，模型据此读到「无结果」 | P2 | 已关闭 |
| R-86 | 下载字节上限 | `tool-literature/src/tool/paper-download.ts:111-113` | 直接链与兜底链均先 `arrayBuffer()` 再校验 PDF 魔数；无 `Content-Length` 预检、无累计字节上限 | P2 | 已确认 |

## 46. D16 语料/矩阵边界测试矩阵

新增或扩展的用例全部使用固定字面量与临时目录，不依赖网络、时钟或宿主字体。

| 包 | 用例 | 锁定内容 | 对应风险 |
|---|---|---|---|
| writing-patterns | 同一 `patterns` 列表内重复 id | 加载期拒绝，报文件与首个占用者 | 语料唯一性 |
| writing-patterns | `quality: 1` | 上边界保留为 1，不被默认值覆盖 | 质量权重边界 |
| writing-patterns | `limit` 为 0 / -1 / 1.5 | 0 与 -1 由执行层报「正整数」；1.5 在模型参数 schema 层拒绝 | 结果上限边界 |
| writing-patterns | `limit` 大于类目规模 | 返回全部 11 条 `claim_drafting`，不补空位 | 结果上限边界 |
| writing-patterns | `sectionCategories: []` | 段落文本恰为指引散文，无 `<pattern_index>` | 语料注入边界 |
| methodology | 矩阵方向 | `lookupMatrixCell(14, 1)` 取 `matrix[0][13]`，与转置结果不同 | TRIZ 表方向 |
| methodology | 参数 40 / 1.5 / NaN | 公共数据接口返回空数组，不抛错、不环绕 | TRIZ 表范围 |
| methodology | `ENGINEERING_PARAMS` | 编号 1–39 顺序且标签非空，`paramLabel` 与表一致 | 参数表完整性 |
| methodology | 分离原则 signals 元素 | 数字、null、对象、空串逐一报出序号；插件加载即拒绝 | R-84 |
| tool-literature | `fromInverted` 远位置 | `2 ** 32 - 2` 立即返回单词，工作量只随条目数增长 | R-83 |
| tool-literature | `fromInverted` 重复位置 / 非数组位置 | 重复位置保留后写值；非数组位置跳过而不抛错 | R-83 |
| tool-literature | 空白查询三种形式 | 空串、空格、换行制表符均拒绝，源调用次数为 0 | R-85 |
| tool-literature | 查询首尾空白 | 检索与结果回显都使用裁剪后的查询 | R-85 |
| tool-literature | Semantic Scholar `limit: 999` | 请求参数钳制为 `limit=50` | 连接器上限 |

门禁命令：`pnpm exec vitest run packages/patent/writing-patterns packages/patent/methodology packages/patent/tool-literature`；类型与静态检查按 §5.1。

## 47. D16 范围校正与不做项

- **不改语料内容**：writing-patterns 的 24 个模式资产、法条引用与检索词本轮零改动；`source-ref.spec.ts` 仍作为引用解析的负载校验。
- **不改 TRIZ 数据**：`triz-matrix.json`、`triz-principles.json`、`triz-separations.json` 保持原样；只收紧对 signals 文本的加载期校验。已知的 `(19, 9)` 重复单元仍按「保留源值、读取去重」处理。
- **不改连接器契约**：`Connector.search` 的签名、`limit` 由连接器自行钳制的分工不变；本轮只在工具层补输入校验，不替连接器重排结果。
- **不修 R-86（下载字节上限）**：真正的上限需要在读取响应流时累计字节，并同步迁移 `paper-download.spec.ts` 的 `arrayBuffer()` 测试桩；上限值（协议不变量还是部署配置）也需要 owner 决策，留给独立 PR。
- **不改词法排序**：`scorePattern` / `scoreMatch` 的权重、中文 bigram 与 id 兜底排序保持不变；这类改动会改模型可见选择结果，需要快照差异评审。
- **不新增快照**：三包的有效输出本次未变（只改无效输入的失败路径），`snapshots/` 与系统提示录制无需刷新。
