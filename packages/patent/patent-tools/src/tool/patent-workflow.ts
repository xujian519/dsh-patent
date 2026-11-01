/**
 * `patent_workflow` tool: run a declarative patent workflow in recap (收口)
 * mode. The host agent produces each stage's text; this tool validates the
 * manifest, assembles a WorkflowRunResult with degraded-step marking and a
 * summary, and persists the result record. No LLM call — the empty handler
 * registry disables atom execution.
 *
 * Deterministic rule-gate deviation: Sati's dual-track checker (RuleEngine +
 * defaultPatentRules) is not ported here. Its responsibilities live in
 * `@deepseek-ai/dsh-patent-rule`'s three gates — output (tool results,
 * post-execute), artifact structural (declared tool-call arguments,
 * pre-execute), and delivery (`rule_check` + `law_verify` before render) — so
 * the recap path drops the rule-gate section and `checkSection` renders empty;
 * the carrier stays for the ported text contract. See
 * `.agents/notes/implemented/architecture/2026-09-28-patent-output-gating-runs-on-the-rule-gate.md`
 * and
 * `.agents/notes/implemented/architecture/2026-10-03-patent-delivery-gate-enforces-gate-runs.md`.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-workflow
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  StageHandlerRegistry,
  validateWorkflowManifest,
  type WorkflowInterrupt,
  type WorkflowManifest,
  type WorkflowStageResult,
} from '@deepseek-ai/dsh-patent-core'
import { JsonFileWorkflowRunStore, builtinPatentManifests, runWorkflow } from '@deepseek-ai/dsh-patent-workflow'
import {
  renderWorkflowResultText,
  resolveRunPersistTarget,
  stageFlagAndPreview,
  writeRunArtifacts,
} from './internal/workflow-helpers.ts'

/** One stage's output as supplied by the host agent. */
type PatentWorkflowStageOutput = {
  /** Stage id matching manifest.stages[].id. */
  stageId: string
  /** The stage's analysis text produced by the host agent. */
  text: string
}

/** Tool input: which manifest to finalize plus the per-stage outputs. */
export type PatentWorkflowInput = {
  /** Workflow manifest id (default: the first built-in, patent_novelty_v1). */
  manifestId?: string
  /** Per-stage outputs keyed by stage id; missing stages are marked degraded. */
  outputs?: PatentWorkflowStageOutput[]
  /** Case identity for the result record (enables persistence). */
  caseId?: string
}

/** Tool canonical result: the assembled run record plus its persistence note. */
export type PatentWorkflowOutput = {
  /** The manifest id the run was assembled against. */
  manifestId: string
  /** Whether the requested manifest exists in the built-in catalog. */
  found: boolean
  /** Whether the manifest passed validation. */
  valid: boolean
  /** Whether the run completed without degraded steps. */
  completed: boolean
  /** The manifest case type. */
  caseType: string
  /** Per-stage results. */
  stages: WorkflowStageResult[]
  /** Stage ids that produced no (or degraded) output. */
  degradedSteps: string[]
  /** The assembled run summary. */
  summary: string
  /** Persistence note (or the "not enabled" marker without a caseId). */
  persistNote: string
  /** Approval-gate interrupt, when present (never for the recap path). */
  interrupted?: WorkflowInterrupt
  /** Persistence failure warning, when present. */
  persistWarning?: string
  /** Built-in manifest ids (only when the requested manifest is unknown). */
  available?: string[]
  /** Manifest validation message (only when validation failed). */
  error?: string
}

/** Tool dependencies: the working directory persistence resolves against. */
export interface PatentWorkflowToolDeps {
  /** Working directory (default process.cwd()). */
  cwd?: string
}

const DESCRIPTION = [
  'Run a declarative patent workflow (recap mode): validate the manifest, assemble per-stage outputs into a structured result with degraded-step marking and a summary, then persist the record. Built-in manifests: patent_novelty_v1, patent_disclosure_v1, patent_inventiveness_v1, patent_patentability_v1, patent_oa_response_v1, patent_invalidation_v1, patent_reexamination_v1, patent_infringement_v1. Supply outputs keyed by stage id; missing stages are marked degraded. No LLM call — this tool finalizes text the agent already produced. Use to finalize multi-stage patent analyses (novelty / disclosure / inventiveness / ...) with a single verifiable result record.',
].join('\n')
/**
 * Format a run's stage results into recap-mode lines (flag + stage id +
 * strategy + output preview).
 * @param value - the assembled output.
 * @returns one line per stage.
 */
function recapStageLines(value: PatentWorkflowOutput): string[] {
  return value.stages.map((s) => {
    const { flag, preview } = stageFlagAndPreview(s)
    return `- ${flag} ${s.stageId} (${s.strategy}): ${preview}`
  })
}

/**
 * Render the canonical recap value into model-facing prose.
 * @param value - the assembled run record.
 * @returns the multi-line result, or the unknown/validation message.
 */
