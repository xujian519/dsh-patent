---
kind: upgrade-guide
description: "专利文书与成文工具现在拒绝真实位置落在进程工作目录之外的显式输出目录或品牌配置路径。"
---

# 专利工具拒绝工作目录之外的路径

[English](guide.md) | 中文

## 变更

`render_patent_document` 接受 `outputDir` 与 `brandPath`，`build_patent_filing` 接受 `outputDir`。此前两个工具会写入或读取调用方给出的任意绝对路径；现在路径先按进程工作目录解析，再按真实位置比较：`..` 串联、指向别处的绝对路径、以及指向根外的 symlink 都会在读写之前失败。

迁移时需要注意两点：

- 工作目录之内的绝对路径照常可用，相对路径也照常可用。
- 比较会归一化 symlink，因此 macOS 的 `/var` → `/private/var` 别名不会误拒真实位于工作目录下的目录。

受影响的对象：把路径指到其他根目录下的模型或脚本，例如 `outputDir: "~/Desktop/deliver"`，或放在用户配置目录里的品牌主题。这类调用现在以 `输出目录 越出工作目录: …`（`brandPath` 为 `品牌配置路径 越出工作目录: …`）失败；工具结果携带该消息，且不产生任何文件。

## 迁移

1. 把目标目录移到工作目录内并以相对路径传入，例如把 `outputDir: "/Users/me/Desktop/deliver"` 改为 `outputDir: "deliver"`。
2. 品牌主题放在别处时，把 `theme.json` 复制进工作目录（例如 `brand/theme.json`），再用该相对路径作为 `brandPath`。
3. 要保留原有目标位置，就用该目录作为会话的工作目录启动；同一绝对路径在目录之内即可通过。
4. 重新执行该工具调用，确认结果给出写出的路径。被拒时消息格式固定；同样调用再次失败说明路径真实位置仍落入工作目录之外（可对目标执行 `realpath` 核实）。
