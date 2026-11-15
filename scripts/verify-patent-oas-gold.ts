/**
 * 无 key 门禁:把 `patent-oas` 金标与它的问题空间 DAG、门槛策略钉在一起。
 *
 * 判定四件事:
 *   1. 金标与 DAG 互相钉住(rubric 维度全部有映射、映射权重等于满分、节点都有观测面、
 *      先决边无环);
 *   2. 门槛策略可满足(金标摘要已记录且相符、门槛取值合法、每条已落盘的基线自身不低于门槛);
 *   3. 若给出 run 记录(`--run <path>`),按门槛判定它是否回退,失败按节点归因;
 *   4. `corpus/` 里的公开授权文本按清单件数登记,每件有公开号、来源网址和正的附图幅数,
 *      没有 rubric,客户文稿与代理师改稿不入库。`--write` 与 `--accept` 也先过这一关。
 *
 * 基线未记录时第三件事无从判定:门禁以非 0 退出并打印记录基线的命令,而不是静默通过。
 * 「休眠」与「通过」必须在退出码上分开,否则「有脚本 + `verify-*` 命名 + exit 0」会被
 * 读成已接线,而它其实一次也没比对过。
 *
 * `--accept` 与 `--run` 按记录自己的被测面(`execution` + `workflowId`)在 `gate.yaml` 的
 * `baselines` 里找对应基线:没有声明该被测面时拒绝落基线,并打印要追加的条目,而不是猜一个
 * 路径写进去。提示词设置与工作流设置各有一条基线,各自满足门槛。
 *
 * 用法:
 *   tsx scripts/verify-patent-oas-gold.ts [--run <run.json>]
 *   tsx scripts/verify-patent-oas-gold.ts --accept <run.json>
 *   tsx scripts/verify-patent-oas-gold.ts --write
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  GATE_FILE,
  PATENT_OAS_EXAMPLE_DIR,
  PROBLEM_SPACE_FILE,
  baselineDeclarationFor,
  comparisonSettingProblems,
  evaluateRun,
  executionOf,
  formatVerdict,
  goldDigest,
  isOutsideRoot,
  loadBaselineRecord,
  loadGateConfig,
  loadGold,
  loadProblemSpace,
  loadRunRecord,
  surfaceOf,
  validateGateConfig,
  validateProblemSpace,
  validateRunRecord,
  verdictPassed,
  type DeclaredBaseline,
  type GateConfig,
  type GoldCase,
  type ProblemSpace,
  type RunRecord,
} from './patent-oas-gate-core.ts'
import { loadPublicGrantCorpus } from './patent-oas-corpus.ts'

const root = resolve(import.meta.dirname, '..')
const exampleDir = resolve(root, PATENT_OAS_EXAMPLE_DIR)
const gatePath = resolve(root, GATE_FILE)
const problemSpacePath = resolve(root, PROBLEM_SPACE_FILE)

/**
 * 用当前金标重录 gate.yaml 的 goldDigest 行,保留文件其余内容与注释。
 *
 * @param cases 当前金标 case 集。
 */
async function writeGoldDigest(cases: readonly GoldCase[]): Promise<void> {
  const digest = goldDigest(cases)
  const text = await readFile(gatePath, 'utf8')
  if (!/^goldDigest:/mu.test(text)) throw new Error(`${GATE_FILE}: 没有 goldDigest 行可重录`)
  await writeFile(gatePath, text.replace(/^goldDigest:.*$/mu, `goldDigest: "${digest}"`), 'utf8')
  console.log(`verify-patent-oas-gold: 已重录 goldDigest ${digest}`)
}

/**
 * 解析一个需要路径参数的命令行开关。
 *
 * @param args 命令行参数。
 * @param flag 开关名,如 `--run`。
 * @returns 记录内容与诊断标签;未给出该开关时返回 undefined。
 */
