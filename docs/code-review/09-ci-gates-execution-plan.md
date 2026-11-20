# CI 门禁补完计划

**起草**: 2026-11-20
**关联**: docs/code-review/07-ci-hardening.md（Day 43 定稿）、issue #916
**前置**: PR #927 合入 master（R-F3/R-D1/R-F4/R-F5）

## 摘要

7 条门禁在 issue #916 关闭时盘点为：**2 条已覆盖 + 5 条延后**。本计划把 5 条延后项拆成可执行批次，每条先证明能拒绝一个真实反例再进 CI。

| 批次 | 门禁 | 优先级 | 成本 | 状态 | 反例 |
|---|---|---|---|---|---|
| **G1** | #1 反向依赖声明校验（扩展） | P0 | 0.5d | ✅ 已落地 | F-CROSS-002：patent-tools 导入 dsh-value 未声明 |
| **G2** | #3 密钥扫描 | P0 | 0.5d | ✅ 已落地 | OBS-004：当前无任何密钥扫描 |
| **G3** | #4 默认值双源检测（脚本门禁，report 期） | P1 | 1d | ✅ 已落地 | F-PAT-024：62 对字面量双源仍在仓内 |
| **G4** | #2 同形本地助手检测（脚本门禁） | P1 | 0.5d | ✅ 已落地 | F-CROSS-001 已删；19 处残留已清理并防空档 |
| **G5** | #6 外部 provider 契约测试 | P2 | 3d | 部分落地（video-mode） | H04/H06：provider 失败路径无断言 |
| **G6** | #5 SAST（Semgrep，report 期） | P3 | 2d | ✅ 已落地 | 基线 0，3 条规则，独立 `node-sast` lane |
| **G7** | #7 视频账本一致性补完 | P2 | 2d | ✅ 已落地 | 并发 8 条 + 双上下文并发追加 |

---

## G1 · 反向依赖声明校验（扩展 verify-package-dependencies）

**目标**：对每个包的 `src/**/*.ts` 收集 `@deepseek-ai/dsh-*` 导入，要求该包的 `package.json` 在 `dependencies` 或 `peerDependencies` 声明同名条目。

**真实反例**：`packages/patent/patent-tools/src/tool/law-search.ts:16` 导入 `@deepseek-ai/dsh-value`，但 `patent-tools/package.json` 三节均无该声明——`verify-package-dependencies` 仍退出 0，因为它只对 policy 覆盖的 104 个"角色包"做校验，patent-tools 不在其中。

**实现（已落地）**：

`collectReverseImportViolations()` 追加在 `scripts/verify-package-dependencies.ts`，由 `main()` 与既有 violation 集合并后统一排序输出：

1. 遍历 `readWorkspacePackageManifests(root).all`（含 `packages/*/*` 与 `apps/*`，不止 policy 选中的 104 个角色包）
2. 对每个包调用 `readAllSourceUses()` 收集 `src/` 中来自 workspace 包的导入
3. 跳过自引用与 `vendor/`（vendored Cordis 源码按设计不声明 workspace 依赖）
4. 用 `declaredSections()` 检查三节声明，缺失即记 violation

落地时复扫发现 **17 处真实违规**（distinct 包 15 个），全部补 `devDependencies`。补声明后又牵出 G4 改造新增的 7 个 `dsh-value` 依赖（`apps/desktop`、`boot/plugin-manager`、`boot/plugin-market`、`client/ui-conversation`、`experimental/claude-code-mods`、`experimental/client-ui-claude-code-mods`、`experimental/client-ui-forge`、`experimental/deepseek-chat-import`、`legal/legal-evidence`、`patent/patent-data`），同样补齐。

**落地位置**：
- 脚本：`scripts/verify-package-dependencies.ts`（扩展，不新建）
- CI：已在 `node-checks` lane 的 `pnpm run verify-package-dependencies` step（无需加 lane）

**验收（已达成）**：
- 修复前跑出 17 violations 并退出 1（真实反例被拒）
- 补全声明后退出 0：`104 package(s) match the published dependency policy`
- 全仓扫描耗时远低于 lane 预算

**测试**：`scripts/verify-package-dependencies.spec.ts` 的 `reverse import declarations` describe 覆盖三条路径——未声明导入报 violation、任一节声明即通过、自引用/非 workspace/vendored manifest 不报。

---

## G2 · 密钥扫描

**目标**：在 PR 和 master push 时扫描变更行与全量仓库中的硬编码密钥、token、私钥。

**真实反例**：OBS-004——当前 CI 无任何密钥扫描。仓库有 `.env` 在 `.gitignore`，但源码中可能出现示例 token 或 test fixture 泄漏。

