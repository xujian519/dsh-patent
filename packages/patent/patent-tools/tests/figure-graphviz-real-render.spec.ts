import { readFileSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildBlockDiagramDOT, buildFlowchartDOT, getDiagramTemplate } from '../src/figure/dot-builder.ts'
import { DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS, findDot, renderWithGraphviz } from '../src/figure/graphviz-renderer.ts'
import { renderWithVizWasm } from '../src/figure/viz-wasm-renderer.ts'
import { annotateSvg } from '../src/figure/svg-annotate.ts'
import { annotateSvgWithLeaderLines } from '../src/figure/leader-line.ts'

/**
 * 真实 Graphviz 端到端 smoke：仅在本机装有 dot 时运行（无 dot 环境全组跳过）。
 * 走真实子进程（node:child_process 适配 SubprocessRuntime 接口），验证
 * DOT 构建 → dot CLI 渲染 → 真实 SVG 后处理标注的完整链路与中文渲染。
 *
 * CI（`.github/workflows/ci-fork.yml`）为这一类用例装了 `dot` 与 `Noto Sans CJK`，
 * 所以 CI 上不得再出现本文件的跳过；`figure-graphviz-ci-signal.spec.ts` 在 CI 上
 * 断言 `dot` 存在，删掉工作流里的安装步骤会变红而不是静默跳过。
 */

/** 无 Graphviz 时跳过整个 suite。 */
const hasDot = findDot() !== undefined

/** 用例显式声明的渲染预算（毫秒）；生产由宿主 Config.graphvizRenderTimeoutMs 解析后注入。 */
const TEST_RENDER_TIMEOUT_MS = DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS

/** 将 node:child_process.spawn 适配为 SubprocessRuntime（仅收集 stdout/stderr 与退出码）。 */
function realSubprocess(): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdoutBuf = ''
      let stderrBuf = ''
      child.stdout.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
      const stdinData = spec.stdio.stdin === 'ignore' ? '' : (spec.stdio.stdin as { data: string }).data
      child.stdin.end(stdinData)
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code, signal) => { resolve({ exitCode: code, signal }) })
      })
      spec.signal?.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: stdoutBuf, nextOffset: stdoutBuf.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderrBuf, nextOffset: stderrBuf.length, lossy: false }) },
        },
        done,
        terminate: () => { child.kill('SIGTERM') },
        waitForExit: () => Promise.resolve(true),
      }
    },
  } as SubprocessRuntime
}

const runtime = realSubprocess()
const outDir = mkdtempSync(join(tmpdir(), 'dsh-figreal-'))

/**
 * 中文字体：本文件只断言 SVG 结构与标签文本，字体族是输入而非断言目标，所以这里
 * 按平台取本机确实存在的字族——macOS 的系统中文族，Linux（含 CI 装的
 * `fonts-noto-cjk`）的 Noto CJK。写死 macOS 字族会让 Linux 上的 Graphviz 退回
 * 兜底字体并告警，等于把平台差异埋进这条唯一的真实渲染链路。
 */
const CJK_FONT = process.platform === 'darwin' ? 'PingFang SC' : 'Noto Sans CJK SC'

