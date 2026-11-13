# 专利 / 法律 / 文档 / 视频领域：30 天审查、精简与优化计划

> 基线：2026-11-03，分支 `trae/agent-gGNODt`。
> 统计口径：`src/` 下 `.ts` / `.tsx` 行数；`tests/` 单独统计。所有数字在 D1 重新采集后以当天快照为准。

## 1. 目标与成功判据

目标是完成一次**风险优先**的审阅，并把结论落成可合并的改动：先修正确性，再删重复，最后调结构。审阅不是逐行通读全仓，而是「全仓轻量扫描 + 四领域深度审查」。

### 1.1 成功判据

| 维度 | 基线（2026-11-03） | 30 天目标 | 验证方式 |
|---|---|---|---|
| 范围内源码规模 | 130,713 行 | 下降 8%–12%，且无行为变化 | 行数快照 + 快照/特征测试零差异 |
| 超长文件 | 91 个文件 > 400 行 | ≤ 60 个 | `scripts/report-structure.ts` + `find/wc` |
| 最大单文件 | 1,304 行（`patent-deadline/src/statutes.ts`） | ≤ 800 行 | 同上 |
| 未处置标记 | 37 处 TODO/FIXME/XXX/`@deprecated` | ≤ 20，其余转 Issue 或 Agent Note | `grep` 清单 |
| 重复代码 | 以 `pnpm run duplication` 当前基线为准 | 基线下降，且不新增 clone | 复制检测门禁 |
| 覆盖率 | 以当前 `test:coverage` 为准 | 不低于基线，逐文件门槛不破 | 定向覆盖率 + CI |
| P0 缺陷 | 待 D1 登记 | 0 个未关闭 | 风险登记册 |
| 公共契约 | — | 无未声明破坏性变更；有则补升级指南 | `doc-sync` + 升级指南 |

### 1.2 不在目标内

- 不追求全仓 100% 逐行审阅；`core/`、`client/`（视频工作室除外）、`vendor/`、`native/` 只在共享 seam 受影响时改动。
- 不借机重写架构；跨包合并必须先有行为等价性测试和明确共享契约。
- 不改动已发布 Session 格式；确需改动时按 `docs/cookbook/reviewing-persistence-type-changes.md` 确认并走版本流程。

## 2. 范围与现状基线

### 2.1 包规模（源码行数）

| 领域 | 包数 | 源码行数 | 测试行数（约） | 占比 |
|---|---:|---:|---:|---:|
| patent | 16 | 109,364 | 103,577 | 83.6% |
| legal | 3 | 5,446 | 4,964 | 4.2% |
| document | 5 | 7,208 | 6,515 | 5.5% |
| video | 3 | 8,695 | 7,078 | 6.7% |
| 合计 | 27 | 130,713 | 122,134 | 100% |

> legal 测试文件数明显偏少（5/9/5），是本轮需要重点补证据的地方，而不是先做精简的地方。

### 2.2 单包明细

| 包 | 源码文件 | 源码行数 | 测试文件 |
|---|---:|---:|---:|
| `patent/patent-tools` | 141 | 37,012 | 114 |
| `patent/patent-core` | 175 | 33,793 | 100 |
| `patent/patent-teams` | 20 | 5,552 | 16 |
| `patent/patent-rule` | 22 | 5,382 | 30 |
| `patent/patent-workflow` | 16 | 4,612 | 26 |
| `patent/patent-knowledge` | 28 | 3,806 | 21 |
| `patent/patent-document` | 23 | 3,723 | 26 |
| `patent/patent-law` | 13 | 2,838 | 15 |
| `patent/patent-deadline` | 10 | 2,816 | 10 |
| `patent/tool-literature` | 18 | 2,370 | 13 |
| `patent/patent-data` | 12 | 2,261 | 14 |
| `patent/patent-fees` | 7 | 1,516 | 6 |
| `patent/writing-patterns` | 7 | 1,347 | 10 |
| `patent/patent-filing` | 10 | 1,334 | 11 |
| `patent/methodology` | 5 | 626 | 6 |
| `patent/patent-index-asset` | 5 | 376 | 1 |
| `legal/legal-knowledge` | 16 | 2,246 | 9 |
| `legal/legal-evidence` | 12 | 1,695 | 5 |
| `legal/legal-law` | 8 | 1,505 | 5 |
| `document/doc-template` | 13 | 2,222 | 12 |
| `document/document-deliver` | 4 | 1,789 | 2 |
| `document/docx-kit` | 8 | 1,720 | 7 |
| `document/doc-style` | 7 | 821 | 5 |
| `document/office-to-pdf` | 6 | 656 | 4 |
| `video/video-mode` | 22 | 7,276 | 16 |
| `video/ui-video-studio` | 7 | 1,417 | 3 |
| `video/video-bundle` | 1 | 2 | 1 |