export function renderPatentWorkflow(value: PatentWorkflowOutput): string {
  if (!value.found) {
    return `patent_workflow: 未知 manifest "${value.manifestId}"（可用: ${(value.available ?? []).join(', ')}）`
  }
  /* v8 ignore next 3 -- every built-in manifest passes validation; kept as a fail-safe for future catalog edits. */
  if (!value.valid) {
    return `patent_workflow: manifest 校验失败: ${value.error ?? ''}`
  }
  return renderWorkflowResultText({
    toolName: 'patent_workflow',
    result: value,
    stageLines: recapStageLines(value),
    persistNote: value.persistNote,
    checkSection: '',
  })
}

/**
 * Build the `patent_workflow` recap tool.
 * @param deps - optional working-directory injection for persistence.
 * @returns a registry-ready tool definition.
 */
export function createPatentWorkflowTool(deps: PatentWorkflowToolDeps = {}): ToolDefinition {
  const manifests = new Map(builtinPatentManifests.map(manifest => [manifest.id, manifest]))
  const cwd = deps.cwd ?? process.cwd()

  return defineTool({
    name: 'patent_workflow',
    description: DESCRIPTION,
    parameters: {
      manifestId: { type: 'string', description: "Workflow manifest id. Defaults to 'patent_novelty_v1'." },
      caseId: {
        type: 'string',
        description: 'Optional case id for result records; when provided the run persists under `<caseDir>/workflow-runs/`.',
      },
      outputs: {
        type: 'array',
        description: 'Per-stage outputs keyed by stage id. Missing stages are marked degraded.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stageId: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          manifestId: { type: 'string', required: true },
          found: { type: 'boolean', required: true },
          valid: { type: 'boolean', required: true },
          completed: { type: 'boolean', required: true },
          caseType: { type: 'string', required: true },
          stages: { type: 'array', required: true },
          degradedSteps: { type: 'array', items: { type: 'string' }, required: true },
          summary: { type: 'string', required: true },
          persistNote: { type: 'string', required: true },
          interrupted: { type: 'json' },
          persistWarning: { type: 'string' },
          available: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPatentWorkflow(value as unknown as PatentWorkflowOutput) }],
    },
    async execute(args) {
      /* v8 ignore next -- the built-in manifest catalog is never empty, so the final fallback never fires. */
      const manifestId = args.manifestId ?? builtinPatentManifests[0]?.id ?? 'patent_novelty_v1'
      const manifest: WorkflowManifest | undefined = manifests.get(manifestId)
      if (!manifest) {
        const available = [...manifests.keys()]
        return {
          manifestId,
          found: false,
          valid: false,
          completed: false,
          caseType: '',
          stages: [],
          degradedSteps: [],
          summary: '',
          persistNote: '',
          available,
        }
      }
      /* v8 ignore start -- every built-in manifest passes validation; kept as a fail-safe for future catalog edits. */
      try {
        validateWorkflowManifest(manifest)
      } catch (err) {
        return {
          manifestId,
          found: true,
          valid: false,
          completed: false,
          caseType: manifest.caseType,
          stages: [],
          degradedSteps: [],
          summary: '',
          persistNote: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      /* v8 ignore stop */

      const byId = new Map((args.outputs ?? []).map(o => [o.stageId, o.text]))
      const persistTarget = resolveRunPersistTarget(args.caseId, manifest.id, cwd)
      const result = await runWorkflow(
        manifest,
        { ...(args.caseId !== undefined ? { caseId: args.caseId } : {}) },
        // oxlint-disable-next-line typescript/require-await -- StageExecutor contract returns Promise<string>
        async stage => byId.get(stage.id) ?? '',
        {
          handlers: new StageHandlerRegistry(),
          ...(persistTarget !== undefined ? { persist: new JsonFileWorkflowRunStore(persistTarget.runsDir) } : {}),
          ...(persistTarget?.runId !== undefined ? { runId: persistTarget.runId } : {}),
        },
      )

      const persistNote = persistTarget
        ? await writeRunArtifacts(persistTarget, manifest, result)
        : '持久化: 未启用（未提供 caseId）'

      return {
        manifestId,
        found: true,
        valid: true,
        completed: result.completed,
        caseType: result.caseType,
        stages: result.stages as unknown as JsonValue[],
        degradedSteps: result.degradedSteps,
        summary: result.summary,
        persistNote,
        /* v8 ignore next -- the recap path has no approval-gate handler, so runs never interrupt. */
        ...(result.interrupted !== undefined ? { interrupted: result.interrupted as unknown as JsonValue } : {}),
        /* v8 ignore next -- the built-in run stores surface no persist warning in this build. */
        ...(result.persistWarning !== undefined ? { persistWarning: result.persistWarning } : {}),
      }
    },
  })
}