async function readRecordFlag(args: string[], flag: string): Promise<{ run: RunRecord; label: string; path: string } | undefined> {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${flag} 需要一个 run 记录路径`)
  const path = resolve(process.cwd(), value)
  return { run: await loadRunRecord(path), label: value, path }
}

/**
 * 读出 `gate.yaml` 声明的每条基线;尚未落盘的条目 `record` 省略,由调用方决定放行与否。
 *
 * @param config 门禁策略。
 * @returns 每条声明及其记录。
 */
async function declaredBaselines(config: GateConfig): Promise<DeclaredBaseline[]> {
  const entries: DeclaredBaseline[] = []
  for (const declaration of config.baselines) {
    const record = await loadBaselineRecord(resolve(root, declaration.path))
    entries.push({ declaration, label: declaration.path, ...record === undefined ? {} : { record } })
  }
  return entries
}

/**
 * 说明某个被测面还没有在 `gate.yaml` 声明基线,并给出要追加的条目。
 *
 * @param record 待落基线或待判定的记录。
 * @returns 一条问题文本。
 */
export function undeclaredSurfaceProblem(record: RunRecord): string {
  const declaration = {
    execution: executionOf(record),
    ...(record.workflowId === undefined ? {} : { workflowId: record.workflowId }),
    path: '<相对仓库根的基线路径>',
  }
  return `gate.yaml 的 baselines 没有声明被测面 ${surfaceOf(record)} 的基线;追加一条 ${JSON.stringify(declaration)} 后再落基线或比对`
}

/**
 * 解析 `--accept` 的落盘目标:按记录自己的被测面取声明的路径。
 *
 * 找不到声明,或声明的路径落在仓库外时打印问题并返回 undefined——把基线写到别的被测面的
 * 文件上,等于用一条设置的读数去判另一条设置。
 *
 * @param config 门禁策略。
 * @param record 待提升的记录。
 * @returns 基线目标绝对路径;该被测面无法落基线时为 undefined。
 */
export function acceptTarget(config: GateConfig, record: RunRecord): string | undefined {
  const declaration = baselineDeclarationFor(config, record)
  if (declaration === undefined) {
    console.error(`verify-patent-oas-gold: ${undeclaredSurfaceProblem(record)}`)
    return undefined
  }
  if (isOutsideRoot(root, declaration.path)) {
    console.error(`verify-patent-oas-gold: gate.yaml 为 ${surfaceOf(declaration)} 声明的基线路径 "${declaration.path}" 落在仓库之外,拒绝落基线`)
    return undefined
  }
  return resolve(root, declaration.path)
}

/**
 * 把一次实测记录提升为基线:先校验维度、检索环境、被测面与门槛,分数不达下限就拒绝落盘。
 *
 * 拒绝而不是照抄,是因为低于门槛的基线会让门禁此后永远红——那种门禁比没有门禁更糟。
 *
 * @param record 待提升的记录。
 * @param gold 金标 case 集。
 * @param space 问题空间 DAG。
 * @param config 门禁策略。
 * @param baselineTarget 基线目标绝对路径。
 * @returns 写入完成时解决;记录未通过校验时抛错。
 */
export async function acceptBaseline(
  record: { run: RunRecord; label: string; path: string },
  gold: readonly GoldCase[],
  space: ProblemSpace,
  config: GateConfig,
  baselineTarget: string,
): Promise<void> {
  const problems = [
    ...validateProblemSpace(space, gold),
    ...validateGateConfig(config, space, gold, []),
    ...validateRunRecord(record.run, space, gold, record.label),
    ...record.run.cases
      .filter(runCase => runCase.retrieval === undefined)
      .map(runCase => `${record.label}: case "${runCase.caseId}" 未记录检索环境,不能落为基线`),
    ...(record.run.execution === undefined
      ? [`${record.label}: 未记录被测面(execution),不能落为基线`]
      : []),
  ]
  const verdict = evaluateRun(space, config, record.run, undefined)
  for (const outcome of verdict.nodes) {
    if (outcome.verdict !== 'pass') problems.push(`${record.label}: 节点 "${outcome.id}" ${outcome.verdict}(分数 ${outcome.score})`)
  }
  for (const outcome of verdict.cases) {
    if (outcome.verdict !== 'pass') problems.push(`${record.label}: case "${outcome.id}" ${outcome.verdict}(分数 ${outcome.score})`)
  }
  if (verdict.aggregateVerdict !== 'pass') {
    problems.push(`${record.label}: 聚合判定 ${verdict.aggregateVerdict}(分数 ${verdict.aggregateScore})`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-patent-oas-gold: ${problem}`)
    throw new Error(`拒绝把 ${record.label} 提升为基线`)
  }
  await mkdir(dirname(baselineTarget), { recursive: true })
  await copyFile(record.path, baselineTarget)
  console.log(`verify-patent-oas-gold: 已把 ${record.label} 落为基线(${baselineTarget},聚合 ${verdict.aggregateScore.toFixed(2)})`)
}