**结论**：patent 占 83.6%，必须给两个人力；legal、document、video 各约 5%，各配 0.5–1 人。按相等时间分配会让 patent 只被抽样，风险最高。

### 2.3 复杂度热点（>800 行）

| 文件 | 行数 | 风险类型 |
|---|---:|---|
| `patent/patent-deadline/src/statutes.ts` | 1,304 | 法规数据 + 日期计算，数据与代码混在一起 |
| `experimental/video-mode/src/media.ts` | 1,250 | provider 选择、任务台账、预算门、取消与超时集中在一个文件 |
| `patent/patent-tools/src/figure/render-check-findings.ts` | 951 | 图形渲染 + 检查，几何与报告耦合 |
| `patent/patent-tools/src/figure/section-diagram.ts` | 918 | 几何计算，退化输入风险 |
| `experimental/video-mode/src/comfyui.ts` | 910 | 模板占位符、上传、轮询、取消 |
| `patent/patent-tools/src/figure/leader-line.ts` | 908 | 几何与排版 |
| `patent/patent-workflow/src/workflow/manifests.ts` | 898 | 状态机清单，恢复与幂等 |
| `patent/patent-tools/src/tool/patent-workflow-run.ts` | 858 | 工具层与工作流耦合 |
| `patent/patent-core/src/atoms/handlers/builtin/evidence-check.ts` | 842 | 证据检查规则 |
| `patent/patent-tools/src/figure/dot-builder.ts` | 839 | 图结构生成 |
| `patent/patent-core/src/draft/validate.ts` | 811 | 校验规则集中 |
| `patent/patent-core/src/ipc/ipc-classifier.ts` | 807 | 分类规则 |
| `patent/patent-tools/src/atoms/eligibility.ts` | 797 | 法条适用判断 |
| `patent/patent-tools/src/figure/render-check-scan.ts` | 792 | 渲染检查 |
| `patent/patent-tools/src/figure/freecad-structure-script.ts` | 762 | 脚本生成 |
| `patent/patent-tools/src/figure/circuit-diagram.ts` | 749 | 几何 |
| `patent/patent-rule/src/checker/core-rules.ts` | 737 | 规则表 |
| `patent/patent-rule/src/runtime/RuleLoader.ts` | 736 | 加载与校验 |
| `patent/patent-core/src/index.ts` | 724 | 公共导出面 |
| `patent/patent-teams/src/service.ts` | 715 | 并发与生命周期 |
| `patent/patent-teams/src/task-ops.ts` | 706 | 任务调度 |
| `patent/patent-tools/src/tool/analyze-patent-figure.ts` | 697 | 工具入口 |
| `document/document-deliver/src/tool.ts` | 688 | 会话日志与质量门 |
| `patent/patent-core/src/atoms/handlers/builtin/claim-strategy.ts` | 621 | 策略规则 |

## 3. 组织与节奏

### 3.1 角色