describe.skipIf(!hasDot)('real Graphviz rendering (needs `dot` installed)', () => {
  it('renders a CJK block diagram to SVG in grayscale mode', async () => {
    const result = await renderWithGraphviz(runtime, {
      dot: buildBlockDiagramDOT(
        [
          { id: 'sensor', label: '温度传感器', type: 'input' },
          { id: 'ctrl', label: '控制单元', type: 'process' },
          { id: 'out', label: '显示装置', type: 'output' },
        ],
        [
          { from: 'sensor', to: 'ctrl', label: '信号' },
          { from: 'ctrl', to: 'out', label: '结果' },
        ],
        { figureNumber: 1, fontName: CJK_FONT },
      ),
      filename: 'cjk_block',
      format: 'svg',
      engine: 'dot',
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result.ok).toBe(true)
    const svg = readFileSync((result as { ok: true; path: string }).path, 'utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('温度传感器 (100)')
    expect(svg).not.toContain('fillcolor')
    // 防回退：图号只属于文件名与附图说明，绝不烧进像素；grayscale 不得出现 semantic 彩色填充。
    expect(svg).not.toContain('图1')
    expect(svg).not.toContain('fill="light')
    expect(statSync((result as { ok: true; path: string }).path).size).toBeGreaterThan(1000)
  })

  it('renders semantic color fills and a flowchart with labeled decision edges', async () => {
    const colored = await renderWithGraphviz(runtime, {
      dot: buildBlockDiagramDOT(
        [
          { id: 'in', label: '输入', type: 'input' },
          { id: 'cpu', label: '处理', type: 'process' },
        ],
        [{ from: 'in', to: 'cpu', label: '数据' }],
        { figureNumber: 2, style: 'semantic', fontName: CJK_FONT },
      ),
      filename: 'semantic',
      format: 'svg',
      engine: 'dot',
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(colored.ok).toBe(true)
    expect(readFileSync((colored as { ok: true; path: string }).path, 'utf8')).toContain('fill="lightyellow"')

    const flow = await renderWithGraphviz(runtime, {
      dot: buildFlowchartDOT(
        [
          { id: 's', label: '开始', shape: 'ellipse', next: ['d'] },
          { id: 'd', label: '数据有效？', shape: 'diamond', next: [{ id: 't', label: '是' }, { id: 'f', label: '否' }] },
          { id: 't', label: '处理', next: ['e'] },
          { id: 'f', label: '校验失败', next: ['e'] },
          { id: 'e', label: '结束', shape: 'ellipse', next: [] },
        ],
        { figureNumber: 3, fontName: CJK_FONT },
      ),
      filename: 'flow',
      format: 'png',
      engine: 'dot',
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(flow.ok).toBe(true)
    expect(statSync((flow as { ok: true; path: string }).path).size).toBeGreaterThan(1000)
  })

  it('renders the method_steps template (fixed 101-105 numerals) as PDF', async () => {
    const result = await renderWithGraphviz(runtime, {
      dot: getDiagramTemplate('method_steps', { fontName: CJK_FONT }),
      filename: 'method',
      format: 'pdf',
      engine: 'dot',
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result.ok).toBe(true)
    expect(statSync((result as { ok: true; path: string }).path).size).toBeGreaterThan(500)
  })

  it('annotates a real Graphviz SVG (tspan structure) with reference numerals', async () => {
    const result = await renderWithGraphviz(runtime, {
      dot: buildBlockDiagramDOT(
        [
          { id: 'dev', label: '传感器', type: 'input' },
          { id: 'cpu', label: '处理器', type: 'process' },
        ],
        [],
        { figureNumber: 5, fontName: CJK_FONT },
      ),
      filename: 'annotate_src',
      format: 'svg',
      engine: 'dot',
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result.ok).toBe(true)
    const sourcePath = (result as { ok: true; path: string }).path
    const annotated = annotateSvg(readFileSync(sourcePath, 'utf8'), [
      { label: '传感器', numeral: '20' },
      { label: '处理器', numeral: '30' },
    ])
    // 重标注替换图内既有标号，而不是叠加成「(500) (20)」。
    expect(annotated.svg).toContain('传感器 (20)')
    expect(annotated.svg).toContain('处理器 (30)')
    expect(annotated.svg).not.toContain('(500)')
    expect(annotated.svg).not.toContain('(502)')
    expect(annotated.warnings).toEqual([])
  })

  it('rejects a non-existent executable with install guidance (engine error path)', async () => {
    const result = await renderWithGraphviz(runtime, {
      dot: 'digraph G { a -> b; }',
      filename: 'nope',
      format: 'svg',
      engine: 'dot',
      outputDir: outDir,
    }, { executable: join(tmpdir(), 'no-such-dot-binary'), renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    expect(result).toMatchObject({ ok: false, code: 'not_installed' })
  }, 20_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })
})

/** 内置 WASM 引擎可用性（随依赖打包，正常恒可用；资产损坏时整组跳过）。 */
const vizAvailable = await import('@viz-js/viz')
  .then(async (module) => { await module.instance(); return true })
  .catch(() => false)

describe.skipIf(!vizAvailable)('real WASM rendering (bundled @viz-js/viz, no `dot` binary needed)', () => {
  // 独立临时目录：上方 CLI describe 的 afterAll 会删除它自己的 outDir。
  const wasmOutDir = mkdtempSync(join(tmpdir(), 'dsh-figwasm-'))
  it('renders a CJK block diagram to SVG through the bundled engine and annotates it', async () => {
    const outcome = await renderWithVizWasm({
      dot: buildBlockDiagramDOT(
        [
          { id: 'sensor', label: '温度传感器', type: 'input' },
          { id: 'ctrl', label: '控制单元', type: 'process' },
          { id: 'out', label: '显示装置', type: 'output' },
        ],
        [
          { from: 'sensor', to: 'ctrl', label: '信号' },
          { from: 'ctrl', to: 'out', label: '结果' },
        ],
        { figureNumber: 1, fontName: CJK_FONT },
      ),
      filename: 'wasm_cjk_block',
      format: 'svg',
      engine: 'dot',
      outputDir: wasmOutDir,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const svg = readFileSync(outcome.path, 'utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('温度传感器 (100)')
    // 防回退（WASM 路径同 CLI）：图号不烧进像素；grayscale 不得出现 semantic 彩色填充。
    expect(svg).not.toContain('图1')
    expect(svg).not.toContain('fill="light')
    expect(statSync(outcome.path).size).toBeGreaterThan(1000)
    // 与 CLI 渲染同一链路：SVG 后处理标注在 WASM 输出上同样可用（Phase 0：两引擎结构一致）。
    const annotated = annotateSvg(svg, [
      { label: '控制单元', numeral: '20' },
    ])
    // 生成时写入的 (102) 被本次标注替换，不叠加。
    expect(annotated.svg).toContain('控制单元 (20)')
    expect(annotated.svg).not.toContain('(102)')
    expect(annotated.warnings).toEqual([])
  })

  it('draws leader-line numerals on a real WASM-rendered figure (embedNumerals:false pipeline)', async () => {
    const outcome = await renderWithVizWasm({
      dot: buildBlockDiagramDOT(
        [
          { id: 'sensor', label: '温度传感器', type: 'input' },
          { id: 'ctrl', label: '控制单元', type: 'process' },
        ],
        [{ from: 'sensor', to: 'ctrl', label: '信号' }],
        { figureNumber: 1, fontName: CJK_FONT, embedNumerals: false },
      ),
      filename: 'wasm_leader_block',
      format: 'svg',
      engine: 'dot',
      outputDir: wasmOutDir,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const annotated = annotateSvgWithLeaderLines(readFileSync(outcome.path, 'utf8'), [
      { label: '温度传感器', numeral: '100' },
      { label: '控制单元', numeral: '102' },
    ])
    expect(annotated.svg).toContain('<line ')
    expect(annotated.svg).toContain('>100</text>')
    expect(annotated.svg).toContain('>102</text>')
    expect(annotated.svg).toContain('>温度传感器<')
    expect(annotated.svg).not.toContain('(100)')
    // 无内嵌/未命中退化即为成功；裸 DOT 画布紧凑，为容纳图外标号而扩边会触发 B3 告警，不属退化。
    expect(annotated.warnings.filter(w => w.includes('已内嵌') || w.includes('未命中'))).toEqual([])
  })

  afterAll(() => {
    rmSync(wasmOutDir, { recursive: true, force: true })
  })
})
