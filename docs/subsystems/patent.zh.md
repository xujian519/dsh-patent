# 专利（Patent）

[English](patent.md) | 中文

专利子系统是 Sati 专利域的原生移植（[计划](../../docs/sati-as-dsh-plugins-plan.md)）：专利数据访问、knowledge.db 查询、执行管线、纯域引擎、模型可见工具集、合规规则门禁与文书渲染。该能力族位于 [packages/patent](../../packages/patent/README.zh.md)，以 `@deepseek-ai/dsh-patent-*` 包运行，自身不带 Sati 进程与 MCP 桥；部署可在其旁挂载可选的 cnlaw MCP 客户端（[patent preset 声明](../../packages/bundle/web-app/presets/patent.patch.yml)）。

本页记录四个服务接缝（`ctx.patentData`、`ctx.patentKnowledge`、`ctx.patentTeams`、`ctx.patentWorkflow`）与纯库 ModelPort 契约（`@deepseek-ai/dsh-patent-core`）。模型可见工具、规则门禁与文书渲染位于消费包（`dsh-patent-tools`、`dsh-patent-rule`、`dsh-patent-document`、`dsh-patent-filing`、`dsh-patent-deadline`、`dsh-patent-fees`、`dsh-patent-law`、`dsh-tool-literature`、`dsh-methodology`）。专利交付文书只有一个成文通道：由 `dsh-patent-document` 从受控草稿成文，patent preset 不在其旁挂载变量替换的模板包。审查意见答复以 `patent_oa_response_v1` 工作流 manifest 运行——15 个阶段、其中 5 个由模型执行：`dispute-framing → parse → dispute-framing-refine → claim-chart → response-plan → adversary-model → generate_keywords → draft → tighten → slop_gate → adversary-review → response_check → amendment_basis → legal_gaps → approval`——交付门禁要求该次运行的记录存在，OA 答复渲染才被接受。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpatentdata--patentdata"></a>

### `ctx.patentData` — `PatentData`

PatentData service: the patent data seam (ctx.patentData). It exposes the nuo search provider factory and the ego-browser session runner over the injected subprocess service.

```ts cordis-catalog
/**
 * Build a nuo-backed search provider (default: LRU-cached nuo searchPatents).
 * @param options - optional search-function injection.
 * @returns the StageProvider for the workflow atoms' search stage.
 */
createSearchProvider(options?: CreateNuoSearchProviderOptions): StageProvider

/**
 * Build an ego-browser session runner backed by the injected subprocess service.
 * @param options - session options; each one overrides the same-named Config field, and a runner overrides the subprocess-backed default.
 * @returns the ego-browser session.
 */
createEgoSession(options?: EgoSessionOptions): EgoBrowserSession

/**
 * Build a CNIPR channel over an ego-browser session, or nothing when this deployment
 * has not enabled the channel (`Config.cniprEnabled`, default false).
 * @param options - optional per-channel overrides; a channel option replaces the same-named field
 * the service resolved, and a `pageBudgets` entry replaces only that wait.
 * @returns the channel, or undefined while CNIPR is disabled.
 */
createCniprChannel(options: CniprChannelOverrides = {}): CniprChannel | undefined
```

Source: [`packages/patent/patent-data/src/index.ts`](../../packages/patent/patent-data/src/index.ts)

<a id="ctxpatentknowledge--patentknowledge"></a>

### `ctx.patentKnowledge` — `PatentKnowledge`

PatentKnowledge service: the knowledge.db query seam (ctx.patentKnowledge). It lazily opens the resolved knowledge.db read-only and delegates to the ported engines; the engines close when the owning fiber unloads.