| 角色 | 负责范围 | 关键职责 |
|---|---|---|
| A（patent 核心） | `patent-core`、`patent-data`、`patent-knowledge`、`patent-index-asset`、`patent-law`、`patent-fees`、`patent-deadline` | 正确性审查、法规/费用/期限边界 |
| B（patent 应用） | `patent-tools`、`patent-rule`、`patent-workflow`、`patent-teams`、`patent-document`、`patent-filing`、`writing-patterns`、`methodology`、`tool-literature` | 工具契约、图形渲染、状态机、并发 |
| C（legal + document） | `legal/*`、`document/*` | 引用门、证据评分、DOCX/PDF 管线 |
| D（video + 共享收敛） | `experimental/video-mode`、`ui-video-studio`、`video-bundle`，以及跨领域共享 seam | provider 台账、ffmpeg、提升评估 |
| R（轮值评审） | 全范围 | 每日合并前复核；P0 双人签字 |

### 3.2 每日节奏

- 09:30 站会 15 分钟：昨天合并了什么、今天审哪个包、有没有阻塞。
- 每个 PR 只做一件事，diff 尽量 ≤ 400 行；`simplification` 与 `behavior fix` 不得混在一个 PR。
- P0 先写失败测试，再修复；无法复现的只登记，不改代码。
- 每日收工前跑当日包的门禁（见第 8 节），结果贴在 PR 描述。
- 周五 60 分钟复盘：指标对比、下周任务调整、遗留项归档。

### 3.3 审阅方法

1. **采样优先级**：公共导出面与 `types.ts` → 单文件 > 400 行 → `git log` 近半年改动最频繁的文件 → 错误路径与边界 → 其余抽样。
2. **每个文件的检查项**：导出契约与 JSDoc；`any` / `as unknown` 逃逸；隐式默认值；错误是否被吞；资源/监听是否可释放；上限是否作用于完整结果；模型可见文本是否稳定。
3. **证据要求**：每条发现必须写 `文件:行号`、风险说明、触发条件、建议动作、验证用例；P0/P1 必须有可执行验证。
4. **等价性优先**：重构前先补特征测试或录制快照；再删代码；最后改结构。
5. **爆炸半径**：改动前用 `pnpm run change-scope` 确认受影响包，避免只修调用点。

## 4. 30 天日程

按 30 个工作日计（6 周，周末为缓冲）。四条轨道并行，但每日合并窗口统一在 16:00–18:00。

### 第 1 周：基线、规范与 patent-core 开局

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D1 | 采集基线：行数、>400 行文件、TODO 清单、`duplication`、覆盖率、`report:structure`；建风险登记册；冻结本轮范围 | 基线快照 v1；风险登记册初版 |
| D2 | 制定各领域审查清单与 PR 模板；确认每日门禁命令与责任人；确定 P0 判定标准 | 清单与模板入库；站会通过 |
| D3 | `patent-core` 公共面：`index.ts`、`types.ts`、导出与 JSDoc、`any`/`unknown` 逃逸 | 导出面问题清单；低风险清理 PR |
| D4 | `patent-core` 核心算法：atoms/checker/claim-chart/evidence/reasoning/graph 抽样 | P0/P1 清单；特征测试补齐 |
| D5 | 第 1 周复盘；合并已完成的 P1；更新指标 | 指标 v1；下周调整 |

### 第 2 周：patent 数据、法规与期限

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D6 | `patent-core` 收尾：`draft/validate.ts`、`ipc/ipc-classifier.ts`；提取纯函数与规则表 | 精简候选清单 |
| D7 | `patent-data`：子进程 provider、超时/重试/错误映射、凭据解析 | 失败路径测试；错误码统一 |
| D8 | `patent-knowledge`、`patent-index-asset`：FTS 查询、严格字段读取、索引资产格式 | 索引读取边界测试 |
| D9 | `patent-law`、`patent-fees`：引用判定、费用档位、滞纳金、减免 | 判定用例矩阵；来源记录检查 |
| D10 | `patent-deadline`：拆分 `statutes.ts` 数据/代码；月末、闰年、节假日滚动、送达日边界 | 边界测试集；文件 ≤ 800 行 |

