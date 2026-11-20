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
| **G3** | #4 默认值双源检测 | P1 | 1d | 待开工 | F-PAT-024：42 对 schema.default 与 ?? 同值字面量 |
| **G4** | #2 同形本地助手检测（脚本门禁） | P1 | 0.5d | ✅ 已落地 | F-CROSS-001 已删；19 处残留已清理并防空档 |
| **G5** | #6 外部 provider 契约测试 | P2 | 3d | 待开工 | H04/H06：provider 失败路径无断言 |
| **G6** | #5 SAST | P3 | 2d | 待开工 | 先跑 Semgrep 四域，记录基线 |
| **G7** | #7 视频账本一致性补完 | P2 | 2d | 待开工 | 并发预算不变量 + 跨进程账本一致性 |

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

## G3 · 默认值双源检测

**目标**：同包内同一字段同时出现 schema `.default(...)` 和 config 侧 `?? 同值字面量` 即失败——防止 F-PAT-024 重复。

**真实反例**：F-PAT-024 修前——七包 42 对：schema `schema.number().default(30)` 配合 config 代码 `pageSize = options.pageSize ?? 30`。任一处改默认值另一处会静默漂移。

**实现**：

新建 `scripts/verify-plugin-defaults.ts`：

```
1. Glob packages/*/src/**/*.tsx?
2. 对每个文件，提取所有 schema 定义：
   - 匹配 `schema.<type>(...).default(<literal>)` 或 `Schema.<type>(...).default(...)`
   - 记录包名 + 字段名 + default 值
3. 对同一文件（或同包其他文件），提取 config 使用：
   - 匹配 `<identifier> ?? <literal>` 和 `<identifier> || <literal>`
   - 字段名通过 Identifier 猜测（或 ts-morph 更精确）
4. 同包内、同字段名、同值字面量 → 报 violation
5. 输出 JSON 报告 + 退出码
```

**工具选型**：
- **简单正则版**（0.5d）：grep schema pattern + ?? pattern，跨文件比对。足够抓 80% 情况
- **ts-morph 版**（1d）：精确到 Schema 节点的 `.default()` 调用和 Identifier → 字面量。推荐——因为 schema 可能链式 `.optional().default(30)` 或 `.default('foo').optional()`

**落地位置**：
- 脚本：`scripts/verify-plugin-defaults.ts`（新建）
- CI：`node-checks` lane，lint 之后追加 step
- 测试：`scripts/verify-plugin-defaults.spec.ts`（新建，用 fixture 文件）

**验收**：
- 用 git log 找到 F-PAT-024 修前的一个 commit，cherry-pick 回来 → 脚本应报 42 条 violation
- 当前 master 应报 0 条（F-PAT-024 已全修）

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

## G7 · 视频账本一致性补完

**目标**：在 R-E2 终态断言基础上，补并发预算不变量和跨进程账本一致性用例。

**已完成（R-E2）**：
- `tests/minimax.spec.ts:441` — 终态状态机断言
- `tests/comfyui.spec.ts:478` — 空产物时 STOPPED 而非 FAILED

**剩余两项**：

### 7a. 并发预算不变量

```typescript
// packages/experimental/video-mode/tests/budget-invariant.spec.ts
it('两个并发任务总预算不超过 provider 限额', async () => {
  const journal = new VideoJournal()
  const task1 = journal.startTask({ budget: 100 })
  const task2 = journal.startTask({ budget: 100 })

  // 模拟 2 个并发请求各消耗 80
  await Promise.all([
    task1.consumeBudget(80),
    task2.consumeBudget(80),
  ])

  // 不变量：journal.totalConsumed <= provider.totalBudget
  expect(journal.totalConsumed).toBeLessThanOrEqual(PROVIDER_LIMIT)

  // 每个 task 内部不变量
  expect(task1.remaining).toBe(20)
  expect(task2.remaining).toBe(20)
})
```

### 7b. 跨进程账本一致性

```typescript
// packages/experimental/video-mode/tests/journal-consistency.spec.ts
it('进程重启后 journal 状态一致', async () => {
  const journal = new PersistedJournal({ path: '/tmp/video-journal.json' })
  journal.startTask({ budget: 100 })
  await journal.consumeBudget(30)
  await journal.save()

  // 模拟崩溃：新进程从磁盘加载
  const reloaded = await PersistedJournal.load('/tmp/video-journal.json')
  expect(reloaded.totalConsumed).toBe(30)
  expect(reloaded.tasks[0].status).toBe('RUNNING')
  expect(reloaded.tasks[0].remaining).toBe(70)
})
```

**落地位置**：`packages/experimental/video-mode/tests/` 新建 2 个 spec 文件
**CI**：已在 `node-coverage` lane
**验收**：
- 用例全部通过
- 临时注释掉 journal 的 save()，7b 应失败

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