```ts cordis-catalog
/**
 * Case-law full-text search over documents/chunks/docs_fts (FTS5 BM25 first,
 * LIKE fallback for short queries or a missing FTS index).
 * @param query - the search text.
 * @param options - result cap and doc_type/court/excludeSource filters.
 * @returns the de-duplicated hits in rank order.
 */
caseLawSearch(query: string, options?: CaseLawSearchOptions): CaseLawHit[]

/**
 * Legal full-text search over the law_article documents of knowledge.db.
 * @param query - the search text.
 * @param options - result cap, level filter, and point-in-time validity (`asOf`, `includeUnverified`).
 * @returns the de-duplicated hits in rank order.
 */
legalSearch(query: string, options?: KnowledgeLawSearchOptions): LawSearchResult[]

/**
 * Guideline full-text search over the guideline_rule documents of knowledge.db
 * (the 《专利审查指南》 chapters). Same engine and options as the law search,
 * scoped to that document type.
 * @param query - the search text.
 * @param options - result cap, level filter, and point-in-time validity (`asOf`, `includeUnverified`).
 * @returns the de-duplicated hits in rank order, each with its `filename` (file_path) for citation.
 */
guidelineSearch(query: string, options?: KnowledgeLawSearchOptions): LawSearchResult[]

/**
 * Keyword lookup over the wiki-card directory (title/concept/domain).
 * @param query - the keyword.
 * @param limit - result cap.
 * @returns matching card metadata.
 */
wikiCards(query: string, limit: number = 10): WikiCardMeta[]

/**
 * IPC classification of a patent-domain text.
 * @param text - the patent-domain text to classify.
 * @returns classification results in confidence order.
 */
ipcClassify(text: string): IpcClassification[]

/**
 * Knowledge-graph keyword search with relation expansion.
 * @param query - the keyword.
 * @param options - keyword/expand limits and phrase-or-OR match mode.
 * @returns keyword hits plus expanded neighbors.
 */
kgSearch(query: string, options?: PatentKgSearchOptions): RelevantHit[]

/**
 * Knowledge-graph node lookup by id.
 * @param id - the node id.
 * @returns the node, or undefined when absent.
 */
kgGetNode(id: string): KgNode | undefined

/**
 * Knowledge-graph nodes by type.
 * @param nodeType - the node type to list.
 * @param limit - result cap.
 * @returns the matching nodes.
 */
kgListByType(nodeType: string, limit: number = 50): KgNode[]

/**
 * IPC examination-standard cards for one section.
 * @param section - the IPC section (A-H).
 * @returns the matching cards.
 */
ipcStandards(section: string): IpcStandardCard[]

/**
 * IPC examination-standard cards for one law article.
 * @param article - the law article id (e.g. patent-law-a22.3).
 * @returns the matching cards.
 */
ipcStandardsByArticle(article: string): IpcStandardCard[]

/**
 * Keyword search over the shipped IPC examination-standard cards.
 * @param keyword - the search keyword.
 * @param limit - result cap.
 * @returns the matching cards.
 */
ipcStandardsSearch(keyword: string, limit: number = 10): IpcStandardCard[]
```

Source: [`packages/patent/patent-knowledge/src/index.ts`](../../packages/patent/patent-knowledge/src/index.ts)

<a id="ctxpatentteams--patentteamsservice"></a>

### `ctx.patentTeams` — `PatentTeamsService`

The durable team capability service.

One captain leads one active team at a time; every mutation runs inside the per-team in-process lock and is persisted atomically before any notification fires. Members are continuable subagents whose durable session ids are recorded in the team file, so a team survives harness restarts.