/**
 * 运行门禁的默认动作,或按 `--write` / `--accept` / `--run` 走对应分支。
 *
 * @param args 命令行参数(不含 `node` 与脚本路径)。
 * @returns 进程退出码;`--run` 的记录未过门槛,或基线未记录而无 `--accept` 时为 1。
 */
export async function main(args: string[]): Promise<number> {
  const corpus = await loadPublicGrantCorpus(resolve(exampleDir, 'corpus'))
  if (corpus.problems.length > 0) {
    for (const problem of corpus.problems) console.error(`verify-patent-oas-gold: ${problem}`)
    return 1
  }
  console.log(
    `verify-patent-oas-gold: 公开授权文本 ${corpus.grants} 件，附图合计 ${corpus.figures} 幅；代理师改稿 ${corpus.attorneyRevisions}/${corpus.plannedAttorneyRevisions}，未入库。`,
  )

  const gold = await loadGold(exampleDir)
  const space = await loadProblemSpace(problemSpacePath)
  const config = await loadGateConfig(gatePath)

  if (args.includes('--write')) {
    await writeGoldDigest(gold)
    return 0
  }

  const accepted = await readRecordFlag(args, '--accept')
  if (accepted !== undefined) {
    const baselineTarget = acceptTarget(config, accepted.run)
    if (baselineTarget === undefined) return 1
    await acceptBaseline(accepted, gold, space, config, baselineTarget)
    return 0
  }

  const baselines = await declaredBaselines(config)
  const flaggedRun = await readRecordFlag(args, '--run')
  const runDeclaration = flaggedRun === undefined ? undefined : baselineDeclarationFor(config, flaggedRun.run)
  const runBaseline = flaggedRun === undefined || runDeclaration === undefined
    ? undefined
    : baselines.find(entry => entry.declaration === runDeclaration)?.record
  const problems = [
    ...validateProblemSpace(space, gold),
    ...validateGateConfig(config, space, gold, baselines),
    ...flaggedRun === undefined || runDeclaration !== undefined
      ? []
      : [undeclaredSurfaceProblem(flaggedRun.run)],
    ...flaggedRun === undefined ? [] : validateRunRecord(flaggedRun.run, space, gold, flaggedRun.label),
    ...flaggedRun === undefined || runBaseline === undefined
      ? []
      : comparisonSettingProblems(flaggedRun.run, runBaseline, flaggedRun.label),
  ]
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-patent-oas-gold: ${problem}`)
    return 1
  }

  const domains = new Map<string, number>()
  for (const node of Object.values(space.nodes)) domains.set(node.domain, (domains.get(node.domain) ?? 0) + 1)
  const domainSummary = [...domains].map(([domain, count]) => `${domain}:${count}`).join(' ')
  console.log(
    `verify-patent-oas-gold: DAG ${Object.keys(space.nodes).length} 节点 / ${gold.length} case(${domainSummary});node minScore=${config.thresholds.node.minScore} maxDrop=${config.thresholds.node.maxDrop},case minScore=${config.thresholds.case.minScore},aggregate minScore=${config.thresholds.aggregate.minScore}`,
  )
  if (flaggedRun !== undefined) {
    // 无基线时 evaluateRun 只按绝对下限判定,低于下限的记录仍要在此报出并归因。
    const verdict = evaluateRun(space, config, flaggedRun.run, runBaseline)
    console.log(formatVerdict(verdict))
    if (!verdictPassed(verdict)) {
      console.error(`verify-patent-oas-gold: ${flaggedRun.label} 未通过门槛`)
      return 1
    }
  }
  const missing = baselines.filter(entry => entry.record === undefined)
  for (const entry of missing) {
    console.error(
      `verify-patent-oas-gold: ${surfaceOf(entry.declaration)} 的基线未记录(${entry.label});回归层无从比对,本门禁不放行。`
      + `先跑 \`pnpm run gate:patent-oas -- --execution ${entry.declaration.execution}\` 采集该设置的实测`
      + '(用 `--case` 收窄到声明了该 manifest 的 case),再按它打印的 `--accept <run.json>` 落基线。',
    )
  }
  if (missing.length > 0) return 1
  console.log(
    `verify-patent-oas-gold: 基线已记录 ${baselines
      .map(entry => `${surfaceOf(entry.declaration)}=${entry.record?.recordedAt ?? '未知'}`)
      .join(', ')};各基线自身满足门槛。`,
  )
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`verify-patent-oas-gold: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  })
}
