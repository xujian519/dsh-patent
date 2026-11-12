# Agent Note: 把 Office 引擎交付到桌面归档旁边

Status: implemented

[English](2026-09-19-desktop-office-engine-beside-the-archive.md) | 中文

## Problem

打包后的桌面应用无法预览 Office 文档。每次转换都返回 `document-render/failed`、reason 为 `unavailable`，右侧栏据此显示「Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」而同一版本的源码安装能转换同一批文档。

[Office 转换提供方](../../../../packages/document/office-kit/README.zh.md)把渲染委托给 `@deepseek-ai/libreoffice-kit`。它的 `resolveEngine` 与 `engineAsset` 用 `require.resolve('@deepseek-ai/libreoffice-kit-<target>/package.json')` 解析引擎包，并把该包根目录以下的每条路径当作普通文件树。在桌面包中，这个根目录是 `resources/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit-<target>`：

- 对 `app.asar` 内任意路径调用 `stat()` 得到的是 Electron 合成的归档模式，因此 `bin/libreoffice-kit` 读作 `0644`，kit 的可执行检查（`mode & 0o111`）在转换开始前就拒绝该引擎。把文件标记为解包也不能改变这一点：`@electron/asar` 写解包条目时不写 `executable` 头标志，Electron 也不会为归档路径去 stat 解包的孪生文件。
- kit 以 `--program-directory <engine>/program/...` 启动 `bin/libreoffice-kit`。该辅助程序是独立的原生进程，不支持归档，因此归档路径指向一棵它无法打开的 LibreOffice 目录树。

这两点都属于「通过 `app.asar` 寻址文件」的后果，所以只要引擎在归档里，任何解包规则都无法恢复 Office 预览。

## Decision

桌面包把引擎包从两个运行时映射中排除，并把它交付到归档旁边：`resources/node_modules/@deepseek-ai/libreoffice-kit-<target>`。其余每个运行时包仍留在 `app.asar/dsh` 中。

归档内模块的 Node 解析能够到达该目录，因为 `app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js` 的祖先目录链包含 `Contents/Resources/node_modules`。因此 kit 以普通文件方式加载引擎：辅助程序报告真实的 `0755` 模式，其可执行文件路径是真实路径，它读取的 LibreOffice 目录树是真实目录。macOS 签名器忽略这一新位置，因为运行时准备阶段在打包前已为这些文件签名；安装包检查器把打包运行时读作「归档的 `dsh` 树 + `resources/node_modules` 下的包」，因此归档旁边的包仍参与冻结输入比对，其可执行文件仍进入签名复核。

## Alternatives considered

**把整个引擎解包到归档旁边但保留归档内的副本。** 实测否决：归档路径仍报告 `0644`，被启动的辅助程序仍会拿到归档路径作为 `--program-directory`。

**在 kit 内部把归档路径映射到 `app.asar.unpacked`。** 本次改动否决：引擎解析与引擎路径属于 kit 的职责，[kit 归属决策](2026-09-14-independent-libreoffice-kit.zh.md)让引擎修复走它自己的发布周期，桌面侧的修复不能等一次 kit 发布。上面实测到的两条事实正是这类 kit 改动的输入。

**把整个运行时交付到归档旁边（`resources/dsh`）。** 否决：这会让每个运行时文件都退出归档地址空间，对上游包布局的分叉远超那一个真正需要它的包，而归档的完整性检查仍覆盖其余部分。

**在宿主进程里改写解析。** 否决：打补丁 `Module._resolveFilename`、加 `NODE_PATH` 或 shim `fs` 都会让引擎变成进程级接缝里的隐藏例外，而且仍要面对辅助程序的非归档路径契约。

## Consequences

Office 预览在打包应用中可用；源码安装不受影响。

引擎包退出归档的完整性记录。它在 macOS 上仍是已签名的运行时文件，仍在运行时描述符的最终清单里，并由安装包检查器与准备输入比对。

fork 与上游的分叉体现在两处 `files` 过滤器、`resources/node_modules` 映射、macOS 签名器忽略清单，以及两个检查器各自应用的归档旁处理：运行时清单比对与 Windows ASAR 解包检查。引擎的解析走的是从归档向父目录的 Node 遍历，因此未来 Electron 或 Node 若改变归档路径解析，最先失效的会是这一处放置。

## Testing

`npx vitest run apps/desktop/tests/macos-signature.spec.ts apps/desktop/tests/installed-update-package-content.spec.ts` 钉住排除过滤器、资源映射、签名器忽略项，以及「包交付在归档旁边」时的运行时比对，包括字节被改与包缺失两种情况。

`npx vitest run apps/desktop/tests/windows-asar-unpack.spec.ts` 为 Windows PE 文件钉住同一处放置：解包检查接受归档省略、而其准备字节原样位于归档旁的引擎，同时仍然拒绝内联、链接、缺失或字节被改的文件。

一次打包的 macOS arm64 目录构建（未签名，对已准备的目标树执行 `electron-builder --dir`）在 `ELECTRON_RUN_AS_NODE=1` 下通过打包的 kit 转换一个真实 DOCX：引擎解析到 `Contents/Resources/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64`，转换产出的 PDF 与仓库自带引擎完全相同的 355612 字节。改动前的包对同一探针报告 `Installed LibreOfficeKit executable is not executable`。

## Related

- [用独立打包的引擎做 Node Office 转换](../../archived/architecture/2026-09-11-node-office-kit.md)——本次放置所服务的 kit 边界。
- [独立 LibreOffice kit 的归属](2026-09-14-independent-libreoffice-kit.zh.md)——引擎路径处理为何属于 kit。
- [Electron 桌面打包与更新](2026-08-25-electron-desktop-packaging-and-updates.zh.md)——本次改动所扩展的发布布局。