```ts cordis-catalog
/**
 * Create a team: the calling agent becomes its captain. A captain leads one
 * team at a time.
 * @param agent - the calling agent (the new captain).
 * @param name - team name, sanitized into the stable team id.
 * @param description - team purpose / goal.
 * @returns the created team's id, name, and state directory.
 */
async create(agent: Agent, name: string, description?: string): Promise<{ team_id: string team_name: string state_dir: string }>

/**
 * Add a durable continuable member. By default it snapshots the captain's
 * current LLM route and effort; supply provider/model only for an explicitly
 * requested role-specific route. The route resolution and the child spawn
 * run outside the team lock so one add never stalls the team's other tools;
 * admission and persistence revalidate inside the lock, and a spawn that
 * loses a concurrent race is retired before its failure surfaces.
 * @param agent - the calling captain.
 * @param args - member name, role, optional route/effort.
 * @param signal - caller cancellation, forwarded to the spawn.
 * @returns the created member's identity.
 */
async addMember( agent: Agent, args: AddMemberArgs, signal: AbortSignal, ): Promise<AddMemberResult>

/**
 * Remove a member safely: revoke its current attempts, return all unfinished
 * owned tasks to the shared pending pool, interrupt its live turn, and mark
 * it removed.
 * @param agent - the calling captain.
 * @param name - member name to remove.
 * @param signal - caller cancellation, forwarded to quiescence waits.
 * @returns the removed member and requeued task ids.
 */
async removeMember(agent: Agent, name: string, signal: AbortSignal): Promise<RemoveMemberResult>

/**
 * Create a task in the team's task list. Tasks can depend on other tasks;
 * a task is only claimable once every dependency is completed.
 * @param agent - the calling captain.
 * @param args - subject, description, dependencies, optional assignee.
 * @param signal - caller cancellation, forwarded to scheduling.
 * @returns the created task's identity.
 */
async createTask( agent: Agent, args: CreateTaskArgs, signal?: AbortSignal, ): Promise<CreateTaskResult>

/**
 * Atomically retry, reassign, or let the captain take over any unfinished or
 * failed task. The old attempt is revoked before its member is interrupted,
 * so late updates cannot overwrite the new owner.
 * @param agent - the calling captain.
 * @param args - task id, target assignee ("captain" for takeover), reason.
 * @param signal - caller cancellation, forwarded to quiescence waits.
 * @returns the task's post-handoff state.
 */
async reassignTask( agent: Agent, args: ReassignTaskArgs, signal: AbortSignal, ): Promise<ReassignTaskResult>

/**
 * Claim one ready task for a member (or yourself). A member cannot own a
 * second unfinished task. The returned attempt_id is required for that
 * member's updates and becomes stale after retry/reassignment.
 * @param agent - the calling captain or member.
 * @param args - task id, optional assignee (captain only).
 * @returns the claimed task's capability.
 */
async claimTask( agent: Agent, args: ClaimTaskArgs, ): Promise<ClaimTaskResult>

/**
 * Update a task status/output. Members must supply the current attempt_id
 * returned by claim_task; stale attempts are rejected after takeover or
 * reassignment. Terminal results are immutable.
 * @param agent - the calling captain or member.
 * @param args - task id, status, output, attempt_id.
 * @param signal - caller cancellation, forwarded to scheduling.
 * @returns the task's updated state.
 */
async updateTask( agent: Agent, args: UpdateTaskArgs, signal?: AbortSignal, ): Promise<UpdateTaskResult>

/**
 * Send a message to the captain or to a teammate. Messages go straight into
 * the recipient's mailbox; when the recipient agent is online the service
 * also schedules live delivery.
 * @param agent - the calling captain or member.
 * @param args - recipient ("captain" or a member name), content, optional from.
 * @param signal - caller cancellation, forwarded to live delivery.
 * @returns the message identity and delivery path.
 */
async sendMessage( agent: Agent, args: { to: string; content: string; from?: string }, signal: AbortSignal, ): Promise<{ message_id: string from: string to: string delivered: 'live' | 'wake' | 'mailbox' }>

/**
 * Wait for the team's next committed change: a task transition, a mailbox
 * delivery, a roster change, or a member status edge. The captain leads by
 * waiting on work instead of polling for it. A wait observes announcements
 * only, so durable team state stays authoritative — re-read it after waking.
 * @param agent - the calling captain.
 * @param timeoutMs - bounded wait from {@link TEAM_WAIT_MIN_MS} through {@link TEAM_WAIT_MAX_MS}.
 * @param signal - caller cancellation for this wait only.
 * @returns whether the wait ended by timeout rather than by a change.
 */
async wait(agent: Agent, timeoutMs: number, signal: AbortSignal): Promise<{ timed_out: boolean }>

/**
 * Team snapshot: members with live activity and tasks with status, assignee,
 * dependencies, and output. Captains also see every team mailbox; members
 * see only their own inbox. Reading as captain acknowledges the captain
 * inbox and schedules idle members.
 * @param agent - the calling captain or member.
 * @param signal - caller cancellation, forwarded to scheduling and the team lock.
 * @returns the full team status payload.
 */
async status(agent: Agent, signal?: AbortSignal): Promise<PatentTeamsStatus>

/**
 * End the team: interrupt all members (best effort), archive the team's
 * state directory (team file, tasks, mailboxes) under `archive/`.
 * @param agent - the calling captain.
 * @param signal - caller cancellation, forwarded to quiescence waits.
 * @returns whether the team was archived.
 */
async delete(agent: Agent, signal: AbortSignal): Promise<{ deleted: boolean; team_name: string }>

/**
 * Read this workspace's archived teams: one team's full record in detail,
 * or a summary row per archived team. Archived records are immutable after
 * {@link PatentTeamsService.delete}; this method only reads them.
 * @param agent - any calling agent in the workspace (the archive is workspace-scoped).
 * @param teamId - optional archived team id to show in detail.
 * @returns the archive listing, or the one team's detail record.
 */
async archive(agent: Agent, teamId?: string): Promise<PatentTeamsArchive>
```

