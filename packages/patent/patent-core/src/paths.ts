/**
 * 专利域路径约定与模型可控路径的越界防护（单一事实源）。
 *
 * 此前 worker-contract 的 `data/cases/{caseId}/outputs` 与 patentWorkflowTool 的
 * `data/cases/{caseId}/workflow-runs` 两处各自维护字面量，靠注释"对齐"——
 * 本模块统一推导，避免路径约定漂移。两个文书工具也共用这里的真实路径归一化
 * 与工作目录包含性校验，避免两处各写一份判定。真实路径归一化本身是知识库
 * 安装与各领域共用的内核，落在 `@deepseek-ai/dsh-knowledge-core`。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { resolveRealPath } from '@deepseek-ai/dsh-knowledge-core'
import { assertDeliverableName } from './safe-path.ts'

/** 案例根目录（相对 cwd）。 */
export const CASE_ROOT_REL = 'data/cases'

/** worker 输出子目录名。 */
export const CASE_OUTPUTS_REL = 'outputs'

/** 工作流运行记录子目录名。 */
export const CASE_WORKFLOW_RUNS_REL = 'workflow-runs'

/**
 * `<root>/data/cases/<caseId>/outputs`（worker 输出目录约定，caseId 可含 {caseId} 占位）。
 * @param caseId - 案例标识。
 * @returns 该案例的 worker 输出目录路径。
 */
export function caseOutputsDir(caseId: string): string {
  return `${CASE_ROOT_REL}/${caseId}/${CASE_OUTPUTS_REL}`
}

/**
 * `<root>/data/cases/<caseId>/workflow-runs`（工作流运行记录目录约定）。
 * @param caseId - 案例标识。
 * @returns 该案例的工作流运行记录目录路径。
 */
export function caseWorkflowRunsDir(caseId: string): string {
  return `${CASE_ROOT_REL}/${caseId}/${CASE_WORKFLOW_RUNS_REL}`
}

/**
 * 解析调用方给出的路径，并要求其真实位置留在 `root` 内。
 *
 * 模型可控的目录与配置文件路径不能直接交给文件系统：`../` 串联、指向根外的
 * 绝对路径、以及根内指向根外的 symlink 都会把读写带到工作目录之外。判定先在
 * `root` 下解析，再对两侧做真实路径归一化，因为 macOS 的 `/var` 与 `/private/var`
 * 这类别名会让纯字面比较误判；尚未创建的目录按最近的已存在祖先归一化。
 * @param path - 调用方给出的路径；相对路径按 `root` 解析，绝对路径按原样解析。
 * @param root - 允许的根目录。
 * @param label - 错误消息中的字段名。
 * @param createError - 越界时构造领域错误（各包保留自己的错误类型）。
 * @returns 解析后的绝对路径。
 * @throws 当路径真实位置越出 `root` 时，抛出 `createError` 构造的错误。
 */
export function resolveConfinedPath(
  path: string,
  root: string,
  label: string,
  createError: (message: string) => Error,
): string {
  const resolved = resolve(root, path)
  const rel = relative(resolveRealPath(root), resolveRealPath(resolved))
  const escapes = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (escapes) {
    throw createError(`${label} 越出工作目录: ${JSON.stringify(path)} 解析为 ${resolved}，工作目录 ${root}`)
  }
  return resolved
}

/**
 * 解析文书工具的产出目录：显式 outputDir > caseId 约定目录 > 缺省目录。
 *
 * 显式 outputDir 的真实位置必须留在 cwd 内（模型可控参数），caseId 走交付名判定后
 * 拼入 `data/cases/<caseId>/outputs`；缺省目录由调用方给出。
 * @param input - 目录相关字段。
 * @param cwd - 相对路径基准目录。
 * @param defaultOutputDir - 既无 outputDir 也无 caseId 时的缺省目录。
 * @param createError - 校验失败或越界时构造领域错误。
 * @returns 输出目录绝对路径。
 * @throws 当 outputDir 越出 cwd 或 caseId 不是合法交付名时，抛出 `createError` 构造的错误。
 */
export function resolvePatentOutputDir(
  input: { readonly outputDir?: string; readonly caseId?: string },
  cwd: string,
  defaultOutputDir: string,
  createError: (message: string) => Error,
): string {
  if (input.outputDir !== undefined) {
    return resolveConfinedPath(input.outputDir, cwd, '输出目录', createError)
  }
  if (input.caseId !== undefined) {
    assertDeliverableName(input.caseId, '案卷号', createError)
    return resolve(cwd, caseOutputsDir(input.caseId))
  }
  return resolve(cwd, defaultOutputDir)
}
