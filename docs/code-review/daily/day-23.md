# Day 23 — 2026-12-07

## 今日维度与范围

- 维度：C 优化
- 范围：文档模式：office-kit、docx-kit、doc-template、document-deliver
- 时间盒：90 分钟
- 预期产出：C 维度文档域候选发现；daily/day-23.md

## 检查项

- [x] 检查 LibreOffice 进程复用与队列。
- [x] 检查临时目录与缓存。
- [x] 检查大文件读写。
- [x] 检查输出复制。
- [x] 附证据。

## 实际执行

**基线（10 分钟）**：测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。不启动 LibreOffice，不打模型，不打网络。命令是 `node --import tsx/esm` 导入这四个包的 `src`，退出码 0。脚本是一次性的，跑完即删。夹具在临时目录，进程结束时删掉。`pnpm exec vitest run packages/document/office-kit/tests/queue.spec.ts packages/document/office-kit/tests/scratch.spec.ts packages/document/office-kit/tests/output.spec.ts` 退出码 0，3 个文件 37 个用例，589ms。没有跑 `operations.spec.ts` 和 `provider.spec.ts`。

**进程与队列（25 分钟）**：并发默认 2，排队 8，读者 32，后台转换 1（`office-kit/src/index.ts:92`–`:96`）。同一内容摘要在 `queue.ts:269` 命中缓存后不再转换；进行中的同摘要会把读者并到已有任务（`:275`）。`drain`（`:232`）只在 `running < maxConcurrentConversions` 时开工。转换器对象按槽复用：`runOperation`（`index.ts:385`）找到空闲槽就留下 `slot.converter`，下次接着用。每次转换仍新建一次引擎调用。依赖 `@deepseek-ai/libreoffice-kit` 的版本是 `0.2.3`（`office-kit/package.json:64`）。读已安装的包：每次转换 `new Worker`，`finally` 里 `worker.terminate()`；native helper 每次 `spawn`，取消监听里 `SIGKILL`，并等到子进程 `close`。超时用 `setTimeout`，`finally` 里 `clearTimeout`。一个转换器内部同时只跑一次（`running` 标志）。提供者卸载时 abort 远程生命周期，`queue.dispose()` 之后对每个槽 `converter.dispose()`（`index.ts:173`–`:184`）。队列测试用假转换器覆盖了最后一名读者取消、容量保持到引擎结算、以及 dispose 与调用方取消分开。这些测试不启动引擎。

**临时目录与缓存（20 分钟）**：`office-kit` 每次转换 `mkdtemp` 出一个 `dsh-office-kit-` 目录（`index.ts:399`），输入以 `wx` 和 `0o600` 写入（`:401`）。成功、失败和取消都走进 `:417` 的 `finally`，递归删除该目录；删除失败只记警告。启动清扫是 `sweepScratchDirectories`（`scratch.ts:17`），名字必须匹配 `scratch.ts:7` 的六位后缀，并且早于 `max(timeoutMs * 2, 120000)`。默认超时 60000ms（`index.ts:103`）。已安装的 kit 另有自己的 `libreoffice-kit-` 与 `libreoffice-kit-images-` 目录，在它自己的 `finally` 里删除。用私有目录放了 40 个符合清扫名字的目录、40 个 kit 前缀目录和 40 个普通文件，年龄阈值取负数以便刚创建的目录也超过截止。清扫 3.39ms，警告 0。符合名字的目录剩 0，kit 前缀剩 40，普通文件剩 40。缓存上限 8 条、134217728 字节（`index.ts:97`–`:98`）。超过单条上限的输出不进入缓存（`queue.ts:307`）。输出仓库默认保留 24 小时，预算 536870912 字节（`index.ts:101`–`:102`），保存串行（`outputs.ts:87`）。

