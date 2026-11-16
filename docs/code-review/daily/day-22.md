# Day 22 — 2026-12-06

## 今日维度与范围

- 维度：C 优化
- 范围：专利域-3：patent-workflow、patent-teams
- 时间盒：90 分钟
- 预期产出：C 维度专利域候选发现；daily/day-22.md

## 检查项

- [x] 检查状态持久化的频率与批量写。
- [x] 检查调度轮询与唤醒机制。
- [x] 检查任务板查询。
- [x] 检查日志与遥测开销。
- [x] 附证据。

## 实际执行

**基线（10 分钟）**：测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。不打模型，不打网络，不写用户目录。命令是 `node --import tsx/esm` 导入这两个包的 `src`，退出码 0。脚本是一次性的，跑完即删。夹具在临时目录，进程结束时删掉。两个包的 `src` 不导入 `patent-data`、`patent-knowledge`、`patent-document`、`libreoffice-kit` 或 `node:child_process`，也没有 `setInterval`。`setTimeout` 只有团队等待和重命名重试两处。

**持久化频率（25 分钟）**：工作流主循环在 `workflow.ts:481`，并行窗口默认 4（`:110`）。阶段重试在 `executor.ts:123`，清单里的 `maxRetries` 是 1 或 2；取消在 `:160` 直接抛出，不再试一次。回退记录上限 `MAX_REVISIONS` 为 64（`workflow.ts:155`）。整次运行只在 `workflow.ts:539` 调用一次 `saveRun`，失败写成 `persistWarning`，不把运行判失败。文件后端在 `workflow-store.ts:269`，内存后端在 `:237`。`JsonFileStore.save`（`persist-utils.ts:141`）把整份结果 `JSON.stringify(value, null, 2)` 后交给 `writeFileAtomic`（`packages/util/atomic-write/src/index.ts:85`），临时文件先 fsync 再改名。`flexible-plan-store.ts:45` 同样是一次 `store.save`。`patent-flexible-plan.ts` 的三个调用点（`:407`、`:422`、`:464`）各写一次；`:460` 的确认循环改的是内存，循环结束后才写。团队侧每次变更都整文件重写：`writeTeam`（`state.ts:194`）和建队（`:152`）都是整份 `team.json` 的缩进 JSON，经 `atomicWriteText`（`team-lock.ts:223`）独占创建后改名，这条路径不调用 `syncFileDurably`。邮箱追加是 `O_APPEND`（`mailbox.ts:50`）；确认已读走 `mutateMailbox`（`:185`），读完全文再整文件重写。

下表是温热页缓存上的重复样本。团队「普通」是 4 名成员、20 项任务、其中 4 项带 1000 字输出。团队「偏大」是 6 名成员、100 项任务、其中 20 项带 20000 字输出。运行结果是 8 个阶段。

| 路径 | 规模 | 中位数 | 范围 | 样本 |
|---|---|---|---|---|
| `writeTeam` 普通 | 9352 字节 | 0.21ms | 0.19–0.27ms | 5 |
| `readTeam` 普通 | 同上 | 0.11ms | 0.09–0.59ms | 5 |
| `writeTeam` 偏大 | 423925 字节 | 0.47ms | 0.46–0.50ms | 5 |
| `readTeam` 偏大 | 同上 | 0.33ms | 0.30–0.34ms | 5 |
| `saveRun` 文件，普通 | 321397 字节 | 8.89ms | 7.97–9.87ms | 5 |
| `loadRun` 普通 | 同上 | 0.20ms | 0.19–0.45ms | 5 |
| `saveRun` 内存克隆，普通 | 同一对象 | 0.02ms | 0.02–0.07ms | 5 |
| `saveRun` 文件，偏大 | 1601397 字节 | 11.01ms | 10.87–11.06ms | 5 |
| `loadRun` 偏大 | 同上 | 1.35ms | 1.27–1.92ms | 5 |

**调度与唤醒（20 分钟）**：没有轮询循环。`kickTeam`（`scheduler.ts:341`）按成员串行调用 `kickMember`。每次踢人先读该成员未读邮箱（`:198`），邮箱为空才返回；空闲且没有可派任务的提前返回在 `:375`，位于这次读盘之后。状态监听有 `memberIndex`（`:338`），未知代理扫描一次目录后缓存，队长和外部代理缓存成空。工具路径不走这张表：`participantTeam`（`team-access.ts:185`）每次都 `findTeamByParticipant`（`state.ts:297`），而那个函数串行读状态根下每个团队目录。状态根是 `<workspace>/.patent-teams`（`index.ts:87`）。一个目录的查找中位数 0.10ms（0.09–0.22ms，5 次），八个目录 0.47ms（0.44–0.55ms，5 次）。`patent_teams_wait` 由 `TeamActivity.notify` 唤醒（`team-activity.ts:94`）。默认等待 30000ms，允许 10000–3600000ms。取消会清掉计时器：注入 abort 后 0.43ms 以 `AbortError` 结束，没有等到 30 秒。`notify` 后 0.05ms 返回，`timedOut` 为 false。重命名重试的 `sleep`（`team-lock.ts:139`）不接收取消信号，只在 `EPERM` / `EACCES` / `EBUSY` / `EEXIST` / `ENOTEMPTY` 上等待，最多 3 次、每次 50ms（`:122`–`:124`）。注入两次 `EPERM` 后第三次成功是 101.49ms；直接改名成功是 0.08ms。

