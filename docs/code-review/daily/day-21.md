# Day 21 — 2026-12-05

## 今日维度与范围

- 维度：C 优化
- 范围：专利域-2：patent-knowledge、patent-data
- 时间盒：90 分钟
- 预期产出：C 维度专利域候选发现；daily/day-21.md

## 检查项

- [x] 检查 SQLite 查询计划与缺失索引。
- [x] 检查串行队列与缓存策略。
- [x] 检查 provider 重试与超时。
- [x] 检查文件扫描与全文搜索。
- [x] 附慢查询或循环内调用的证据。

## 实际执行

**基线（10 分钟）**：测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。不打检索网络，不打模型，不写知识库。`resolveKnowledgePaths` 的候选顺序是数据目录里的 `knowledge.db`、`knowledge-lite.db`，然后才是 `~/.sati/knowledge/knowledge.db`。本机没有前一个文件，查询库是 `~/.dsh/knowledge/knowledge-lite.db`（3543654400 字节，`user_version` 1）。源库同样没有 `search_prefix`。命令是 `node --import tsx/esm` 导入这两包的 `src`，退出码 0。脚本是一次性的，跑完即删。

**缓存与串行队列（15 分钟）**：`pnpm exec vitest run packages/patent/patent-data/tests/patent-cache.spec.ts` 退出码 0，1 个文件 21 个用例，719ms。同一次命令还写了一个不存在的 `serial-queue.spec.ts`，vitest 没有跑到第二个文件。墙钟用假加载器：每次未命中空转 8ms，不访问网络。20 个不同键各加载一次，中位数 8ms。同一键再调用 40 次，加载次数仍是 1，中位数 0ms（最大 0.01ms）。三个并发调用同一个键，加载次数是 1。空结果和「检索失败」警告不入缓存，第二次仍会加载。TTL 40ms 的条目过期后会重新加载。`SerialQueue` 把三段 15ms 的任务排成 `abc`，墙钟 48.22ms。

**查询计划与索引（20 分钟）**：只读打开查询库。`documents` 81551 行（2.24ms），`chunks` 144188 行（4.49ms），`kg_nodes` 214824 行（0.54ms），`kg_edges` 233891 行（2.72ms）。`docs_fts` 与 `kg_nodes_fts` 都是 FTS5 trigram、contentless。`docs_fts` 144079 行，比 `chunks` 少 109 行。热路径索引在库里，不在本仓库的 `CREATE INDEX` 语句里：`idx_chunks_document (document_id, chunk_index)`，`kg_edges` 的 `source_id` / `target_id` / `relation` 复合索引，`kg_nodes(node_type)`。EXPLAIN：FTS 是虚拟表 MATCH，再按 `chunks` 主键和 `documents` 主键查找，`ORDER BY bm25` 用临时 B 树；回源查找走 `idx_chunks_document` 覆盖索引；邻居查找走 `idx_kg_edges_src_tgt_rel` 覆盖索引。这些语句没有 `SCAN`。

**全文与文件扫描（35 分钟）**：下表是热调用。判例与法规检索词是「创造性」，默认条数 5。图谱是 `PatentKgAdapter.searchRelevant('创造性')`。Wiki 目录有 1235 个 Markdown、87 个子目录；`.wiki-meta.json` 已存在（552758 字节），加载器没有重写它。全目录 `readdir` 是另一次只读遍历。

| 路径 | 结果 | 中位数或单次 | 样本 |
|---|---|---|---|
| 判例 FTS，无过滤 | 5 条，片段 782 字 | 75.15ms | 8 |
| 判例 FTS，`docType=case` | 5 条 | 78.81ms | 8 |
| 法规 FTS，无过滤 | 5 条 | 52.73ms | 8 |
| 法规 FTS，`level=审查指南` | 0 条 | 51.73ms | 8 |
| 原始 `ORDER BY bm25`，LIMIT 25 | 25 行 | 72.07ms（首次 326.75ms，其后 71ms 一带） | 8 |
| 原始 `ORDER BY rank`，LIMIT 25 | 25 行 | 单次 42.41ms | 1 |
| 过滤 SQL 的 `prepare` | 不执行 | 0.01ms | 30 |
| `stmtGetChunkAt` | 覆盖索引 | 0ms（最大 0.03ms） | 20 |
| `searchRelevant` | 7 条；暖调用 30 次 `getNeighbors`、7 次 `getNode` | 首次 6.12ms，其后 0.20–0.27ms | 1 + 5 |
| Wiki 全目录遍历 / 缓存加载 / 再加载 / `search('创造性')` | 1235 张；搜索 10 条 | 12.15ms / 26.45ms / 0ms / 0.31ms | 各 1 |
| 判例「专利」（2 字，标题很快凑满） | 5 条，`via=like` | 0.72ms，再来一次 0.15ms | 2 |
| 判例「锆钚」（2 字，零命中） | 0 条 | 4772.49ms | 1 |
| 判例「锆钚钨」（3 字，FTS 未命中后再 LIKE） | 0 条 | 4569.07ms | 1 |
| 法规「锆钚」（2 字，零命中） | 0 条 | 4.18ms | 1 |

