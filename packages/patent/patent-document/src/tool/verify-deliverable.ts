/**
 * `verify_deliverable` tool: decide deterministically whether a case's
 * deliverable set is the one the case's main path shows.
 *
 * Two defects this decides, both seen in real drafting sessions: the case main
 * path still holds a superseded artifact while the rewrite sits in a subfolder
 * (the reader opens the main path and sees the old text), and a rendered
 * deliverable was produced before the inputs it is supposed to show. The tool
 * takes the paths, compares them byte for byte, orders them by mtime, and emits
 * a delivery manifest — the input hashes and mtimes a delivery report quotes.
 * @module @deepseek-ai/dsh-patent-document/tool/verify-deliverable
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** One artifact as it exists in two places: the case main path and the delivered copy. */
export interface DeliverableArtifactInput {
  /** Role of the file, e.g. 「权利要求书」. */
  role: string
  /** Path a reader opens first (the case main path). */
  canonical_path: string
  /** Path this delivery ships. */
  delivered_path: string
}

/**
 * One instruction the delivery must account for, together with the files that
 * evidence it. The instructing party's own wording goes in `requirement` (not a
 * paraphrase), so the rendered checklist can be read against what was asked.
 */
interface DeliverableRequirementInput {
  /** The requirement in the instructing party's words (user instruction or case-file requirement). */
  requirement: string
  /** Files that evidence it; empty means no evidence was recorded for the requirement. */
  evidence: string[]
}

/** Input of the deliverable check. */
export interface VerifyDeliverableInput {
  /** Artifacts to reconcile, each pairing its case-main-path copy with the delivered copy. */
  artifacts: DeliverableArtifactInput[]
  /** Drawing files of this delivery, when the delivery ships drawings. */
  figures?: string[]
  /** Rendered deliverable (html/pdf) of this delivery, when one was produced. */
  rendered?: string
  /** Requirements this delivery must account for, each with the files that evidence it. */
  requirements?: DeliverableRequirementInput[]
}

/** One file as the manifest records it. */
interface DeliverableFileRecord {
  /** Role of the artifact, or `附图`／`渲染件` for the auxiliary files. */
  role: string
  /** Path this record was taken from. */
  path: string
  /** SHA-256 of the file contents. */
  sha256: string
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number
}

/** One delivery defect. */
interface DeliverableViolation {
  rule: string
  severity: 'error'
  message: string
  suggestion?: string
}

/** One requirement's row in the rendered checklist. */
interface DeliverableRequirementResult {
  /** The requirement as given. */
  requirement: string
  /** Evidence files, as given. */
  evidence: string[]
  /** Whether every evidence file exists and at least one was given. */
  satisfied: boolean
}

/** Result of the deliverable check. */
export interface VerifyDeliverableOutput {
  passed: boolean
  /** Every file the check read, with its hash and mtime. */
  manifest: DeliverableFileRecord[]
  violations: DeliverableViolation[]
  /** One row per given requirement; absent when the caller gave none. */
  requirements?: DeliverableRequirementResult[]
}

/**
 * Largest file the check will hash. Deliverables are documents and drawings;
 * the cap keeps a model-supplied path such as `/dev/zero` or a huge sparse file
 * from exhausting memory during hashing.
 */
export const MAX_DELIVERABLE_FILE_BYTES = 64 * 1024 * 1024

/** Why a path could not be read as a deliverable. */
type FileRecordFault = 'missing' | 'not_file' | 'too_large'

/** One readable file's hash and mtime, or the reason it was rejected. */
type FileRecord =
  | { ok: true; sha256: string; mtimeMs: number }
  | { ok: false; fault: FileRecordFault }

/** Model-facing explanation of a rejected path. */
function faultMessage(fault: FileRecordFault): string {
  switch (fault) {
    case 'missing':
      return '路径不存在或不可读'
    case 'not_file':
      return '路径不是普通文件（目录、设备或管道不能作为交付件）'
    case 'too_large':
      return `超过 ${String(MAX_DELIVERABLE_FILE_BYTES)} 字节上限`
  }
}

