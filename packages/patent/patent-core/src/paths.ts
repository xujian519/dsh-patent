/**
 * 专利域路径约定与模型可控路径的越界防护（单一事实源）。
 *
 * 此前 worker-contract 的 `data/cases/{caseId}/outputs` 与 patentWorkflowTool 的
 * `data/cases/{caseId}/workflow-runs` 两处各自维护字面量，靠注释"对齐"——
 * 本模块统一推导，避免路径约定漂移。两个文书工具也共用这里的真实路径归一化
 * 与工作目录包含性校验，避免两处各写一份判定。
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
 * 解析文件路径的真实形态，允许文件本身尚不存在。
 *
 * 对不存在的输出文件无法直接 realpath，因此对第一个存在的祖先目录做
 * realpath，再拼回缺失的路径段；这样 `./`、`../` 与 symlink 别名会归一到
 * 同一个值，同文件守卫与包含性校验才能可靠比较。
 * @param path - 待归一化的路径。
 * @returns 归一化后的绝对路径。
 */
export function resolveRealPath(path: string): string {
  const abs = resolve(path)
  let dir = dirname(abs)
  let suffix = basename(abs)
  // 每轮上移一层，必然终止于存在的根目录。
  while (!existsSync(dir)) {
    suffix = join(basename(dir), suffix)
    dir = dirname(dir)
  }
  return join(realpathSync(dir), suffix)
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