Types: [Agent](core.zh.md)

Source: [`packages/patent/patent-teams/src/service.ts`](../../packages/patent/patent-teams/src/service.ts)

<a id="ctxpatentworkflow--patentworkflow"></a>

### `ctx.patentWorkflow` — `PatentWorkflow`

PatentWorkflow service: the patent execution pipeline (ctx.patentWorkflow), which runs workflow manifests, drives the plantask HITL state machine, and holds the case-docket issue schema whose blocking and terminal grades the state machine's transition guards enforce. `Config.maxRounds` bounds the replanning rounds one case may spend. Approval is an optional seam read via ctx.get('approval'); storage-backed file products are caller-provided stores (see the package README). The constructor registers patent-core's built-in atoms only: the six atoms that `@deepseek-ai/dsh-patent-tools` registers (`eligibility`, `spec-check`, `slop-gate`, `draft-specification`, `response-check`, `legal-gaps`) are absent unless that plugin is mounted or the caller injects their contracts and handlers through the run options, and a manifest declaring one of them fails the unknown-atom check before any stage executes.

```ts cordis-catalog
/**
 * Run a workflow manifest via the ported executor. When an agent is given,
 * the run result is appended to its session as a patent/workflow-run event.
 * @param manifest - the workflow to run.
 * @param wctx - the workflow context (caseId/input + stage state).
 * @param executor - fallback stage executor for stages without an atom.
 * @param options - handlers/atoms/provider/persist/approvalGrants/runId.
 * @param agent - optional agent whose session records the run.
 * @returns the run result (also persisted via options.persist when given).
 */
async runWorkflow( manifest: WorkflowManifest, wctx: WorkflowContext, executor?: StageExecutor, options?: WorkflowRunOptions, agent?: PatentAgent, ): Promise<WorkflowRunResult>

/**
 * Drive a plantask plan through planning → awaiting_approval → executing.
 * The awaiting_approval gate resolves through ctx.get('approval'); without an
 * approval service the plan fails closed (replanning with a feedback) rather
 * than auto-approving. Set options.autoApprove to false to leave the plan
 * pending for an out-of-band approve/reject.
 * @param agent - the agent whose session records the patent/plantask events.
 * @param caseId - case identity keying the tracked pending plantask.
 * @param planSteps - the ordered plan steps to sync into tasks.
 * @param options - autoApprove and approvalReason.
 * @returns the final plantask state plus tasks and the approval outcome.
 */
async runPlantask( agent: PatentAgent, caseId: string, planSteps: string[], options?: PlantaskRunOptions, ): Promise<PlantaskRunResult>

/**
 * Decision entry: approve a pending plantask (resume to executing).
 * Single-session single-case semantics: one pending plantask per caseId;
 * concurrent runs of the same caseId are rejected by runPlantask.
 * @param caseId - the case keying the parked plantask.
 * @returns the final plantask state, tasks, and approval outcome.
 */
approve(caseId: string): PlantaskRunResult

/**
 * Decision entry: reject a pending plantask and roll back to replanning.
 * @param caseId - the case keying the parked plantask.
 * @param feedback - optional rejection feedback driving the replanning transition.
 * @returns the final plantask state, tasks, and approval outcome.
 */
reject(caseId: string, feedback?: string): PlantaskRunResult
```

