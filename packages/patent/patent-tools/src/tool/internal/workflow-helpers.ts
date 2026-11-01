/**
 * Shared workflow assembly for the ported patent workflow tools: case
 * persistence-path resolution, atomic artifact writes, workflow-result text
 * assembly, the workflow-run context mapping, and StageProvider assembly from an
 * injected model port + search function. Shared by `patent_workflow`,
 * `patent_workflow_run` and `flexible_plan` so the three do not drift.
 *
 * Rule-gate note: Sati's `runRuleGate` helper (RuleEngine + defaultPatentRules)
 * is deliberately NOT ported. The dsh rule engine lives in
 * `@deepseek-ai/dsh-patent-rule`, which carries deterministic compliance
 * through its three gates: the output gate (tool results, post-execute), the
 * artifact structural gate (declared tool-call arguments, pre-execute), and the
 * delivery gate (`rule_check` + `law_verify` before render). The workflow tools
 * render an empty `checkSection`; the carrier stays for the ported text
 * contract. See
 * `.agents/notes/implemented/architecture/2026-09-28-patent-output-gating-runs-on-the-rule-gate.md`
 * and
 * `.agents/notes/implemented/architecture/2026-10-03-patent-delivery-gate-enforces-gate-runs.md`.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/workflow-helpers
 */

import { rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import {
  caseWorkflowRunsDir,
  collectPortText,
  dataBlock,
  getStateString,
  parseConsumeRef,
  type AtomRegistry,
  type PatentModelPort,
  type PipelineState,
  type StageExecutor,
  type StageHandlerRegistry,
  type StageProvider,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowRunResult,
  type WorkflowStage,
  type WorkflowStageResult,
} from '@deepseek-ai/dsh-patent-core'
import { JsonFileWorkflowRunStore, runWorkflow, workflowManifestToMermaid } from '@deepseek-ai/dsh-patent-workflow'
import { createNuoSearchProvider } from '@deepseek-ai/dsh-patent-data'
import { PatentToolError } from '../../error.ts'
import { projectConsumedOutput } from './consume-projections.ts'

/** Stage-output preview limit for stages the caller's executor produced. */
const EXECUTOR_OUTPUT_PREVIEW_LIMIT = 80

/**
 * Stage-output preview limit for atom stages. Parsed documents and coverage
 * verdicts are compact (kilobytes at most), but the limit still bounds a run's
 * model-visible text when an atom emits a large chart or search result.
 */
const ATOM_OUTPUT_PREVIEW_LIMIT = 2000

/**
 * Prompt cap for one consumed upstream stage output. Stage outputs are model
 * text of unbounded length; a chain of consuming stages would otherwise carry
 * every earlier stage's full text.
 */
const CONSUMED_OUTPUT_LIMIT = 4000

/** Prompt cap for the workflow material and the separately supplied claims. */
const MATERIAL_PROMPT_LIMIT = 12000

/** Header introducing the claims material block in the chain-stage prompt. */
const CLAIMS_MATERIAL_HEADER = '## 权利要求书（本次调用的 claims 参数）'

/**
 * Header introducing the previous round's review hint in the chain-stage prompt.
 *
 * 反套话门（`slop-gate`）未通过时产出 `slop_revision_hint` 并把控制权回退到本阶段；
 * 收口阶段若不读该键，回退就只是「用同一段提示再问一遍」，模型看不到上一轮评审
 * 意见，回路等于空转。键名与该门约定一致，见 `patent-tools/atoms/slop-gate.ts`。
 */
const REVISION_HINT_HEADER = '## 上一轮评审意见（须逐条处理，不得忽略）'

/** Prompt cap for the previous round's review hint. */
const REVISION_HINT_LIMIT = 2000

/**
 * Cap a text block spliced into a prompt and mark the cut. An unmarked cut
 * reads to the model as the whole document.
 * @param text - the block text.
 * @param limit - the maximum number of characters kept.
 * @returns the block, with a truncation note appended when it was cut.
 */
function capPromptBlock(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n（截断，完整内容见 run 记录）` : text
}

/**
 * Resolve the workflow-runs directory for a case id, mirroring Sati's
 * `caseWorkflowRunsDir` convention: an absolute path maps to
 * `<caseId>/workflow-runs`; a relative path containing a separator maps to
 * `<cwd>/<caseId>/workflow-runs`; a plain id maps to
 * `<cwd>/data/cases/<caseId>/workflow-runs`.
 * @param caseId - the case identity (path form or plain id).
 * @param cwd - the working directory the relative paths resolve against.
 * @returns the absolute workflow-runs directory.
 */
export function resolveWorkflowRunsDir(caseId: string, cwd: string): string {
  if (isAbsolute(caseId)) return join(caseId, 'workflow-runs')
  if (caseId.includes('/') || caseId.includes('\\')) return join(cwd, caseId, 'workflow-runs')
  return join(cwd, caseWorkflowRunsDir(caseId))
}

function caseKeyOf(caseId: string): string {
  if (isAbsolute(caseId) || caseId.includes('/') || caseId.includes('\\')) {
    return basename(caseId)
  }
  return caseId
}

/**
 * Write a file atomically: write a sibling temp file then rename over the
 * target, so a concurrent or interrupted write never leaves a half-written file.
 * @param file - the destination path.
 * @param content - the complete UTF-8 content.
 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** Resolved persistence destination for one workflow run. */
interface WorkflowRunPersistTarget {
  /** Directory the run JSON and Mermaid diagram land in. */
  runsDir: string
  /** Filesystem-safe run key (<caseKey>__<manifestId>). */
  runId: string
}

/**
 * Resolve the persistence target for one run; no case id means no persistence.
 * @param caseId - optional case identity keying the run.
 * @param manifestId - the manifest id used in the run key.
 * @param cwd - the working directory.
 * @returns the target, or undefined when caseId is absent.
 */
export function resolveRunPersistTarget(
  caseId: string | undefined,
  manifestId: string,
  cwd: string,
): WorkflowRunPersistTarget | undefined {
  if (caseId === undefined) return undefined
  return {
    runsDir: resolveWorkflowRunsDir(caseId, cwd),
    runId: `${caseKeyOf(caseId)}__${manifestId}`,
  }
}

/**
 * Write the Mermaid plan diagram after a run and return the persistence note.
 * The run JSON is saved inside runWorkflow via the persist option; this only
 * supplements the .mmd and surfaces any persist warning from the result.
 * @param target - the resolved persistence destination.
 * @param manifest - the manifest whose diagram is rendered.
 * @param result - the run result carrying any persist warning.
 * @returns the model-facing persistence note (never throws).
 */
export async function writeRunArtifacts(
  target: WorkflowRunPersistTarget,
  manifest: WorkflowManifest,
  result: WorkflowRunResult,
): Promise<string> {
  try {
    await atomicWriteFile(join(target.runsDir, `${target.runId}.mmd`), workflowManifestToMermaid(manifest))
    const note = `持久化: ${join(target.runsDir, `${target.runId}.json`)} + ${join(target.runsDir, `${target.runId}.mmd`)}`
    /* v8 ignore next -- the built-in run stores surface no persist warning in this build. */
    return result.persistWarning ? `${note}\n${result.persistWarning}` : note
  } catch (err) {
    /* v8 ignore next -- atomicWriteFile only rejects with Error values. */
    return `持久化失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Options for executing a manifest via runWorkflow with optional persistence. */
interface RunWorkflowWithPersistOptions {
  /** Stage-handler registry (default: the global registry). */
  handlers: StageHandlerRegistry
  /** Atom registry resolving atom.outputSchema[0] (default: the global registry). */
  atoms: AtomRegistry
  /** The assembled StageProvider. */
  provider: StageProvider
  /** Cancellation signal propagated to stage boundaries. */
  signal?: AbortSignal
  /** Stage-advance notification forwarded to the workflow engine. */
  onStage?: (stageId: string, index: number, total: number) => void
  /** Case identity keying the run persistence; undefined disables persistence. */
  caseId: string | undefined
  /** Working directory the relative run paths resolve against. */
  cwd: string
  /** Already-approved approval-gate stage ids (skipped on rerun). */
  approvalGrants?: string[]
}

/** Result of a persisted workflow run (the persist target feeds the artifact writes). */
type PersistedWorkflowRun = {
  result: WorkflowRunResult
  /** Resolved persistence target; undefined when caseId is absent. */
  persistTarget: WorkflowRunPersistTarget | undefined
}

/**
 * Execute a manifest with the shared option wiring (handlers/atoms/provider/
 * signal + optional JsonFileWorkflowRunStore persistence). Shared by
 * patent_workflow_run and flexible_plan(run) so the two do not drift.
 * @param manifest - the manifest to run.
 * @param ctx - the workflow context.
 * @param executor - the chain-stage executor for atom-less stages.
 * @param opts - the run options.
 * @returns the run result plus the resolved persistence target.
 */
export async function runWorkflowWithPersist(
  manifest: WorkflowManifest,
  ctx: WorkflowContext,
  executor: StageExecutor,
  opts: RunWorkflowWithPersistOptions,
): Promise<PersistedWorkflowRun> {
  const persistTarget = resolveRunPersistTarget(opts.caseId, manifest.id, opts.cwd)
  const result = await runWorkflow(manifest, ctx, executor, {
    handlers: opts.handlers,
    atoms: opts.atoms,
    provider: opts.provider,
    /* v8 ignore next -- every caller passes an AbortSignal through. */
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onStage !== undefined ? { onStage: opts.onStage } : {}),
    ...(persistTarget !== undefined
      ? { persist: new JsonFileWorkflowRunStore(persistTarget.runsDir), runId: persistTarget.runId }
      : {}),
    ...(opts.approvalGrants !== undefined && opts.approvalGrants.length > 0
      ? { approvalGrants: opts.approvalGrants }
      : {}),
  })
  return { result, persistTarget }
}

/** Options for assembling the tail text of a workflow-run result. */
interface RenderWorkflowResultTextOptions {
  /** Tool label prefixing the summary line. */
  toolName: string
  /** The run result whose summary/completion drive the text. */
  result: WorkflowRunResult
  /** Per-stage lines already formatted by the caller. */
  stageLines: string[]
  /** Persistence note line. */
  persistNote: string
  /** Deterministic rule-gate section (kept empty in this port). */
  checkSection: string
  /** Optional approval-gate interrupt note. */
  interruptNote?: string
}

/**
 * Assemble the shared workflow-run tail text: summary, stage lines, interrupt
 * note, completion, persistence note, and (empty) rule-gate section.
 * @param opts - the assembly options.
 * @returns the multi-line model-facing text.
 */
export function renderWorkflowResultText(opts: RenderWorkflowResultTextOptions): string {
  const completion = opts.result.completed ? 'completed' : 'incomplete'
  /* v8 ignore next -- every caller renders an empty rule-gate section in this build. */
  const checkLines = opts.checkSection !== '' ? [opts.checkSection] : []
  return [
    `${opts.toolName}(${opts.result.manifestId}): ${opts.result.summary}`,
    ...opts.stageLines,
    ...(opts.interruptNote !== undefined ? [opts.interruptNote] : []),
    `完成状态: ${completion}`,
    opts.persistNote,
    ...checkLines,
  ].join('\n')
}

/** Specification inputs shared by the run tool and the context mapper. */
export interface SpecificationRunOptions {
  /** Invention title, read by the specification drafting and checking stages. */
  title?: string
  /** Abstract text, read by the specification checker. */
  abstract?: string
  /** Background-technique text, read by the specification drafting stage. */
  background?: string
  /** Patent type, read by the specification drafting and checking stages. */
  patentType?: 'invention' | 'utility_model'
  /** Whether the application has drawings; the specification checker infers it when absent. */
  hasDrawings?: boolean
  /** Declared drawing count, compared with the drawing-description entries. */
  drawingCount?: number
  /** Abstract figure number from the request form. */
  abstractFigureNumber?: number
}

/** Options mapping a tool's input into the workflow context the atoms read. */
interface BuildWorkflowRunContextOptions extends SpecificationRunOptions {
  /** Case identity (may contain a {caseId} placeholder). */
  caseId?: string
  /** Initial material consumed by the extract atoms. */
  input: string
  /**
   * Claims text, when the caller supplies it separately from the initial
   * material (e.g. an office action as `input` plus the claims under review).
   */
  claims?: string
  /** Figure-analysis entries, mapped to the state the specification checker reads. */
  figureAnalysis?: unknown[]
  /** Drawing file paths, read by the figure-analysis stage before drafting. */
  figureFiles?: string[]
  /** Application filing date, read by the time-baseline atom. */
  filingDate?: string
  /** Earliest priority date, read by the time-baseline atom. */
  priorityDate?: string
  /** Max prior-art search results (default 5). */
  maxResults?: number
  /** claim-chart target objects JSON (default empty). */
  chartTargets?: string
  /** Existing prior-art evidence entries (mapped to the prior_art state the search/filter/citation-check stages read). */
  priorArt?: unknown[]
  /**
   * Conflicting-application candidates (mapped to the conflicting_applications
   * state the conflicting-application stage reads).
   */
  conflictingApplications?: unknown[]
  /**
   * Evidence entries (mapped to the evidence state the evidence-check stage
   * reads).
   */
  evidence?: unknown[]
  /** Evidence submission deadline (mapped to evidence_deadline). */
  evidenceDeadline?: string
}

/**
 * Map a tool's input into the workflow context, in two material roles:
 * `text`/`source_text`/`extraction_input`/`input` all point at the initial
 * material, and `claim`/`claim_text`/`claims` at the claims text — the first two
 * are the keys the element-level atoms read, `claims` is the key the chain
 * executor labels its claims block with. Without a separate claims input both
 * roles point at the same material, so a single-blob caller behaves as before.
 * Supplied dates map to the `filing_date`/`priority_date` state keys the
 * time-baseline atom reads; supplied prior art, conflicting applications, and
 * evidence map to the `prior_art`, `conflicting_applications`, and `evidence`
 * keys their stages read.
 * Shared by patent_workflow_run (manifest + graph) and flexible_plan (run).
 * @param opts - the mapping options.
 * @returns the workflow context.
 */
export function buildWorkflowRunContext(opts: BuildWorkflowRunContextOptions): WorkflowContext {
  const claims = opts.claims !== undefined && opts.claims.trim().length > 0 ? opts.claims : undefined
  const claimText = claims ?? opts.input
  return {
    ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}),
    input: opts.input,
    text: opts.input,
    source_text: opts.input,
    extraction_input: opts.input,
    claim: claimText,
    claim_text: claimText,
    ...(claims !== undefined ? { claims } : {}),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.abstract !== undefined ? { abstract: opts.abstract } : {}),
    ...(opts.background !== undefined ? { background: opts.background } : {}),
    ...(opts.patentType !== undefined ? { patent_type: opts.patentType } : {}),
    ...(opts.hasDrawings !== undefined ? { has_drawings: opts.hasDrawings } : {}),
    ...(opts.figureAnalysis !== undefined ? { figure_analysis: opts.figureAnalysis } : {}),
    ...(opts.figureFiles !== undefined ? { figure_files: opts.figureFiles } : {}),
    ...(opts.drawingCount !== undefined ? { drawing_count: opts.drawingCount } : {}),
    ...(opts.abstractFigureNumber !== undefined ? { abstract_figure_number: opts.abstractFigureNumber } : {}),
    ...(opts.filingDate !== undefined ? { filing_date: opts.filingDate } : {}),
    ...(opts.priorityDate !== undefined ? { priority_date: opts.priorityDate } : {}),
    chart_targets: opts.chartTargets ?? '',
    max_results: String(opts.maxResults ?? 5),
    ...(opts.priorArt !== undefined ? { prior_art: opts.priorArt } : {}),
    ...(opts.conflictingApplications !== undefined
      ? { conflicting_applications: opts.conflictingApplications }
      : {}),
    ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
    ...(opts.evidenceDeadline !== undefined ? { evidence_deadline: opts.evidenceDeadline } : {}),
  }
}