**大文件与输出复制（25 分钟）**：输入上限 52428800 字节，单次输出上限 104857600 字节（`index.ts:104`–`:105`）。`readOutput`（`output.ts:16`）按文件大小加 1 分配缓冲区，读完再切到实际长度。`copyOutput`（`queue.ts:88`）对每个读者 `Uint8Array.from` 一份独立字节。DOCX 限额是 10000 个条目、262144000 未压缩字节（`docx-kit/src/types.ts:131`–`:133`）。`document_deliver` 的读取上限是 4194304 字节（`document-deliver/src/tool.ts:68`）。模板在 `TemplateStore` 构造时读目录一次（`doc-template/src/store.ts:136`–`:137`）。下表的大文件读取发生在刚写完的页缓存上。多样正文每节用不同的词，重复字那一行整节是同一个字，压缩后的包体因此很小。

| 路径 | 规模 | 中位数或单次 | 样本 |
|---|---|---|---|
| `renderDocx` 多样正文 | 40437 字，DOCX 15357 字节 | 2.78ms 单次 | 1 |
| `extractDocxText` 多样正文 | 同上 | 1.47ms 单次 | 1 |
| `renderDocx` 多样正文偏大 | 404698 字，DOCX 124454 字节 | 22.09ms 单次 | 1 |
| `extractDocxText` 偏大 | 同上 | 4.65ms 单次 | 1 |
| `renderDocx` 重复字 | 404698 字，DOCX 4582 字节 | 19.97ms | 3 |
| `checkDocumentText` | 3218392 字 | 17.31ms | 3 |
| `loadTemplateDirectory` | 17 个模板 | 6.82ms | 5 |
| `readOutput` | 20971520 / 83886080 字节 | 1.89ms / 8.65ms | 各 5 |
| `Uint8Array.from` | 20971520 / 83886080 字节 | 0.89ms / 4.88ms | 各 5 |
| `OutputStore.save` | 8388608 字节 | 3.95ms | 3 |

## 发现

无。

下面几条不够格单列，只作可选观察：

1. 转换器对象和字体缓存复用，每次转换仍新建 Worker；native 路径再 `spawn` 一个 helper。默认同时 2 个转换。真实引擎的启动时间没有测。
2. 每个读者拿到一份输出拷贝。83886080 字节的 `Uint8Array.from` 中位数 4.88ms。缓存单条不超过 134217728 字节。
3. 启动清扫只删 `dsh-office-kit-` 目录。同一夹具里 40 个 `libreoffice-kit-` 目录原样留下。取消和异常会在 kit 的 `finally` 里删掉它们；进程崩溃跳过 `finally` 时，这个前缀要等操作系统清理临时目录。
4. `checkDocumentText` 对约 3.2MB 正文做多遍扫描，中位数 17.31ms，低于 4194304 字节的读取上限。
5. 17 个模板在构造 `TemplateStore` 时一次读完，中位数 6.82ms。渲染路径不再读这批文件。

## 假设验证/推翻

H03 改为「取消与异常路径未发现泄漏」。调用方取消会中止本次转换；`office-kit` 在 `finally` 删除自己的临时目录；已安装的 kit 0.2.3 对本次 helper 发 `SIGKILL` 并 `terminate` Worker，自己的临时目录也在 `finally` 删除。没有启动真实引擎。崩溃后留下的 kit 前缀目录见上面第 3 条，不单列发现。H01、H02、H04–H10 与今日热路径无交集，状态不改。

## 未决问题

1. 没有调用 `createConverter`。Worker 启动、字体扫描和真实转换的墙钟未测。
2. 多样正文的渲染和抽取各只有 1 次。同长度重复字的渲染中位数是 19.97ms，包体因为压缩只有 4582 字节。
3. 83886080 字节的读取是温热页缓存。冷盘未测。

## 明日第一件事

Day 24（C 优化：`legal-knowledge`、`legal-law`、`legal-evidence`、`law-core`、`knowledge-core`）第一件事：读共享全文阶梯在法律域的代价。Day 21 的判例零命中留在判例引擎，今天不重测。先看法律域有没有循环里的查询和整表扫描。