/**
 * SHA-256 and mtime of one regular file.
 * @param path - the file to read.
 * @returns the record, or the reason the path is not a hashable deliverable.
 */
function readFileRecord(path: string): FileRecord {
  try {
    const stats = statSync(path)
    // Check the kind before reading: readFileSync on a character device or FIFO
    // never reaches EOF and would hang or exhaust memory.
    if (!stats.isFile()) return { ok: false, fault: 'not_file' }
    if (stats.size > MAX_DELIVERABLE_FILE_BYTES) return { ok: false, fault: 'too_large' }
    return {
      ok: true,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mtimeMs: stats.mtimeMs,
    }
  } catch {
    // A missing or unreadable path is reported as a violation by the caller, which names the role.
    return { ok: false, fault: 'missing' }
  }
}

/** First 12 hex characters of a digest, for readable messages. */
function short(sha256: string): string {
  return sha256.slice(0, 12)
}

/**
 * Reconcile the artifacts, then order the rendered deliverable against its inputs.
 * @param input - the artifact pairs, drawings, and rendered deliverable to check.
 * @returns whether the delivery is consistent, the file manifest, and the violations.
 */
export function verifyDeliverable(input: VerifyDeliverableInput): VerifyDeliverableOutput {
  const manifest: DeliverableFileRecord[] = []
  const violations: DeliverableViolation[] = []
  const inputs: Array<{ label: string; path: string; mtimeMs: number }> = []

  if (input.artifacts.length === 0) {
    violations.push({
      rule: 'no_artifacts',
      severity: 'error',
      message: '未提供任何待核对的交付件',
      suggestion: '至少给出一组 artifacts（role + 案卷主路径 canonical_path + 交付版 delivered_path）',
    })
  }

  for (const artifact of input.artifacts) {
    const canonical = readFileRecord(artifact.canonical_path)
    const delivered = readFileRecord(artifact.delivered_path)
    const failArtifact = (fault: FileRecordFault, path: string): void => {
      violations.push({
        rule: 'artifact_missing',
        severity: 'error',
        message: `${artifact.role}：${faultMessage(fault)} ${path}`,
        suggestion: '核对路径；被取代的旧版应先归档再移出主路径，不要留一个打不开的引用',
      })
    }
    if (!canonical.ok) {
      failArtifact(canonical.fault, artifact.canonical_path)
      continue
    }
    if (!delivered.ok) {
      failArtifact(delivered.fault, artifact.delivered_path)
      continue
    }
    manifest.push({ role: artifact.role, path: artifact.delivered_path, sha256: delivered.sha256, mtimeMs: delivered.mtimeMs })
    if (canonical.sha256 !== delivered.sha256) {
      violations.push({
        rule: 'artifact_mismatch',
        severity: 'error',
        message: `${artifact.role}：案卷主路径与交付版内容不一致（主路径 ${short(canonical.sha256)}、交付版 ${short(delivered.sha256)}）——读者打开主路径看到的不是本次交付版`,
        suggestion: '把交付版复制到主路径并归档旧版，使两处逐字节一致；不要只把新版写进子目录而让旧版留在主路径',
      })
    }
    inputs.push({ label: artifact.role, path: artifact.delivered_path, mtimeMs: delivered.mtimeMs })
  }

  for (const figure of input.figures ?? []) {
    const record = readFileRecord(figure)
    if (!record.ok) {
      violations.push({
        rule: 'figure_missing',
        severity: 'error',
        message: `附图：${faultMessage(record.fault)} ${figure}`,
        suggestion: '核对附图路径；附图是交付件的一部分，缺图按未完成交付处理',
      })
      continue
    }
    manifest.push({ role: '附图', path: figure, sha256: record.sha256, mtimeMs: record.mtimeMs })
    inputs.push({ label: '附图', path: figure, mtimeMs: record.mtimeMs })
  }

  if (input.rendered !== undefined) {
    const rendered = readFileRecord(input.rendered)
    if (!rendered.ok) {
      violations.push({
        rule: 'rendered_missing',
        severity: 'error',
        message: `渲染件：${faultMessage(rendered.fault)} ${input.rendered}`,
        suggestion: '核对渲染输出路径；交付报告要引用渲染件的指纹，缺件无法核对',
      })
    } else {
      manifest.push({ role: '渲染件', path: input.rendered, sha256: rendered.sha256, mtimeMs: rendered.mtimeMs })
      const newest = inputs.reduce<{ label: string; path: string; mtimeMs: number } | undefined>(
        (acc, entry) => (acc === undefined || entry.mtimeMs > acc.mtimeMs ? entry : acc),
        undefined,
      )
      if (newest !== undefined && rendered.mtimeMs < newest.mtimeMs) {
        violations.push({
          rule: 'render_order',
          severity: 'error',
          message: `渲染件早于其输入件：渲染件 ${new Date(rendered.mtimeMs).toISOString()} 早于 ${newest.label}（${newest.path}）${new Date(newest.mtimeMs).toISOString()}`,
          suggestion: '输入件定稿并冻结后再重新渲染，交付报告写明渲染晚于全部输入件',
        })
      }
    }
  }

  const requirements = checkRequirements(input.requirements ?? [], manifest, violations)
  return {
    passed: violations.length === 0,
    manifest,
    violations,
    ...(input.requirements === undefined ? {} : { requirements }),
  }
}