### 第 3 周：patent 工具、规则、工作流与团队

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D11 | `patent-tools` 工具层抽样：schema、结果结构、错误码、结果上限 | 工具契约问题清单 |
| D12 | `patent-tools/figure` 渲染族：7 个 >700 行文件；几何、数值确定性、退化输入、CJK 字体 | 渲染回归快照；拆分方案 |
| D13 | `patent-rule`：`core-rules.ts` 规则表、`RuleLoader.ts` 加载校验、`post-execute` 拒绝路径 | 拒绝路径必须有执行器级测试 |
| D14 | `patent-workflow`：`manifests.ts` 状态机、恢复、幂等、HITL 审批 | 恢复/重复调用测试 |
| D15 | `patent-teams`、`patent-document`、`patent-filing`；周复盘 | 生命周期/释放测试；指标 v2 |

### 第 4 周：patent 收尾与跨域收敛

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D16 | `writing-patterns`、`methodology`、`tool-literature`：语料选择、TRIZ 表、文献连接器 | 语料/矩阵边界测试 |
| D17 | `patent-document` + `patent-filing` 与 `document/docx-kit` 的 DOCX 管线比对 | 共享或明确保留各自实现的决策 |
| D18 | `patent-law` ↔ `legal-law` 收敛评审：先证明行为等价，再抽共享包 | 等价性测试；收敛方案（可只落地一半） |
| D19 | `patent-knowledge` ↔ `legal-knowledge` 收敛评审；`patent-index-asset` 复用评估 | 查询行为对比表 |
| D20 | 落地本周收敛改动；patent 指标复盘 | 指标 v2；patent 结项清单 |

### 第 5 周：legal 与 document

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D21 | `legal-evidence`：三性评分规则表、确定性、缺失字段与边界 | 规则表驱动测试（已完成，PR #793） |
| D22 | `legal-knowledge`：FTS5 与内存回退的一致性、查询上限、空结果 | 双后端一致性测试（已完成） |
| D23 | `legal-law` 收尾；`document-deliver`：会话日志可重建性、质量门状态 | 会话事件覆盖检查（已完成） |
| D24 | `docx-kit`、`doc-template`：XML 转义、zip 边界、模板变量注入、CJK 字体 | 恶意/超限模板测试（已完成） |
| D25 | `office-to-pdf`：队列上限、缓存失效、LibreOffice 进程与临时目录清理、大小上限；周复盘 | 清理/超时测试；指标 v2.5 |

### 第 6 周：video 与全局收口

| 日 | 主任务 | 交付 / 门禁 |
|---|---|---|
| D26 | `video-mode/media.ts`：provider 选择、任务保留、journal/ledger、预算门、取消/超时 | 并发与重启恢复测试（已完成） |
| D27 | `comfyui`、`minimax`、`siliconflow`：占位符类型保持、轮询节流、成本估算、大小上限、错误映射 | provider 契约测试；无密钥自跳过复核（已完成） |
| D28 | EDL/ffmpeg、字幕、faststart、参数注入安全；`ui-video-studio`；video 提升评估（media/ + video/ 拆分是否具备条件） | 渲染快照；提升评估结论（已完成：video 留在 experimental，拆分待纯移动） |
| D29 | 全量验证：`build:artifacts` → `build:check`、定向测试、关键快照、`doc-sync`、`duplication`；修复回归 | 全绿门禁记录（已完成：见执行卡 §97–§99） |
| D30 | 指标 v3 对比、最终报告、升级指南（如有破坏性变更）、遗留项与下一轮建议 | 结项报告 |

## 5. 领域审查清单

### 5.1 patent

- **法规与引用**：每个法条判定必须有来源记录；`statutes.ts` 拆分后数据与计算分离；引用格式解析覆盖中文标点与全角数字。
- **期限**：月末加月、闰年、法定节假日顺延、送达日与起算日；用表驱动测试固定行为。
- **费用**：费用档位、减免比例、滞纳金起算、年度阶段切换；金额计算避免浮点误差。
- **工作流**：状态迁移是否封闭；恢复是否幂等；HITL 审批拒绝路径是否在真正执行处生效。
- **规则门**：`post-execute` 拒绝必须通过执行器验证，不能只测纯函数。
- **图形渲染**：退化输入（零尺寸、共线、超长标签、空集合）、数值确定性、字体缺失时的降级。
- **团队**：定时器/订阅释放、任务重入、邮箱持久化、跨进程边界。
- **数据 provider**：超时、重试上限、错误码映射、凭据轮换。

