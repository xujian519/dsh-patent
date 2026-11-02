# DeepSeek Harness · License Policy

本文档描述本仓库的许可证结构、允许进入本仓库的依赖许可证范围、以及处理许可证边界问题的流程。目标有三：让贡献者知道哪些依赖可以直接引入而哪些需要走流程；让 reviewer 在 PR 里一眼能对照 gate 判断；让外部审计师能从产物反推出完整 inventory。

本仓库的许可证合规由一组自动化 gate 强制执行。当本文件与 gate 冲突时，以 gate 为准，并请在同一个 PR 里同步更新本文档。

---

## 1. 本项目的许可证结构

| 范围 | 许可证 | 说明 |
|---|---|---|
| 根仓库 `LICENSE` | **MIT** | 与 vendor Cordis 的 upstream 保持一致 |
| 本仓库自有 DSH 包 (`packages/*/*`) | **MIT-selectable** | 可选择性声明 `MIT`、`MIT OR Apache-2.0`、`MIT/Apache-2.0`；不能只写 `Apache-2.0` 或 `MIT AND Apache-2.0`，也不能写 BSD/GPL。由 `verify-dsh-package-licenses` gate 强制 |
| `native/` (node-addon-system) | BSD-3-Clause | 历史原因；已在 package.json 明确声明，gate 放行 |
| `vendor/` | 各 upstream license | vendor README.md 记录了每一份的上游来源与同步方式，不改写其 license 字段 |
| 第三方依赖 | 见下方 §2 | |

## 2. 允许进入本仓库的第三方依赖许可证

本仓库只接受 **permissive 或弱 copyleft** 的依赖。允许列表：

- `MIT`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`
- `Apache-2.0`（含 `MIT OR Apache-2.0`、`MIT/Apache-2.0` 这类双选表达式）
- `MPL-2.0`
- `LGPL-2.1+`、`LGPL-3.0+`

明确禁止 **强 copyleft**：`GPL-1.0`、`GPL-2.0`、`AGPL-3.0` 及其后版本。传染性 license 与根项目 MIT 的分发条款冲突。

### 需要申请例外的情况

- 想引入强 copyleft 依赖（例如某些 GPL-3.0 的 CLI 工具）
- `observedLicense`（从 shipped LICENSE 文件解析出的 SPDX id）与 manifest 声明的 `declaredLicense` 不一致，且你想采用 observed 作为 concluded
- 依赖本身无明确 license 文件（`declaredLicense` 和 `observedLicense` 都是 undefined）

例外申请 → **legal mode 入口**（目前仍在建设，格式与审批通道将在 Phase 4 落地后写在这里）。

---

## 3. 许可证三维度

本仓库为每个依赖记录三个独立维度，并在 SPDX / CycloneDX SBOM 中全部输出：

| 维度 | 来源 | 含义 |
|---|---|---|
| `declaredLicense` | npm `package.json#license` / Python `pyproject.toml` 等 manifest 字段 | 上游作者自我声明的 license 类型。最权威，但偶尔会与 shipped LICENSE 文件不一致 |
| `observedLicense` | 解析 npm tarball 里的 `LICENSE*` / `COPYING*` / `NOTICE*` 文件 | 从实际分发产物里推断的 SPDX id。用于发现 declared 不准的情况 |
| `concluded` | 本仓库采用的最终许可判定 | 默认等于 `declared`；例外需要显式 override（`OVERRIDES` map） |

### 当前已知的 declared ≠ observed 条目

这些条目不是 gate fail，而是 inventory 里的**事实记录**。concluded 暂时维持 declared，等待人工审计后再决策是否需要加 override：

| 包名 | 类型 | declared | observed | 发现渠道 |
|---|---|---|---|---|
| `domhandler`@5.0.3 | npm (dev-npm) | BSD-2-Clause | BSD-3-Clause | Phase 2 observed 扫描 |
| `marked`@16.4.2 | npm (dev-npm) | MIT | BSD-3-Clause | Phase 2 observed 扫描 |
| `cos-nodejs-sdk-v5`@3.0.0 | npm (test-npm) | ISC | MIT | Phase 2 observed 扫描 |

---

## 4. 自动化 gate 清单

| Gate | 命令 | 检查什么 |
|---|---|---|
| DSH 自有包 license | `pnpm run verify-dsh-package-licenses` | 每个 `@deepseek-ai/dsh-*` 包的 package.json#license 是 MIT-selectable 的 SPDX 表达式 |
| Workspace 约束 | `pnpm run check-workspace-constraints` | vendor 目录完整性、subagent-oar 的 MIT + LICENSE-OAR 并存时必须配 NOTICE、native package.json 的 BSD-3-Clause 不得改、等 |
| 第三方 notices | `pnpm run verify-third-party-notices` | `THIRD_PARTY_NOTICES.md` 的字节与当前 inventory 完全一致；任何清单变更必须同步重生成并 commit |
| SBOM bytes 锁 | `pnpm run verify-sbom`（或分别 `verify-spdx` / `verify-cyclonedx`） | `sbom.spdx.json` 与 `sbom.cdx.json` 字节与当前 inventory 完全一致；时间戳回传给 generator，防止漂移 |

上面任意一个在 `pnpm run check:all` 链路中 fail，CI 不会继续。

---

## 5. 审计师快速入口

| 文件 | 格式 | 用途 |
|---|---|---|
| `THIRD_PARTY_NOTICES.md` | 人类可读 Markdown | 每个依赖的名称、版本、license、上游地址、来源（runtime / dev-npm / build-npm / test-npm / python-depend 等） |
| `sbom.spdx.json` | SPDX 2.3 JSON | 含完整 `DEPENDS_ON` 闭包、purl externalRefs、每个 package 的 declared / observed / concluded |
| `sbom.cdx.json` | CycloneDX 1.7 JSON | 含 components + dependencies DAG、每个 component 的 `properties`（declared / observed / tier / patched） |
| `scripts/gen-third-party-notices.ts` + `scripts/render-sbom.ts` | TypeScript | inventory 源头与渲染逻辑；所有 policy（白名单、override、tier）都在这里硬编码 |

所有这些产物由同一个 `collectInventory()` 函数生成，**只可能在一个地方引入不一致**。

---

## 6. 变更流程

1. 引入新依赖 → 确认 license 在 §2 允许列表内 → 正常 PR
2. 想加不在列表内的依赖 → 走例外流程 → 审批通过后再引入，并在 `OVERRIDES` map 里登记 concluded license
3. 修改 vendor 包或 patch 上游代码 → 维持其原 license 字段不变，但如果 patch 被打包进了发布产物，在该包的 `NOTICE` 文件里说明修改内容（参考 `packages/experimental/subagent-oar/NOTICE`）
4. 新写的 DSH 自有包 → 必须声明 `license: "MIT"`（或 MIT-selectable），否则 `verify-dsh-package-licenses` gate fail
5. Phase 4 落地后，例外流程将在 legal mode 里提供模板与审批历史；在此之前，请在 PR description 里说明理由并 @ maintainer