/**
 * Check the requirement checklist: a requirement with no evidence, or with an
 * evidence file that does not exist, fails the delivery. The rows are what the
 * delivery report quotes, so the check reports them even when nothing is wrong.
 * @param given - the requirements as supplied.
 * @param manifest - the manifest to append the evidence files to (same path recorded once).
 * @param violations - the violation list to append to.
 * @returns one row per requirement.
 */
function checkRequirements(
  given: readonly DeliverableRequirementInput[],
  manifest: DeliverableFileRecord[],
  violations: DeliverableViolation[],
): DeliverableRequirementResult[] {
  const recorded = new Set(manifest.map(record => record.path))
  return given.map((entry) => {
    let satisfied = entry.evidence.length > 0
    if (entry.evidence.length === 0) {
      violations.push({
        rule: 'requirement_without_evidence',
        severity: 'error',
        message: `要求「${entry.requirement}」没有给出任何证据文件`,
        suggestion: '为每条要求给出可复查的证据（校验工具输出的结论、成品文件、报告小节）；拿不出证据的要求按未满足处理，不得用「已按要求复核」这类概括句替代',
      })
    }
    for (const path of entry.evidence) {
      const record = readFileRecord(path)
      if (!record.ok) {
        satisfied = false
        violations.push({
          rule: 'requirement_evidence_missing',
          severity: 'error',
          message: `要求「${entry.requirement}」的证据文件${faultMessage(record.fault)}：${path}`,
          suggestion: '先产出该证据再交付；路径写错时改成实际文件',
        })
        continue
      }
      if (recorded.has(path)) continue
      recorded.add(path)
      manifest.push({ role: '证据', path, sha256: record.sha256, mtimeMs: record.mtimeMs })
    }
    return { requirement: entry.requirement, evidence: [...entry.evidence], satisfied }
  })
}

/**
 * Render the check result into model-facing prose: the manifest first, then the defeats.
 * @param value - the deliverable check result.
 * @returns the rendered Markdown text.
 */