Source: [`packages/patent/patent-workflow/src/index.ts`](../../packages/patent/patent-workflow/src/index.ts)

<a id="ctxwritingpatterns--writingpatternsservice"></a>

### `ctx.writingPatterns` — `WritingPatternsService`

The writing-pattern capability seam: the patterns each workflow stage declared in `stagePatterns`, resolved against the loaded corpus at plugin load. An atom reads its stage's patterns here instead of reaching into the store, so the deployment's stage policy stays in `cordis.yml`.

```ts cordis-catalog
/**
 * The patterns one workflow stage declared, in declaration order.
 * @param stageId - the workflow stage id.
 * @returns the stage's patterns.
 * @throws WritingPatternError when the deployment declared no patterns for the stage.
 */
patternsForStage(stageId: string): readonly WritingPattern[]

/**
 * The `<writing_skills>` block of one workflow stage's declared patterns.
 * @param stageId - the workflow stage id.
 * @returns the compiled block.
 * @throws WritingPatternError when the deployment declared no patterns for the stage.
 */
compiledForStage(stageId: string): string

/**
 * Stage ids the deployment declared, in configuration order.
 * @returns the declared stage ids.
 */
stageIds(): readonly string[]
```

Source: [`packages/patent/writing-patterns/src/index.ts`](../../packages/patent/writing-patterns/src/index.ts)
<!-- END GENERATED cordis-surface -->

## ModelPort 契约

`@deepseek-ai/dsh-patent-core` 是纯 TypeScript 库（无 `ctx` 依赖），承载自 Sati 移植的专利域引擎：atoms `StageProvider`/`StageHandler` 词汇、claim-chart 引擎、宪法规则引擎协议类型与文本工具、以及 IPC 分类器/审查标准查表。其定稿的 ModelPort 契约是 canonical LLM 调用词汇：

```ts type-equiv
/**
 * The patent-domain LLM port: an async iterable of canonical events for one request.
 * Implementations adapt the harness LlmRuntime.stream vocabulary (P2.1).
 */
interface PatentModelPort {
  stream(request: PatentModelRequest, signal?: AbortSignal): AsyncIterable<PatentModelEvent>
  /**
   * Fixed provider route this port sends on. A model-call log records it as the
   * call's envelope, so "which provider/model produced this stage output" is
   * answerable without the port's creator; a fail-loud or injected test port has
   * no route and logs none.
   */
  route?: { provider: string; model: string }
  /**
   * Rebind this port to one session identity, so every request it serves carries
   * `sessionId` on the harness call. A call a plugin makes outside the agent loop
   * is otherwise unattributable, and the keyless replay (which keys recorded
   * scripts by session) cannot re-serve it. Absent on injected test ports, whose
   * calls never need to bind to a recorded script.
   * @param sessionId - the session whose log records the calls.
   * @returns a port serving the same route under that session identity.
   */
  bindSession?(sessionId: NonNullable<GenerateOptions['sessionId']>): PatentModelPort
}
```

P2.1 适配器 `createLlmModelPort(stream, { provider, model })` 将 dsh `LlmRuntime.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` 词汇映射为 `PatentModelRequest`/`PatentModelEvent` canonical 形态，`collectPortText` 再把端口桥接回依赖 LLM 的 atoms 所用的字符串；provider 选择保留在 harness `ctx.llm` 适配器与 `agent/request` 瀑布（Sati router 不移植）。工具在函数体内调用模型时，先用 `bindSession(agent.session.id)` 绑定端口，调用才带会话身份，`patent/model-call` 才能记录它（见 [patent-workflow](../../packages/patent/patent-workflow/README.zh.md)）。