**实现（两阶段）**：

### 阶段 1：基线扫描（先跑一次，记录误报）

```bash
# 本地先装 gitleaks
brew install gitleaks
# 全量扫描，输出 JSON 报告
gitleaks detect --source . --report-format json --report-path /tmp/gitleaks-baseline.json --verbose
# 扫描最近 100 个 commit
gitleaks detect --source . --report-path /tmp/gitleaks-history.json --log-opts="-n 100 --all" --verbose
```

然后：
- 审 JSON 报告，把误报（test fixture 中的样例字符串、`.env.example` 中的占位符、公钥）加到 `.gitleaksignore`
- 确定真实阈值（比如：0 个新漏报）

### 阶段 2：CI 门禁（加到 `node-checks` lane，lint 之后）

```yaml
- name: Secret scan (gitleaks)
  uses: gitleaks/gitleaks-action@v2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}  # free for public repos, optional
  with:
    # PR 模式：只扫 diff
    mode: 'pr'
    # master 模式：全量扫描
```

**替代方案**（如果不想用 gitleaks）：
- `secretlint`（纯 npm，规则可写）
- GitHub 原生 secret scanning（public repo 免费，在 repo Settings 开启，然后加一个 check 来 gate）

**推荐**：GitHub 原生 secret scanning——零配置，自动扫描所有推送，检出率和误报率由 GitHub 维护。只需：
1. Repo Settings → Security → Secret scanning → Enable（public repo 免费）
2. 在 CI 加一个 step `gh api repos/:org/:repo/secret-scanning/alerts --jq 'length == 0' || exit 1`

**落地位置**：
- `node-checks` lane：lint 之后追加一个 step
- 或新建独立 lane（推荐，secret scan 独立，不阻塞 lint/typecheck）

**验收**：
- 在一个临时分支 commit 一个假 key，PR 应触发告警
- 现有 master 全量扫描应 0 个真实告警

---

## G3 · 默认值双源检测（已落地：脚本门禁，report 期）

**目标**：同包内同一字段同时出现 schema `.default(<字面量>)` 和 config 侧 `?? 同字面量` 即报——防止 F-PAT-024 重复。

**真实反例**：F-PAT-024 修前——七包 42 对。落地复扫发现**仍存 62 对**（例如 `agent-team` 的 `cookieMaxAgeDays` 与 `defaultEnabled`、`client/connection` 的 `maxTasks`），说明原修复只覆盖了登记过的七包。

**实现（已落地）**：`scripts/verify-plugin-defaults.ts`

正则版，两步提取、同包比对：

1. schema 默认：`<field>: <expr>.default(<literal>)` → 记录字段名与字面量
2. config 兜底：`.<field> ?? <literal>`（含 `)`、`,`、`;`、换行边界）→ 同字段、同字面量即命中
3. 按包目录（`packages/<group>/<pkg>`、`apps/<name>`）聚合，**跨文件**比对，因此 `config.ts` 声明、`index.ts` 兜底的组合也能抓到

字面量限定为数字、单/双引号字符串、`true`/`false`。共用常量（`.default(DEFAULT_X)` 配合 `?? DEFAULT_X`）不计入——那是单一来源，不是双源。

**落地位置**：
- 脚本：`scripts/verify-plugin-defaults.ts`
- 测试：`scripts/verify-plugin-defaults.spec.ts`（纯函数 fixture，5 case：提取行号、跨文件命中、字面量不同不报、共用常量不报、跨包同名字段不报）
- CI：`node-checks` lane，`Shared primitive redefinitions` 之后，`--report` 模式

**为什么先 report**：62 条基线中有一部分是刻意兜底（`client/connection` 注释说明手写测试上下文可能绕过 schema）。逐条审完再转阻塞，避免逼着代码为过门禁而删掉合法防御。

**验收（已达成）**：
- 脚本对当前分支报 62 条，退出 0（report 模式）
- spec 5 case 全过
- 两条真双源已人工确认（`agent-team` 的 `cookieMaxAgeDays ?? 30`、`defaultEnabled ?? false`）

**后续**：审完 62 条基线 → 去掉 `--report` 转阻塞。

---

## G4 · 同形本地助手检测（已落地：独立脚本门禁）

**目标**：禁止在 `packages/*/*/src/**/*.ts` 与 `apps/*/src/**/*.ts` 内定义以下同形函数名——防 F-CROSS-001 回潮。