LIKE 的 EXPLAIN 是 `SCAN documents`，再用 `idx_chunks_document` 取每篇最长 chunk，并对正文调用 `sati_uncompress`。这条计划是在原始连接上注册了一个不执行解压的同名函数之后取的；上表的秒级数字来自引擎自己的解压函数。`documents` 没有 `search_prefix`。`install` 的 `searchPrefix` 默认是 false，命令行要显式加 `--search-prefix` 才会写这一列，并会把召回限制在每篇最长 chunk 的前 512 个码点。

**重试与超时（10 分钟）**：`createNuoSearchProvider` 不重试，只调用已经包过缓存的检索。有界重试在 `patent-tools` 的 `retryBounded`（Day 20 已数过：默认再等 400ms 和 1200ms）。等待用的是普通 `setTimeout`，等待期间取消不会打断这次等待，等待结束后仍会再发一次。超时在 `subprocess-runner.ts`：到期就 abort，3 秒宽限后由子进程缝杀掉进程树；调用方的 signal 走同一条 abort。`EgoBrowserSession` 默认单次 90 秒，上限 300 秒，探活 8 秒。CNIPR 通道在串行队列拿到槽位后先 `throwIfAborted`，脚本 `timedOut` 映射成 `CniprChannelError('timeout')`。今日没有重跑 `subprocess-runner.spec.ts` 和 `cnipr-channel.spec.ts`，也没有启动 ego-browser。

代码注释里的两组旧数字今日没有复现：UDF 单行 4.18ms，以及 JOIN 上 `ORDER BY rank` 354ms 对 `bm25` 0.12ms。今日 rank 单次比 bm25 中位数还短。SQL 保持 `bm25`。

## 发现

[F-PAT-032](../05-findings.md)。判例检索在 FTS 未命中，或查询不足 3 个字又不能从标题里很快凑满条数时，走整表 `sati_uncompress` LIKE。本机查询库上零命中是 4.57 秒和 4.77 秒。

下面几条不够格单列，只作可选观察：

1. 过滤条件每次 `prepare` 的中位数是 0.01ms，过滤后的 FTS（78.81ms）和无过滤（75.15ms）在同一档。
2. `backfillContent` 对每条命中各查一次，默认 5 次；单次走覆盖索引，最大 0.03ms。
3. `searchRelevant` 对每个关键词命中按 2 种相似关系和 4 种引用关系各查邻居。暖调用 30 次邻居查询加在一起是 0.2ms。
4. Wiki 即使不用扫描缓存，目录遍历也是 12.15ms。缓存冷加载 26.45ms。
5. 检索缓存会省掉 10 分钟内、最多 100 条的重复成功查询。未命中的远端往返没有测量。

## 假设验证/推翻

H01–H10 没有一条把验证点放在今日这两包的热路径上，状态不改。H03 的 Office 子进程仍留给 Day 23。

## 未决问题

1. 两字查询只测了两端：标题立刻凑满 5 条是 0.72ms，整表零命中是 4772.49ms。标题不中、正文靠后才中的耗时没有中间样本。
2. `docs_fts` 比 `chunks` 少 109 行。这 109 行里有没有「LIKE 能中、FTS 不能中」的正文，没有逐行核对。
3. 检索网络和 PDF 下载的往返仍未测量。缓存只覆盖重复的成功结果。

## 明日第一件事

Day 22（C 优化：`patent-workflow`、`patent-teams`）第一件事：读这两个包的队列、轮询和重复打开。它们的源码没有直接调用今日这条判例检索。先找循环里的外部调用，以及取消之后仍会等待的间隔。