/** Model + search dependencies the workflow provider is assembled from. */
export interface WorkflowProviderDeps {
  /** Streaming patent-domain model port the atoms bridge into string calls. */
  model?: PatentModelPort
  /** Prior-art search function (default: the nuo-patent provider). */
  search?: StageProvider['search']
}

/** Context the workflow provider reads (case identity, propagated to atoms). */
interface WorkflowProviderContext {
  /** Case identity propagated to atoms that persist or merge by case. */
  caseId?: string
}

/**
 * Assemble a StageProvider from the injected model port + search function. The
 * atoms bridge `provider.llm` into their string LLM calls; search defaults to
 * the nuo-patent provider when not injected. Returns undefined when no model is
 * available so callers can report a clear setup error instead of degrading.
 * @param deps - model + search dependencies.
 * @param context - optional case identity.
 * @returns the provider, or undefined without a model.
 */
export function buildWorkflowProvider(
  deps: WorkflowProviderDeps,
  context: WorkflowProviderContext = {},
): StageProvider | undefined {
  const model = deps.model
  if (!model) return undefined
  // callLLM bridges the port into the string seam the graph LLM nodes use;
  // llm feeds the atoms' builtin/llm bridge (which also prefers callLLM).
  const search: StageProvider['search'] = deps.search ?? createNuoSearchProvider().search
  return {
    callLLM: async (prompt, opts, signal) =>
      collectPortText(model, prompt, signal, {
        /* v8 ignore next -- every callLLM caller passes an explicit temperature. */
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts?.jsonSchema !== undefined ? { schema: opts.jsonSchema } : {}),
      }),
    llm: model,
    /* v8 ignore next -- deps.search ?? createNuoSearchProvider().search is never undefined. */
    ...(search === undefined ? {} : { search }),
    caseId: context.caseId ?? '',
  }
}