### 5.2 legal

- 引用门的逐条判定与索引版本一致性；索引缺失时是否显式失败而不是静默通过。
- 三性评分的规则表可读性与确定性；同一输入重复评分必须一致。
- FTS5 与内存回退的结果一致性；查询上限与空结果处理。
- 与 patent 域同名能力的重复度（见 6.1）。

### 5.3 document

- `docx-kit`：XML 转义、zip 解压边界、图片尺寸、样式表映射、字体回退。
- `doc-template`：模板资源打包路径、变量替换的注入风险、缺失变量行为。
- `document-deliver`：交付记录必须能从会话日志重建；质量门状态不得只在内存。
- `office-to-pdf`：队列并发上限、缓存键与失效、子进程超时与清理、临时文件残留、输入大小上限。

### 5.4 video

- `media` 服务：provider 选择歧义、任务保留上限、等待语义、取消与超时的最终状态。
- journal/ledger：重启恢复、重复计费防护、预算门「取两者较大值」的测试覆盖；并发提交不得被误认为预留。
- ComfyUI：占位符整串保持 JSON 类型；上传路径安全；轮询节流；取消时远端与本地状态一致。
- MiniMax / SiliconFlow：密钥每次解析、URL 下载后再落盘、字节上限、失败不扣费记录。
- EDL：ffmpeg 参数必须走数组而非拼接字符串；字幕字体缺失、时长不匹配、无音轨的告警路径。
- `ui-video-studio`：只读定位、Range 请求、旧会话无项目时的空状态。

### 5.5 跨领域

- `patent-law` 与 `legal-law`：引用解析、逐条判定、工具命名三处是否只有数据源不同。
- `patent-knowledge` 与 `legal-knowledge`：SQLite FTS5 查询层、回退实现、结果结构。
- `patent-index-asset`：已是共享资产格式，评估扩大复用。
- `patent-document` / `patent-filing` 与 `document/docx-kit`：DOCX 生成与样式映射是否应共享底层。
- 四个领域对 `ctx.fs`、`ctx.subprocess`、`ctx.tools` 的用法是否一致；错误码与结果上限是否统一。

## 6. 精简与优化候选（按优先级）

### P0：正确性与安全（先做，不追求行数）

1. 法规/费用/期限数据与计算混排 → 拆分数据文件，补边界测试。
2. 规则拒绝路径只在纯函数层测试 → 补执行器级拒绝测试。
3. 视频预算门与 ledger 的并发语义 → 明确「非预留」，补并发测试。
4. 文件/字节上限未覆盖包装与元数据 → 按完整结果施加上限。
5. 子进程、队列、缓存、临时目录的释放路径 → 补 teardown 测试。

### P1：去重与契约收敛

1. `patent-law` / `legal-law` 抽取共享引用解析与判定核心，保留各自数据源与工具名。
2. `patent-knowledge` / `legal-knowledge` 抽取共享 FTS 查询层，禁止两份 SQL 与回退逻辑漂移。
3. `patent-document` / `patent-filing` / `docx-kit` 统一 DOCX 底层写出行，领域层只保留模板与格式差异。
4. 四个领域的输出上限、错误码、时间处理抽到 `util` 已有能力，而不是新建抽象。

### P2：文件与结构

1. `patent-deadline/statutes.ts` 拆为「数据 + 计算 + 查询」。
2. `video-mode/media.ts` 拆为「选择 + 任务台账 + 执行」。
3. `patent-tools/figure` 按「几何计算 / 渲染 / 检查」分层。
4. `patent-workflow/manifests.ts` 拆为清单数据与状态机执行。
5. `patent-teams/service.ts` 与 `task-ops.ts` 明确服务与调度边界。

### P3：可读性与一致性

1. 清理无用导出、重复类型、只被一个内部调用者的公共方法。
2. 统一四个领域的错误文案与补救建议格式。
3. 处理 37 处 TODO：能做的当场做，不能做的转 Issue 或 Agent Note。

## 7. 每日与每周质量门

### 7.1 每日（按改动包定向执行）