**真实反例**：F-CROSS-001 删前——`messageOf`、`errorText`、`escapeRegExp`、`asRecord` 四域共 7 份重复实现。落地时复扫又发现 19 处残留（11 `messageOf` + 3 `errorText` + 4 `asRecord` + 2 `escapeRegExp`，另有 2 份签名不同的同形名豁免）。

**实现**：`scripts/verify-no-shared-primitive-redefs.ts`

原计划的 oxlint `no-restricted-syntax` 方案不可行——当前 oxlint 版本不提供该规则（本地实测无输出）。改为独立脚本，静态扫描四类定义形式：

- `function <name>(`
- `const <name> = (`
- `const <name> = async (`
- `const <name> = function(`

命中即报 violation，退出码 1。`--report` 参数保留给基线观察期，正式门禁不带该参数。

**豁免**（脚本内 `EXEMPT` 集合，需显式列出并说明理由）：

- `packages/subprocess/win32-process/src/ffi.ts:errorText` — Win32 错误码格式化，签名与语义均不同
- `packages/extensions/cordis-client-runner/src/client/evaluator.ts:errorText` — console 参数 stringify，含 JSON.stringify 分支

`packages/util/value/src/index.ts`（原语源头）自动跳过；`tests/**`、`scripts/**` 不在扫描 glob 内。

**落地位置**：

- 脚本：`scripts/verify-no-shared-primitive-redefs.ts`
- CI：`.github/workflows/ci-fork.yml` 的 `node-checks` lane，位于 `Duplication` 之后

**验收**（已达成）：

- 脚本对当前分支报 0 violations
- 19 处残留全部改为从 `@deepseek-ai/dsh-value` 导入（`messageOf`/`errorText` → `errorMessage`，`asRecord`/`escapeRegExp` 同名复用）
- `patent/writing-patterns/src/pattern-store.ts` 的三参数 `asRecord` 改名 `assertRecord`（签名不兼容，不属于共享原语）
- `pnpm run typecheck` 5/5 pass

---

## G5 · 外部 provider 契约测试（video-mode 已落地）

**目标**：为每个外部 provider 固定超时、重试、取消、预算超限四种失败路径，不依赖真实网络。

**真实反例**：H04/H06——provider 层的 retry 路径没有断言；F-PAT-038（Nuo search error/timeout 未测试）是其中一个具体实例。

### 前置产品改动：429 重试

契约要求 retry，但 `failureCodeFor(429)` 原本直接返回 `MEDIA_TASK_FAILED`，provider 从不重试。因此先补实现：

- `cloud-common.ts` 新增 `fetchWithRetry`、`retryAfterOf`、`CloudRetryPolicy`、`delay`
- `minimax.ts` 的 submit 与 status 端点改走 `fetchWithRetry`；构造函数新增可注入的 `sleep`（测试不睡真实时钟）
- 配置新增 `maxRetries`（默认 2）与 `maxRetryAfterMs`（默认 5000），`resolveMiniMax` 校验非负整数

重试只对 `429` 生效，且必须带 `Retry-After`（秒数或 HTTP date）。无该头、或要求等待超过 `maxRetryAfterMs` 时立即失败——不做猜测性退避。

### Video mode（已落地）

`packages/experimental/video-mode/tests/minimax.contract.spec.ts`，6 个 case：

| case | 断言 |
|---|---|
| `Retry-After: 1` + 随后成功 | 只等 1000ms 一次，返回 submitted |
| 连续 429 超过 `maxRetries: 2` | 共 3 次请求，两次 0ms 等待，最终 `MEDIA_TASK_FAILED` |
| `Retry-After: 60` 超过上限 | 只请求 1 次，不等待 |
| 无 `Retry-After` | 只请求 1 次，不等待 |
| HTTP-date 形式 | 解析为 2000–3000ms 等待 |
| status 端点 429 | 按同一策略重试后返回 queued |

timeout 与 cancel 已由既有 `minimax.spec.ts`（stub fetch）覆盖，未重复。

### Patent tools / LSP / PTC（已落地）

原计划称五条失败路径"仍无 contract spec"系误判：master 已覆盖其中大部分，真正缺口仅两处，本轮补齐。覆盖矩阵：

| 失败路径 | patent-tools | lsp-stdio | ptc-runtime |
|---|---|---|---|
| 二进制缺失 | ✅ FreeCAD / Inkscape / Graphviz `not_installed` | — | — |
| 渲染超时 | ✅ FreeCAD / Graphviz 既有；**本轮补 Inkscape** | — | — |
| 损坏输入 | ✅ Inkscape 既有 | — | — |
| stdio 断开 | — | ✅ stdin 既有；**本轮补 stderr** | — |
| worker 超时 | — | — | ✅ `timeout.spec.ts` 完整覆盖（注入 fake child） |