/**
 * Build a chain-stage executor for atom-less (收口) stages: calls the provider
 * LLM with the stage description as the instruction, the workflow material, and
 * the upstream stage outputs the stage declares in `consumes`. Without a usable
 * call seam it fails loud — an echo stub would silently "complete" every stage
 * with the input text.
 *
 * Untrusted text (material, claims, upstream stage outputs) goes through
 * `dataBlock`; only the description, guidance and stage ids are spliced into the
 * instruction area.
 * @param provider - the assembled StageProvider (must exist — callers check first).
 * @param toolLabel - tool name for the setup_required diagnostic.
 * @returns a StageExecutor for atom-less stages.
 */
export function createChainStageExecutor(
  provider: StageProvider,
  toolLabel: string,
): StageExecutor {
  const call = provider.callLLM
  return async (stage, ctx, state) => {
    /* v8 ignore next 2 -- buildWorkflowProvider always wires callLLM. */
    if (!call) {
      throw new PatentToolError('setup_required', `${toolLabel}: 模型端口不可用，无法执行收口阶段。`, {})
    }
    /* v8 ignore next -- buildWorkflowRunContext always sets input. */
    const material = ctx.input ?? ''
    const claims = getStateString(state, 'claims')
    const revisionHint = getStateString(state, 'slop_revision_hint')
    const prompt = [
      '你是资深专利代理师。请完成当前工作流阶段，输出阶段成果文本：',
      stage.description,
      // 阶段法律指引（法条操作框架/输出要求）紧跟阶段描述，先于材料注入。
      ...(stage.guidance !== undefined ? [stage.guidance] : []),
      dataBlock(capPromptBlock(material, MATERIAL_PROMPT_LIMIT)),
      ...(claims.trim().length > 0
        ? [CLAIMS_MATERIAL_HEADER, dataBlock(capPromptBlock(claims, MATERIAL_PROMPT_LIMIT))]
        : []),
      ...consumedStageBlocks(stage, state),
      // 回退重跑时把上一轮评审意见接在材料之后：它是对本阶段产出的具体修订要求，
      // 不是上游数据，故不进 consumes。
      ...(revisionHint.trim().length > 0
        ? [REVISION_HINT_HEADER, dataBlock(capPromptBlock(revisionHint, REVISION_HINT_LIMIT))]
        : []),
    ].join('\n')
    return await call(prompt, { temperature: 0.3 })
  }
}