```bash
pnpm run typecheck
pnpm run lint
pnpm exec vitest run <改动包路径>
pnpm run build:artifacts && pnpm run build:check   # 每日至少一次
```

### 7.2 触发条件

| 改动类型 | 追加门禁 |
|---|---|
| 模型可见输出、提示词、工具 schema | `pnpm run test:snapshot -t <相关快照名>` |
| 持久化类型 / Session 事件 | 持久化变更确认 + 快照更新 + 双人复核 |
| 文档、README、JSDoc | `pnpm run doc-sync` |
| 跨包移动或删除 | `pnpm run duplication` + `pnpm run change-scope` |
| 对外可感知的破坏性变更 | 升级指南 + PR 描述说明 |

### 7.3 每周五

```bash
pnpm run duplication
pnpm run doc-sync
pnpm run test:coverage        # 只作为周度门禁，不做每日重复
scripts/report-structure.ts   # 结构指标
```

> 遵循仓库策略：CI 负责全量覆盖与平台矩阵，本地不默认跑全量。

## 8. 风险与回滚

| 风险 | 控制 |
|---|---|
| 法规/费用/期限改错 | 数据类改动必须附官方来源与双人复核；没有来源时只重构代码不动数值 |
| 重构改变行为 | 先补特征测试/快照再动手；`simplification` 分支要求既有测试零改动通过 |
| 大规模文件移动冲突破坏历史 | 纯移动单独 PR，不做逻辑修改；合并前 rebase 检查 |
| 视频/云端 provider 无法在 CI 验证 | 以 `fakeProvider` + 录制快照为主；真实 e2e 只在本地、显式触发、自跳过 |
| ffmpeg 主机依赖缺失 | 失败必须报 `MEDIA_FFMPEG_MISSING`；文档记录前置条件 |
| 破坏已发布 Session | 不移动/覆盖已提交代际；确需变更走版本化后继 |
| 30 天做不完 | 以 P0/P1 为硬目标，P2 可顺延；每周五按实际进度裁剪下一周 |

**回滚**：每个 PR 保持可独立回退；跨包收敛分两步（先加共享实现并让旧实现委托，再删除旧实现），确保任一步都可回退。

## 9. 产出物

1. **基线快照 v1**：行数、复杂度、重复、覆盖率、TODO 清单。
2. **风险登记册**：P0–P3，含文件:行号、证据、状态、负责人。
3. **四份领域审查报告**：patent、legal、document、video（可合并进最终报告）。
4. **精简 PR 系列**：按 P0 → P1 → P2 → P3 排列，每 PR 单一意图。
5. **指标快照 v2 / v3**：D20、D30 对比。
6. **结项报告**：完成项、延期项、未解风险、下一轮 30 天建议。
7. **升级指南**：仅当出现外部可感知变更时创建。

## 10. 附录：基线采集命令

```bash
# 各包源码规模与测试文件数
for d in packages/patent/* packages/legal/* packages/document/* \
         packages/experimental/video-mode packages/experimental/video-bundle \
         packages/client/ui-video-studio; do
  [ -d "$d/src" ] || continue
  loc=$(find "$d/src" \( -name '*.ts' -o -name '*.tsx' \) -exec cat {} + | wc -l)
  n=$(find "$d/src" \( -name '*.ts' -o -name '*.tsx' \) | wc -l)
  t=$(find "$d/tests" -name '*.ts' 2>/dev/null | wc -l)
  printf "%-46s src_files=%-4s loc=%-7s test_files=%s\n" "$d" "$n" "$loc" "$t"
done

# 超长文件与总量
find packages/patent packages/legal packages/document \
     packages/experimental/video-mode packages/client/ui-video-studio \
     -path '*/src/*' \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + |
  awk '$2 != "total" && $1 > 400' | sort -rn | head -30

# 标记与重复
grep -rn "TODO\|FIXME\|XXX\|@deprecated" --include='*.ts' --include='*.tsx' \
  packages/patent packages/legal packages/document \
  packages/experimental/video-mode packages/client/ui-video-studio | wc -l
pnpm run duplication
pnpm run report:structure
```