新增断言（均不依赖真实外部资源）：

- `figure-inkscape-renderer.spec.ts`「渲染超时（内部计时器）分类为 render_failed」：fake subprocess 的 `done` 在 signal abort 时 settle，`renderTimeoutMs: 30` 触发 deadline，断言 `render_failed` 且错误含「渲染超时」。Inkscape 在 spawn 前有真实异步 fs（`readFile`/`mkdtemp`），故用真实时钟等待，而非 fake clock。
- `connection.spec.ts`「keeps serving requests after the child closes stderr…」：子进程先 `stderr.write` + `stderr.end()` 再正常响应，断言 `conn.failed === false`，退出后 `stderrTail` 保留已写内容——固定 stderr 是诊断尾、非致命传输的契约。

ptc-runtime 的 worker 超时已由 `packages/ptc-runtime/ptc-runtime-node/tests/timeout.spec.ts` 用注入的 fake child 完整覆盖，无需新增。

**CI**：`node-coverage` lane 已跑 vitest，无需新 lane
**验收（已达成）**：`vitest run tests/minimax.contract.spec.ts` → 6 passed；全量 video-mode 套件除既有 `loader-composition.spec.ts` 失败外无回归

---

## G6 · SAST（已落地：Semgrep，report 期）

**目标**：用仓库自有规则集扫描 shipped 源码，先零基线、再阻塞。

**真实反例**：OBS-004——此前仓库没有任何 SAST。

**实现（已落地）**：

- 规则文件 `.semgrep.yml`，3 条规则：
  - `dsh-no-dynamic-code`：`eval(...)` / `new Function(...)`
  - `dsh-no-shell-string`：`exec` / `execSync` 的命令参数以引号或模板开头（argv 形式放行）
  - `dsh-no-hardcoded-credential`：名为 apiKey/secret/token/password 的赋值携带 16 位以上字面量
- CI：`ci-fork.yml` 新增独立 `node-sast` job，用 `semgrep/semgrep:latest` 镜像，不拖慢 `node-checks`
- 规则自检：`scripts/fixtures/semgrep/violations/` 每条规则一个必须命中的样本，`scripts/fixtures/semgrep/clean/` 提供应当放行的对照（argv 形式、运行时凭据、注册表查表）。`node-sast` 在扫描 shipped 源码后跑同一 job 内的两步断言：clean 目录必须退出 0，violations 目录必须非零。规则失效与源码干净在 CI 输出上无法区分，自检把前者变成红灯
- 自检不放进 vitest：`node-coverage` lane 没有 semgrep，spec 只能长期 skip，而跳过读起来是绿的；用 fallback 语言重写规则同样测不到真实规则
- 静态 spec 固定自检的覆盖与接线（不运行 semgrep，因此在 `node-coverage` lane 正常执行）：`scripts/ci-workflow.spec.ts` 断言 `.semgrep.yml` 的规则 id 集合与两个 fixture 目录各自声明的规则 id 集合相等（新增规则无样本、规则改名留下孤儿样本都会失败），以及 `node-sast` 的 shipped 扫描覆盖 `packages apps`、排除 `**/tests/**`、不含 `scripts/fixtures`，自检步骤对 clean 直接跑 `--error`、对 violations 走 `if ...; then` 反转退出码
- 本地运行需重定向 HOME（semgrep 写 `~/.semgrep/semgrep.log`，沙箱下被拒）：
  `HOME=/tmp/sg-home semgrep --config .semgrep.yml packages apps --exclude '**/tests/**'`

**基线**：3 条，全部是设计所需的动态执行，已就地加 `// nosemgrep: dsh-no-dynamic-code` 并保留原有理由注释：

- `webworker-runtime/src/module-system/module-loader.ts`（包装镜像体）
- `extensions/cordis-client-runner/src/client/evaluator.ts`（求值定义体的浏览器半边）
- `extensions/cordis-host-runner/src/sandbox.ts`（仅编译的解析闸门）

**验收（已达成）**：

- `Ran 3 rules on 4314 files: 0 findings`
- `semgrep --config .semgrep.yml --error --quiet scripts/fixtures/semgrep/clean` → 退出 0
- `semgrep --config .semgrep.yml --error --quiet scripts/fixtures/semgrep/violations` → 退出 1，三条规则各至少一次命中
- `pnpm exec vitest run scripts/ci-workflow.spec.ts` → 87 passed（含两条 G6 静态 spec）

