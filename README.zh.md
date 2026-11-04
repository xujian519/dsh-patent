# DSH Patent

[English](README.md) | 中文

**DSH Patent** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的专利实务分支；后者是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness。本分支保留上游**一切皆插件**的架构，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

上游文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 本分支新增能力

- **专利实务**：交底书分析、现有技术检索、新颖性与创造性分析、权利要求与说明书撰写、审查意见答复、无效宣告与侵权比对。
- **专利工具**：检索、元数据、法律状态、文书渲染、期限与费用，并带交付前的质量门禁。
- **法律域**：法条引用核验、证据评估、案例与法规检索。
- **专利预设**：名为**专利模式**的 Agent 预设，随 Web UI 组合包（bundle）交付。

这些能力都包含在本仓库中；打包与验证状态因功能而异。包的组合方式见[架构文档](docs/architecture.zh.md)。

**输出为起草辅助，不构成正式法律意见。** 参见[安全说明](SAFETY.zh.md)。

## 开发者预览

DSH Patent 沿用上游的 _开发者预览_ 状态，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

<a id="run-from-source"></a>

### 从源码运行

本分支的能力需要从本仓库构建；上游发行包不包含这些能力。需要 Node.js >= 24.9 与 pnpm 11.28.5。

```sh
git clone https://github.com/xujian519/dsh-patent.git
cd dsh-patent
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。该命令默认在 `http://127.0.0.1:3080` 启动 Web UI；本机启动时用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。参见 [Web UI 指南](docs/user/guide/index.zh.md)。

### 运行上游发行包

`npx @deepseek-ai/dsh web` 安装的是上游发行版，不包含本分支的专利或法律能力。

## 快速开始：专利任务

1. 按上述方式从源码启动 Web UI。
2. 打开**设置 → 模型**，填入 [DeepSeek API key](https://platform.deepseek.com/) 并保存。
3. 在同一仓库中打开案卷，按下方「新建案卷」的步骤。
4. 新建任务，在 Agent 预设中选择**专利模式**。
5. 描述任务，例如："读取本工作区的交底书，列出技术问题、发明构思、关键技术特征与技术效果。"

完整的首次上手流程见[专利快速开始](docs/user/guide/patent-quickstart.zh.md)。案卷真源见 [ADR-001](docs/adr/ADR-001-matter-folder-index.zh.md)。

## 新建案卷

一个仓库承载多个案卷。不要为每个案卷另开一个 Cursor 或 git 项目。工作根目录（work root）可配置，典型值是 `/Users/xujian/工作`。

1. 在工作根目录下建立案卷文件夹，例如 `/Users/xujian/工作/<案号>/`，并在其中放入 `_matter-log.md`。不要另建一棵忽略该根目录的 `patent-workspace/<案号>` 树。
2. 把该文件夹扫描进工作台账本，即 `~/.dsh/workbench` 下的 SQLite。账本行只保存元数据与 `workspace_path`。案卷文件正文留在该文件夹，不进云端，也不进 `knowledge.db`。
3. 打开同一仓库并选中该案卷。工作台条目指向该案卷文件夹。
4. 在该文件夹中书写。案卷目录与 `_matter-log.md` 是真源。桥接可以读取投影。把内容写回案卷文件夹不是账本。

## 社区与支持

- 通过本仓库的 [Issues](https://github.com/xujian519/dsh-patent/issues) 报告问题、提出需求。
- 上游 harness 的问题请走[上游 Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)与 [DeepSeek Harness Discord 社区](https://discord.gg/4MrtZUhpxg)。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。

欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