export function renderDeliverableResult(value: VerifyDeliverableOutput): string {
  const lines = [`交付件核对：${value.passed ? '通过' : '未通过'}（读取 ${value.manifest.length} 个文件）`]
  if (value.manifest.length > 0) {
    lines.push('', '## 交付清单', ...value.manifest.map(m => `- [${m.role}] ${m.path} sha256=${m.sha256} mtime=${new Date(m.mtimeMs).toISOString()}`))
  }
  if (value.requirements !== undefined && value.requirements.length > 0) {
    lines.push(
      '',
      '## 用户要求逐条核对',
      ...value.requirements.map(row =>
        `- [${row.satisfied ? '满足' : '未满足'}] ${row.requirement}${row.evidence.length === 0 ? '（无证据）' : ` → 证据：${row.evidence.join('、')}`}`),
    )
  }
  if (value.violations.length > 0) {
    lines.push('', '## 违规项')
    for (const v of value.violations) {
      lines.push(`- [${v.severity}] ${v.message}`, ...(v.suggestion === undefined ? [] : [`  → ${v.suggestion}`]))
    }
  }
  return lines.join('\n')
}

const DESCRIPTION = [
  '核对交付件与案卷主路径的一致性并输出交付清单（确定性规则，无 LLM 调用）。',
  '- 逐字节比对每件申请文件的案卷主路径与交付版：不一致即报错——读者打开主路径必须看到本次交付版，旧版要先归档',
  '- 记录每件的 SHA-256 与 mtime，供交付报告引用',
  '- 给定渲染件时，核对渲染晚于全部输入件（文本与附图），交付时序倒挂即报错',
  '- 给定 requirements 时逐条核对：每条要求必须给出证据文件，缺证据或证据文件不存在即报错，并把核对表随结果返回（交付报告直接引用它，不要用「已按要求复核」这类概括句代替）',
  '',
  '用法：交付前调用。传 artifacts（role + canonical_path + delivered_path 一组或多组），有附图传 figures，有渲染件传 rendered，有用户或案卷要求时传 requirements（requirement 用指令原话 + evidence 文件路径）；返回 passed、manifest、requirements 核对表与 violations，未通过不得交付。',
].join('\n')

const VIOLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['error'] },
    message: { type: 'string', required: true },
    suggestion: { type: 'string' },
  },
} as const

/**
 * Build the `verify_deliverable` tool (pure filesystem reads, no injected services).
 * @returns a registry-ready tool definition.
 */
export function createVerifyDeliverableTool(): ToolDefinition {
  return defineTool({
    name: 'verify_deliverable',
    description: DESCRIPTION,
    parameters: {
      artifacts: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: '文件角色，如「权利要求书」' },
            canonical_path: { type: 'string', required: true, description: '案卷主路径（读者优先打开的那份）' },
            delivered_path: { type: 'string', required: true, description: '本次交付版路径' },
          },
        },
        description: '待核对的一组或多组申请文件（主路径 ↔ 交付版）',
      },
      figures: { type: 'array', items: { type: 'string' }, description: '本次交付的附图文件路径（可选）' },
      rendered: { type: 'string', description: '本次交付的渲染件路径（可选；给定后核对渲染晚于全部输入件）' },
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            requirement: { type: 'string', required: true, description: '用户或案卷要求的原话（不要转述）' },
            evidence: { type: 'array', required: true, items: { type: 'string' }, description: '该要求的证据文件路径（工具结论、成品文件等）；留空即按未满足报错' },
          },
        },
        description: '本次交付必须交代的每条要求及其证据（可选）；给出后随结果返回逐条核对表',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          manifest: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                path: { type: 'string', required: true },
                sha256: { type: 'string', required: true },
                mtimeMs: { type: 'number', required: true },
              },
            },
          },
          violations: { type: 'array', required: true, items: VIOLATION_SCHEMA },
          requirements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requirement: { type: 'string', required: true },
                evidence: { type: 'array', required: true, items: { type: 'string' } },
                satisfied: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDeliverableResult(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      return verifyDeliverable(args)
    },
  })
}