/**
 * Render the upstream stage outputs a stage declares in `consumes`, in
 * declaration order and each under its own header. A declared stage that
 * produced nothing renders an explicit marker: dropping it silently would let
 * the stage answer as if the upstream artifact did not exist.
 *
 * An entry may name a projection (`'claim-chart#rows'`): the projector decides
 * what part of that artifact the prompt gets. Unknown projections throw — the
 * manifest is data, and a typo must not silently restore full-text injection.
 * @param stage - the stage whose declared dependencies are rendered.
 * @param state - the accumulated run state (holds `state[stageId]` outputs).
 * @returns header + data-block line pairs, empty without declared dependencies.
 */
function consumedStageBlocks(stage: WorkflowStage, state: PipelineState): string[] {
  return (stage.consumes ?? []).flatMap((entry) => {
    const { stageId } = parseConsumeRef(entry)
    const text = getStateString(state, stageId)
    if (text.trim().length === 0) return [`## 上游阶段产出: ${stageId}`, '（该阶段无产出）']
    const projected = projectConsumedOutput(entry, text, state)
    return [`## 上游阶段产出: ${stageId}`, dataBlock(capPromptBlock(projected, CONSUMED_OUTPUT_LIMIT))]
  })
}

/**
 * Compute a stage's recap flag and output preview. Shared by the recap and run
 * tools so the two renderers cannot drift.
 *
 * Atom stages get the wider limit: their output is program-produced (parsed
 * documents, coverage verdicts, chart gaps) and appears nowhere else the model
 * can read, while an executor stage's text was written by the model itself and
 * a summary line suffices for the recap. Full outputs always stay in the
 * result's `stages` field and in the persisted run record.
 * @param stage - the stage result.
 * @returns the degraded flag and the truncated output preview.
 */
export function stageFlagAndPreview(stage: WorkflowStageResult): { flag: string; preview: string } {
  const flag = stage.degraded ? '⚠️ 降级' : '✅'
  const limit = stage.atom !== undefined ? ATOM_OUTPUT_PREVIEW_LIMIT : EXECUTOR_OUTPUT_PREVIEW_LIMIT
  const preview = stage.output.length > 0
    ? `${stage.output.slice(0, limit)}${stage.output.length > limit ? '…（截断，完整内容见 run 记录）' : ''}`
    : '(无输出)'
  return { flag, preview }
}

/**
 * Format a run's stage results into the shared per-stage lines (flag + stage id
 * + atom note + output preview). Shared by patent_workflow_run and
 * flexible_plan(run).
 * @param result - the run result.
 * @returns one line per executed stage.
 */
export function renderWorkflowStageLines(result: WorkflowRunResult): string[] {
  return result.stages.map((s) => {
    const { flag, preview } = stageFlagAndPreview(s)
    return `- ${flag} ${s.stageId}${s.atom !== undefined ? ` [atom:${s.atom}]` : ''}: ${preview}`
  })
}
