# 审阅范围与约定

## 目的与未来

- REVIEW_PURPOSE：例行健康检查。
- REPO_FUTURE：持续演进。
- 时间预算：每天 1—2 小时，共 45 天；可缩放到 30 天或拉伸到 60 天。
- 产出：可执行的发现清单、优先级队列、CI 门禁建议和复盘记录。
- 跟踪方式：远程仓库 issue，总跟踪与阶段 issue 见 [README.md](README.md) 的“Issue 跟踪”。

## 范围

| 域 | 包 | 说明 |
|---|---|---|
| 专利域 | `packages/patent/*` | 16 个包，约 11.6 万行 `src`，407 个测试文件 |
| 文档模式 | `packages/document/*` | 6 个包，约 0.87 万行 `src`，38 个测试文件 |
| 法律模式 | `packages/legal/*`、`packages/law/*` | 5 个包，约 0.75 万行 `src`，36 个测试文件 |
| 视频模式 | `packages/experimental/video-mode`、`packages/experimental/video-bundle`、`packages/client/ui-video-studio` | 3 个包，约 0.88 万行 `src`，18 个测试文件 |

行数与测试文件数由 2026-11-15 的 `find`/`wc -l` 统计，作为审阅广度参考，不作为质量结论。

## 排除项

- 不修改业务代码、依赖、CI 配置或基础设施配置。
- 不评审 `vendor/`、通用核心包（`packages/core`、`packages/session` 等）的完整实现；只在与四域交界处抽检。
- 不在本周期内处理既有失败的本地门禁；只记录并归类。
- 不提交、推送或改写 Git 历史。

## 严重度定义

| 级别 | 判定标准 | 处理时限 |
|---|---|---|
| Blocker | 可导致数据丢失、越权访问、密钥泄露、不可恢复的账本错误 | 立即上报，暂停相关改动 |
| High | 可导致错误业务结论、静默降级、外部服务重复计费、关键路径不可用 | 本周期内修复 |
| Medium | 局部正确性问题、可绕过的校验、明显的性能退化、测试缺口 | 下一周期内修复 |
| Low | 可维护性问题、重复代码、文档与命名漂移 | 排入常规清理 |

## 审查维度

- A 安全缺陷：授权校验、输入到危险汇点、历史密钥、依赖漏洞。
- B 代码质量与精简：死代码、可删除的抽象、结构柔道、复杂度和文件体量失控。
- C 优化：有证据的慢路径、N+1、缺失索引、并发与资源生命周期。
- D 测试缺口：完全未测、断言太弱、只覆盖 happy path。
- E 正确性与边界：错误处理、类型边界、业务不变量、静默降级。

## 已解决假设

1. `docs/code-review/` 的中文单语文档配对问题：2026-11-15 按用户确认，在 `scripts/translation-pairing.manifest.json` 的 `excluded` 列表加入 `"docs/code-review/"`。复跑 `pnpm run verify-translation-pairing` 退出码 0，1725 对全部一致。
2. Node 环境：2026-11-15 确认在 Node 24 环境补跑完整构建与覆盖率基线；本机 nvm 下 `v24.19.0` 可用。
3. 视频模式标准：2026-11-15 确认按实验特性审阅；安全、资源生命周期与账本一致性问题仍按产品级标准记录。
4. 范围：2026-11-15 确认包含 `packages/law` 的 `law-core` 与 `knowledge-core`。
5. 周期：2026-11-15 确认按 45 天执行。

## 待确认假设

1. 本机未安装 LibreOffice，`packages/document/office-kit` 的真实转换链路无法在本地验证；CI 或安装后再补。
2. 当前 pnpm registry 为 npmmirror，`pnpm audit` 返回 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`；依赖漏洞基线需要改用 npmjs registry 或依赖 Dependabot 数据。

## 发现质量要求

- 安全发现写清“谁在什么条件下能访问什么资源”，不写“缺少鉴权”。
- 精简发现写“位置—删什么/换什么—预期净减少的复杂度或代码量”。
- 优化发现必须附证据；没有证据的只标为“可选观察”。
- 测试缺口写具体用例：输入、期望行为、边界或错误路径。
- 不确定的内容标“假设”，不伪装成结论。