**后续**：CI job 现为 report 模式（不带 `--error`）。基线既已是 0，下一次改动即可加 `--error` 转阻塞。

---

## G7 · 视频账本一致性补完（已落地）

**目标**：在 R-E2 终态断言基础上，补并发预算不变量和跨进程账本一致性用例。

**已完成（R-E2）**：
- `tests/minimax.spec.ts:441` — 终态状态机断言
- `tests/comfyui.spec.ts:478` — 空产物时 STOPPED 而非 FAILED

**已补两项**（`tests/store.spec.ts` 的 `budget ledger` describe）：

### 7a. 并发预算不变量

计划中的 `VideoJournal.consumeBudget` API 在仓内不存在——`budgetCny` 只是项目文档字段，没有强制逻辑。因此不变量落在账本层：并发追加不得丢条目、不得重复计费。

```typescript
it('keeps every charge when many append at once', async () => {
  const charges = Array.from({ length: 8 }, (_, i) => entry({ taskId: `task-${i}`, costCny: 0.5 }))
  const results = await Promise.all(
    charges.map(charge => appendLedgerEntry(ctx, projectPath, charge, ledgerDir, root)),
  )
  expect(results).toEqual(Array<boolean>(8).fill(true))
  expect(ledgerCost(await readLedger(ctx, projectPath, ledgerDir, root))).toBe(4)
})
```

### 7b. 跨进程账本一致性

两个 `Context` 各自持有 `LocalFileSystem` 指向同一目录，共享文件但不共享进程内 key 锁，等价于两个进程同时计费：

```typescript
it('keeps every charge two file-system contexts write concurrently', async () => {
  const peer = new Context()
  await peer.plugin(LocalFileSystem, { cwd: root }).await()
  await Promise.all([
    appendLedgerEntry(ctx, projectPath, entry({ taskId: 'local-a' }), ledgerDir, root),
    appendLedgerEntry(peer, projectPath, entry({ taskId: 'peer-b' }), ledgerDir, root),
    appendLedgerEntry(ctx, projectPath, entry({ taskId: 'local-c' }), ledgerDir, root),
    appendLedgerEntry(peer, projectPath, entry({ taskId: 'peer-d' }), ledgerDir, root),
  ])
  const ledger = await readLedger(ctx, projectPath, ledgerDir, root)
  expect(ledger.map(item => item.taskId).sort()).toEqual(['local-a', 'local-c', 'peer-b', 'peer-d'])
  expect(ledgerCost(ledger)).toBe(8)
})
```

**落地位置**：`packages/experimental/video-mode/tests/store.spec.ts`（复用既有 fixture，不新建文件）
**CI**：已在 `node-coverage` lane
**验收（已达成）**：`vitest run tests/store.spec.ts` → 28 passed；版本号重试机制在两个上下文并发时未丢任何条目

---

## 批次总览（按时间线）

```
Week 1
  ├─ G1 reverse dependency extension ───── 0.5d ──── exit 0/1
  ├─ G2 secret scanning ────────────────── 0.5d ──── 加 step 到 node-checks
  └─ G4 oxlint no-restricted-syntax ────── 0.5d ──── 改 .oxlintrc.json

Week 2
  ├─ G3 verify-plugin-defaults ──────────── 1d ──── 新脚本 + spec
  └─ G6 Semgrep baseline ────────────────── 2d ──── 跑一次 + 审误报

Week 3-4（并行）
  ├─ G5 provider contract tests ─────────── 3d ──── 四域各 1 个 contract spec
  └─ G7 video journal invariants ─────────── 2d ──── 2 个 invariant spec
```

## 反例来源引用

| 反例 | 发现 | 关联 PR/commit |
|---|---|---|
| F-CROSS-001 | R-F4 F-CROSS-001 修复（PR #927，commit 6da7b84） | 已修复，门禁防回潮 |
| F-CROSS-002 | patent-tools/law-search.ts:16 导入 dsh-value 未声明 | 真实反例，G1 直接抓 |
| F-PAT-024 | 七包 42 对 schema.default 与 ?? 同值字面量 | 已在历史 commit 修 |
| F-PAT-038 | Nuo search error/timeout 无测试 | R-D1 补了单测，G5 补 provider 级 |
| OBS-002 | pnpm audit 在当前 registry 不可用 | G2 覆盖（GitHub native） |
| OBS-004 | 当前无密钥扫描、无 SAST | G2 + G6 |
| H04/H06 | provider 失败路径无断言 | G5 |
| F-VID-009/010 | video-mode provider 收敛 → confirmed | 已确认 |

---

*本计划不修改任何仓库文件；实施由独立 PR 承载。*