**任务板（20 分钟）**：专利团队的任务板是 `team.json` 加每人一个 JSONL 邮箱，投影在 `status-view.ts` 的 `buildTeamStatus`。它不是实验包里的 TeamTaskBoard，也不是 Web 的 TeamBoard。队长状态先 `kickTeam`（`:62`），再在团队锁里重读团队文件（`:64`），然后 `memberActivity`（`members.ts:612`）列出队长的全部子代理。任务投影带上每项 `task.output`（`status-view.ts:92`）。队长对自己的收件箱只取最后 10 条，对每个可见成员再读一遍整份邮箱，预览最后一条的前 200 字（`:134`–`:151`）。有未确认消息时，`acknowledgeMailbox` 重写整份 JSONL（`:191`）。成员一次只看 10 条并只确认这一页。`roleContract`（`role-contracts.ts:182`）每次查找都重建内存里的 14 条角色表；8 次查找的中位数是 0ms，最大 0.18ms。邮箱夹具是 400 条、每条 800 字。队长邮箱写完时 346984 字节。400 次追加共 42.30ms，平均 0.11ms。整文件读取中位数 0.37ms（0.36–0.58ms）。确认其中 10 条的整文件重写中位数 0.69ms（0.58–1.10ms）。其后单次追加仍是 0.11ms。一次「查找该队 + 读队长邮箱 + 读 6 个成员邮箱 + 确认 10 条」的中位数是 3.12ms（2.91–3.33ms）。这次没有把 `kickTeam` 里每位成员再读一次未读邮箱算进去；那一次未读读取的中位数是 0.34ms。两边相加约 5.2ms，是两次测量相加，不是同一次调用。`memberActivity` 需要活的代理注册表，没有计时。

**日志与遥测（15 分钟）**：`loggedPatentModel` 在流式过程中把增量拼进 `output`（`model-call-log.ts:56`），流结束后再 `session.append('patent/model-call', …)`（`:60`）。流中途失败不写记录。`appendWorkflowRunEvents`（`index.ts:109`）把整份运行结果放进 `patent/workflow-run`；若有 `legal-gaps` 阶段，该阶段输出再写一条 `patent/legal-gaps`。本地只测了拼接和序列化：2000 段 500 字拼成 100 万字，加上这条模型事件和一份 8 阶段运行结果的 `JSON.stringify`，中位数 1.37ms（1.29–2.10ms，5 次）。没有调用 `session.append`，没有模型往返。

## 发现

无。

下面几条不够格单列，只作可选观察：

1. 团队每次变更都重写整份缩进的 `team.json`。偏大夹具 423925 字节，写入中位数 0.47ms。这条写不 fsync。带 fsync 的是运行结果：1601397 字节一次 `saveRun` 中位数 11.01ms，同对象的内存克隆是 0.02ms。工作流已经把阶段结果攒到结束才写一次。
2. 工具每次按人找团队都会串行读 `<workspace>/.patent-teams` 下的每个团队目录。一个目录 0.10ms，八个目录 0.47ms。调度器的状态监听有 `memberIndex`，工具路径没有。
3. 队长状态对每个可见成员读完整份邮箱，确认 10 条时重写整份 JSONL。400 条、约 347KB 的确认中位数 0.69ms。追加仍是单行 `O_APPEND`，0.11ms。
4. 同一次阶段正文会进 `patent/model-call` 的 `output`，结束时再进 `patent/workflow-run` 的 `stages`。本地 100 万字拼接加两份序列化是 1.37ms。这是会话回放要的记录。
5. 重命名遇到 Windows 锁冲突时，50ms 的等待最多 3 次，且不看取消信号。注入两次 `EPERM` 是 101.49ms。直接改名成功是 0.08ms。团队等待本身在取消后 0.43ms 结束。

## 假设验证/推翻

H01–H10 没有一条把验证点放在今日这两包的热路径上，状态不改。H03 的 Office 子进程与临时文件仍留给 Day 23。

## 未决问题

1. `memberActivity` 每次状态都调用 `ctx.subagents.listDescendants`。没有在带代理注册表的进程里计时，3.12ms 不含这一步。
2. 上表是合成夹具、温热页缓存。真实长案的 `team.json` 和邮箱有多大，没有打开过用户目录。
3. `session.append` 的落盘和回放体积没有测。模型与网络未计入。

## 明日第一件事

Day 23（C 优化：`office-kit`、`docx-kit`、`doc-template`、`document-deliver`）第一件事：读 Office 转换的队列、临时目录和取消路径。今日这两个包不调用文档包。H03 留在这一天。先看转换是否在循环里重复拉起进程，以及取消之后临时目录和子进程是否还在。
