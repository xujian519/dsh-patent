# 升级指南目录对齐说明（文档草稿）

> 状态：**已决**（用户 2026-11-09 拍板）。核对日：2026-11-09。

## 决定

| 项 | 决定 |
|---|---|
| live-approval 正文 | **保持**在 `docs/upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/`（表示「自该版本引入的行为」） |
| `v0.2.2-rc.1/patent-stage-gate-live-approval/` | **只保留指针**到 alpha.3 正文；**不搬家、不复制**正文 |
| quickstart 外链 | 继续指向 `alpha.3` 路径 |
| workbench 发行说明版本号 | **1.18.0**（见 sibling 草稿 `dsh-patent-workbench/docs/releases/v1.18.0.md`） |

## 现状（代码 / 目录）

| 项 | 值 |
|---|---|
| 根包 `package.json` version | `0.2.2-rc.1` |
| 已存在的 rc.1 指南（有正文） | `docs/upgrade-guide/v0.2.2-rc.1/claim-chart-unreadable-source/` |
| live-approval 指南权威路径 | `docs/upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/` |
| live-approval rc.1 入口 | 指针草稿 → 指向上述 alpha.3 |
| quickstart 草稿外链 | 指向上述 `alpha.3` 路径 |

## 曾列选项（归档）

1. ~~保持不动~~ → **已采纳（正文不迁）**；另在 rc.1 下保留指针入口（见上表）。
2. 复制或搬家到 `v0.2.2-rc.1/patent-stage-gate-live-approval/` — **未采纳**。
3. 只加 rc.1 索引 README — **未单独采用**；以专题目录下的指针文件代替。
