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
| **G5** | #6 外部 provider 契约测试 | P2 | 3d | 待开工 | H04/H06：provider 失败路径无断言 |
| **G6** | #5 SAST | P3 | 2d | 待开工 | 先跑 Semgrep 四域，记录基线 |
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

## G5 · 外部 provider 契约测试

**目标**：为每个外部 provider（EDL/Minimax/ComfyUI/FreeCAD/Inkscape/Nuo）加本地 mock server，固定超时、重试、取消、预算超限四种失败路径。

**真实反例**：H04/H06——provider 层的 timeout/retry/cancel/429 路径没有独立于真实网络的断言；F-PAT-038（Nuo search error/timeout 未测试）就是其中一个具体实例。

**实现**（分域）：

### Video mode（最有价值，已有 R-E2 基础）

```
packages/experimental/video-mode/tests/
  minimax.contract.spec.ts     ← 新建，mock HTTP server
  comfyui.contract.spec.ts     ← 新建，mock WebSocket + HTTP
```

每个文件覆盖：
- timeout → provider 超时后返回 HarnessError，不 hang
- 429 + retry-after → provider 等够 retry-after 再重试
- cancel → AbortSignal 触发后立即停请求，不泄漏
- 预算超限 → journal 写入 STOPPED 而非 FAILED

### Patent tools（FreeCAD/Inkscape）

```
packages/patent/patent-tools/tests/
  freecad-renderer.contract.spec.ts
  inkscape-renderer.contract.spec.ts
```

覆盖：
- 二进制不存在 → 返回 HarnessError 带 install hint
- 渲染超时 → 杀进程 + 返回 HarnessError
- 损坏输入 → 进程退出码非 0，错误消息透传

### LSP + PTC runtime

```
packages/lsp/lsp-stdio/tests/
  protocol.contract.spec.ts
packages/ptc-runtime/ptc-runtime-node/tests/
  worker.contract.spec.ts
```

覆盖：
- stdin/stderr 断开 → 进程立即退出
- 超时无响应 → kill + 返回 HarnessError

**工具选型**：
- `msw`（HTTP/WebSocket mock，零额外 server）
- 或 `nock`（HTTP interceptor）
- 进程级：用 Node `child_process.fork` + 超时 kill

**落地位置**：各 provider 包的 `tests/` 目录下加 `*.contract.spec.ts`
**CI**：`node-coverage` lane 已跑 vitest，无需新 lane

**验收**：
- 每个 contract spec 至少 4 个 case（timeout/retry/cancel/budget）
- 临时在 provider 代码注释掉 retry，case 应失败
- `node-coverage` lane exit 0

---

## G6 · SAST（Semgrep）

**目标**：先跑一轮四域，记录基线（发现 X 条），再设「只降不升」阈值——任何 PR 引入新发现即红。

**真实反例**：OBS-004——当前无任何 SAST。四域 98 条发现里，虽然没有 RCE/注入级高危，但 SAST 能抓 pattern 级的（如 eval、JSON.parse 未校验、硬编码 secret）。

**实现（两阶段）**：

### 阶段 1：基线

```bash
brew install semgrep
# 跑官方规则集（javascript + typescript）
semgrep ci --config p/javascript --config p/typescript \
  --include="packages/patent/**/*.ts" --include="packages/legal/**/*.ts" \
  --include="packages/experimental/video-mode/**/*.ts" \
  --json > /tmp/semgrep-baseline.json
# 记录 baseline 数字
```

审 baseline JSON，把：
- 误报（rule 和代码语义不符）→ 加到 `.semgrepignore`
- 真实发现但可接受（比如 test 里有 `eval`）→ 加到 baseline 阈值
- 真实发现需修 → 开 PR 修

### 阶段 2：门禁（新建独立 lane，避免拖慢主 lane）

```yaml
node-sast:
  if: github.event_name == 'pull_request' && github.repository_owner == 'xujian519'
  runs-on: ubuntu-latest
  name: node 24 / SAST (Semgrep)
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v6
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v6
      with:
        node-version: '24'
    - run: pnpm install --frozen-lockfile
    - uses: semgrep/semgrep-action@v1
      with:
        config: 'p/javascript, p/typescript'
        audit_on: 'change'  # PR 模式只扫 diff
```

**备选**：CodeQL（GitHub 内置，security score 更高），但跑一次慢 5-10 分钟，public repo 免费。

**落地位置**：新建 `.github/workflows/ci-sast.yml`（独立文件，和 ci-fork.yml 并列）
**验收**：
- 基线阶段记录发现数 N
- CI lane 设为 report（不阻塞）先观察 2 周
- 2 周后升级为 block

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
