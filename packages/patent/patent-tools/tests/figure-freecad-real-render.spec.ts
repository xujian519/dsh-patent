import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_FREECAD_PROBE_TIMEOUT_MS,
  DEFAULT_FREECAD_RENDER_TIMEOUT_MS,
  findFreeCadCmd,
  probeFreeCad,
  renderSectionGeometry,
  renderSectionHatch,
  renderStructureViews,
} from '../src/figure/freecad-renderer.ts'
import { resolveHatchPattern } from '../src/figure/freecad-hatch-geometry.ts'
import { HATCH_GEOMETRY_FILENAME, HATCH_PAT_FILENAME, buildHatchScript } from '../src/figure/freecad-hatch-script.ts'
import { resolveSectionFrame, type SectionRing } from '../src/figure/freecad-section-geometry.ts'
import { SECTION_GEOMETRY_FILENAME, buildSectionScript } from '../src/figure/freecad-section-script.ts'
import { structureSvgFilename } from '../src/figure/freecad-structure-script.ts'
import { createGenerateStructureFigureTool } from '../src/tool/generate-structure-figure.ts'
import { applyStructureLineStyle } from '../src/figure/structure-svg-postprocess.ts'
import { measureInkBounds } from '../src/figure/render-check.ts'
import { expandSectionSource, SectionSourceError, type SectionSourcePorts } from '../src/figure/section-source.ts'
import { buildVectorFigure } from '../src/figure/vector-figure-build.ts'
import type { SectionFigureJson } from '../src/figure/vector-figure-build.ts'
import { vectorFigureSvg } from '../src/figure/vector-figure.ts'
import { checkFigureRendering } from '../src/figure/render-check.ts'

/**
 * 真实 FreeCAD 端到端 smoke：仅在本机装有 freecadcmd 时运行（无 FreeCAD 环境
 * 整组跳过）。走真实子进程（node:child_process 适配 SubprocessRuntime 接口），
 * 验证签入 STEP fixture → TechDraw 多视图投影 → 黑白线稿 SVG + manifest +
 * 件号锚定的完整链路。
 *
 * fixture 由 generate-structure-fixture.py 生成并签入（外部审查教训：fixture
 * 头部签名必须与生成器一致）；下方头部断言测试不依赖 FreeCAD，恒运行。
 *
 * CI 信号由 `.github/workflows/ci-fork.yml` 的 `node-cad-render` job 提供：
 * `scripts/prepare-ci-cad.sh` 解包固定版本的官方 AppImage（Ubuntu 自带的 FreeCAD
 * 低于渲染器使用的 1.1 API），并用 `--require-zero` 拒绝任何跳过。单元与覆盖率
 * lane 不装 FreeCAD，这一组在那里仍然整组跳过。
 */

/** 用例显式声明的渲染预算（毫秒）；生产由宿主 Config.freecadRenderTimeoutMs 解析后注入。 */
const TEST_RENDER_TIMEOUT_MS = DEFAULT_FREECAD_RENDER_TIMEOUT_MS

/**
 * 两条「陷阱」用例直接跑 freecadcmd 的同步预算：它们等待的是崩溃或失败，
 * 不等待正常渲染。超时用来兜住「挂起而不是崩溃」的 FreeCAD 构建。
 */
const FREECAD_TRAP_TIMEOUT_MS = 15_000

/** 用例显式声明的探测预算（毫秒）；宿主插件不探测 freecadcmd，无对应 Config 字段。 */
const TEST_PROBE_TIMEOUT_MS = DEFAULT_FREECAD_PROBE_TIMEOUT_MS

/** 无 FreeCAD 时跳过端到端 suite。 */
const hasFreeCad = findFreeCadCmd() !== undefined

const FIXTURE = join(import.meta.dirname, 'fixtures', 'structure-bracket.step')

/**
 * 装配体的第二个零件（见 generate-structure-pin-fixture.py）：r3 h40 的圆柱销，
 * 轴线在 x=30 —— 在底板 x 范围（±20）之外，故两件同图的投影必然比单件更宽。
 */
const PIN_FIXTURE = join(import.meta.dirname, 'fixtures', 'structure-pin.step')

/** 剖切几何的 fixture：60×30×8 的板，两个 r5 通孔位于 x = ±15（见 generate-section-fixture.py）。 */
const SECTION_FIXTURE = join(import.meta.dirname, 'fixtures', 'section-holes-plate.step')

/**
 * 抽出 SVG 里所有 `<path>` 的绘制点（`M`/`L`/`C`/`Q` 取坐标对，`A` 取终点）。
 * 只用于量投影方向：TechDraw 片段是纯折线/曲线路径，不含 transform。
 * @param svg - the rendered view SVG.
 * @returns every drawn coordinate pair, in file order.
 */
function drawnPoints(svg: string): [number, number][] {
  const points: [number, number][] = []
  for (const match of svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    for (const [, command, body] of match[1]!.matchAll(/([MLAQC])\s*([^MLAQC]*)/g)) {
      const numbers = [...body!.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)].map(m => Number(m[0]))
      if (command === 'A') {
        if (numbers.length >= 2) points.push([numbers[numbers.length - 2]!, numbers[numbers.length - 1]!])
        continue
      }
      for (let index = 0; index + 1 < numbers.length; index += 2) {
        points.push([numbers[index]!, numbers[index + 1]!])
      }
    }
  }
  return points
}

/** 剖切 fixture 的解析几何：外环 60×30、孔半径 5、板厚 8。 */
const SECTION_PLATE_WIDTH_MM = 60
const SECTION_PLATE_DEPTH_MM = 30
const SECTION_PLATE_HEIGHT_MM = 8
const SECTION_HOLE_RADIUS_MM = 5
const SECTION_HOLE_CENTERS_MM = [-15, 15]

/** 将 node:child_process.spawn 适配为 SubprocessRuntime（透传 env，仅收集 stdout/stderr 与退出码）。 */
function realSubprocess(): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spec.env === undefined ? process.env : { ...process.env, ...spec.env },
      })
      let stdoutBuf = ''
      let stderrBuf = ''
      child.stdout.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })
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

describe('STEP fixture 头部签名（与 generate-structure-fixture.py 生成器一致性）', () => {
  it('签入的 structure-bracket.step 是 FreeCAD 导出的 ISO-10303-21 STEP', () => {
    const head = readFileSync(FIXTURE, 'utf8').slice(0, 512)
    expect(head.startsWith('ISO-10303-21;')).toBe(true)
    expect(head).toContain('HEADER;')
    // 生成器签名：fixture 只能由 FreeCAD（Open CASCADE STEP processor）导出；
    // 改动生成脚本时必须重跑 freecadcmd generate-structure-fixture.py 并复核。
    expect(head).toContain('FreeCAD')
    expect(head).toContain('Open CASCADE STEP processor')
  })

  it('签入的 structure-pin.step 是 FreeCAD 导出的 ISO-10303-21 STEP', () => {
    const head = readFileSync(PIN_FIXTURE, 'utf8').slice(0, 512)
    expect(head.startsWith('ISO-10303-21;')).toBe(true)
    expect(head).toContain('HEADER;')
    // 同一条生成器签名要求：改动 generate-structure-pin-fixture.py 时必须重跑并复核。
    expect(head).toContain('FreeCAD')
    expect(head).toContain('Open CASCADE STEP processor')
  })
})

describe.skipIf(!hasFreeCad)('real FreeCAD structure rendering (needs `freecadcmd` installed)', () => {
  const runtime = realSubprocess()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-freecadreal-'))

  it('probe 报告就绪与版本号', async () => {
    const result = await probeFreeCad(runtime, { probeTimeoutMs: TEST_PROBE_TIMEOUT_MS })
    expect(result.ready).toBe(true)
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/)
  }, 30_000)

  it('把签入 fixture 投影为 iso+front 黑白线稿并锚定件号', async () => {
    const result = await renderStructureViews(runtime, {
      modelPaths: [FIXTURE],
      views: ['iso', 'front'],
      scale: 1,
      showHidden: false,
      callouts: [
        { numeral: '100', point3d: [0, 0, 24], label: '立柱' },
        { numeral: '102', point3d: [20, -12, 8], label: '底板' },
      ],
      figureNumber: 1,
      outputDir: outDir,
    }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
    // 这条成功断言就是 TransientDir 锚定的端到端保护：缓存目录不可写的沙箱（DSH 默认
    // workspace-write）下，旧行为会让 TechDraw 把模板拷到根目录（/）而整次渲染失败。
    // 锚定本身由 figure-freecad-structure-script.spec.ts 断言——文档关闭时 FreeCAD 会
    // 清掉 TransientDir，进程结束后无法在磁盘上复核那次拷贝。
    expect(result).toEqual({ ok: true, manifestPath: join(outDir, 'manifest.json') })
    if (!result.ok) return

    // manifest：视图顺序/文件名/包围盒/件号锚点齐备。
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      figureNumber: number
      modelPaths: string[]
      generator: string
      views: {
        name: string
        order: number
        path: string
        bbox: number[]
        anchors: { numeral: string; label: string; model: number | null; modelPath: string | null; point3d: number[]; point2d: number[] }[]
      }[]
    }
    expect(manifest.figureNumber).toBe(1)
    expect(manifest.modelPaths).toEqual([FIXTURE])
    expect(manifest.generator).toBe('freecad-structure')
    expect(manifest.views.map(v => v.name)).toEqual(['iso', 'front'])
    expect(manifest.views.map(v => v.order)).toEqual([0, 1])

    for (const view of manifest.views) {
      expect(view.path).toBe(join(outDir, structureSvgFilename(1, view.name as 'iso' | 'front')))
      const svg = readFileSync(view.path, 'utf8')
      // 真实投影几何 + 件号引线/数字文本。
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(svg).toContain('<path')
      expect(svg).toContain('>100</text>')
      expect(svg).toContain('>102</text>')
      expect(svg).toContain('<line ')
      // 黑白线稿：几何黑描边、无填充。
      expect(svg).toContain('stroke="#000000"')
      expect(svg).toContain('fill="none"')
      // 防回退（CNIPA 指南 4.3）：图号/标题/模板边框绝不烧进像素；无彩色。
      expect(svg).not.toContain('图1')
      expect(svg).not.toContain('297')
      expect(svg).not.toMatch(/stroke="#(?!000000)/)
      expect(svg).not.toMatch(/fill="#(?!000000|none)/)
      // 包围盒为正、部件尺寸量级正确（底板 40 宽 × 总高 24，含画布内边距 6×2）。
      const [minX, minY, width, height] = view.bbox as [number, number, number, number]
      expect(width).toBeGreaterThan(40)
      expect(height).toBeGreaterThan(24)
      expect(width).toBeLessThan(120)
      expect(height).toBeLessThan(120)
      // 件号锚点落在视图包围盒内（锚定到真实几何投影而非图外）。
      expect(view.anchors.map(a => a.numeral)).toEqual(['100', '102'])
      // 未声明归属的件号：归属记 null（脚本不核对，也不臆测它属于哪个零件）。
      expect(view.anchors.map(a => a.model)).toEqual([null, null])
      for (const anchor of view.anchors) {
        const [ax, ay] = anchor.point2d as [number, number]
        expect(ax).toBeGreaterThanOrEqual(minX)
        expect(ax).toBeLessThanOrEqual(minX + width)
        expect(ay).toBeGreaterThanOrEqual(minY)
        expect(ay).toBeLessThanOrEqual(minY + height)
      }
    }

    // 两个视图的投影几何确实不同（iso 与 front 不是同一份输出）。
    const iso = readFileSync(join(outDir, structureSvgFilename(1, 'iso')), 'utf8')
    const front = readFileSync(join(outDir, structureSvgFilename(1, 'front')), 'utf8')
    expect(iso).not.toBe(front)

    // 投影方向：正视图里 +z 朝上（圆柱立于底板之上）。fixture 的底板 z∈[0,8]、
    // 立圆柱 z∈[8,24]，投影紧致中心 C_y=12，故画布帧（y 向下，即 viewPartAsSvg
    // 片段自己的帧）里圆柱顶面在 y=-12、底板左右棱在 y∈[4,12]。脚本曾把片段整体
    // scale(1,-1)，整张图上下镜像：最上方几何会变成 40 毫米宽的底板下棱。
    const frontPoints = drawnPoints(front)
    expect(frontPoints.length).toBeGreaterThan(10)
    const topY = Math.min(...frontPoints.map(point => point[1]))
    expect(topY).toBeCloseTo(-12, 2)
    for (const [x, y] of frontPoints) {
      if (y < topY + 0.5) expect(Math.abs(x)).toBeLessThanOrEqual(7)
      if (Math.abs(x) > 19.5) expect(y).toBeGreaterThanOrEqual(3.9)
    }
    const postTop = manifest.views[1]!.anchors.find(anchor => anchor.numeral === '100')!
    // 件号与几何同帧：立柱顶（z=24）的锚点必须落在上面量到的顶面上。
    expect(postTop.point2d[0]).toBeCloseTo(0, 2)
    expect(postTop.point2d[1]).toBeCloseTo(topY, 2)
  }, 180_000)

  it('局部放大：窗口按模型坐标裁剪并放大，基视图画出窗口圆与标号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecaddetail-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE],
        views: ['front'],
        scale: 1,
        showHidden: false,
        callouts: [],
        // 以立圆柱与底板的交界 (0,0,8) 为圆心、半径 8 毫米的窗口，放大 2 倍。
        details: [{ base: 'front', center: [0, 0, 8], radiusMm: 8, scale: 2, reference: 'Ⅰ' }],
        figureNumber: 2,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result).toEqual({ ok: true, manifestPath: join(dir, 'manifest.json') })
      if (!result.ok) return

      type ManifestView = {
        name: string
        kind: string
        path: string
        base?: string
        center3d?: number[]
        radiusMm?: number
        scale?: number
        reference?: string
      }
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { views: ManifestView[] }
      expect(manifest.views.map(view => [view.name, view.kind])).toEqual([['front', 'view'], ['detail1', 'detail']])
      const detail = manifest.views[1]!
      // manifest 记下窗口口径：基视图、模型坐标圆心、半径、倍数、标号。
      expect(detail).toMatchObject({ base: 'front', center3d: [0, 0, 8], radiusMm: 8, scale: 2, reference: 'Ⅰ' })

      const points = drawnPoints(readFileSync(detail.path, 'utf8'))
      expect(points.length).toBeGreaterThan(10)
      // 裁到窗口内：半径 8×2=16 毫米；TechDraw 那圈边界（matting）圆实测比裁剪圆大 1%，即 16.16。
      for (const [x, y] of points) expect(Math.hypot(x, y)).toBeLessThanOrEqual(16.3)
      // 放大 2 倍：立圆柱直径 12 毫米在放大视图里是 24 毫米（两条侧影线落在 x=±12 且长度 >10）。
      for (const side of [-12, 12]) {
        const ys = points.filter(([x]) => Math.abs(x - side) < 0.05).map(([, y]) => y)
        expect(ys.length).toBeGreaterThan(0)
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10)
      }
      // 基视图上画出「放大部位」标记圆与标号：圆心是交界的投影（y = 12 − 8 = 4）。
      const baseSvg = readFileSync(manifest.views[0]!.path, 'utf8')
      expect(baseSvg).toContain('<circle cx="0" cy="4" r="8"')
      expect(baseSvg).toContain('>Ⅰ</text>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('装配体：两个零件文件投影成同一批视图，件号按归属零件记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadassembly-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE, PIN_FIXTURE],
        views: ['front'],
        scale: 1,
        showHidden: false,
        callouts: [
          { numeral: '100', point3d: [0, 0, 24], label: '立柱', model: 0 },
          { numeral: '200', point3d: [30, 0, 40], label: '圆柱销', model: 1 },
        ],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
        modelPaths: string[]
        views: {
          path: string
          bbox: number[]
          anchors: { numeral: string; model: number | null; modelPath: string | null; point2d: number[] }[]
        }[]
      }
      expect(manifest.modelPaths).toEqual([FIXTURE, PIN_FIXTURE])
      const view = manifest.views[0]
      expect(view).toBeDefined()
      if (view === undefined) return
      const svg = readFileSync(view.path, 'utf8')
      // 两个零件都在同一张图里：圆柱销的 x 到 33，front 视图宽度必然超过底板自身的 40 毫米。
      expect(svg).toContain('>100</text>')
      expect(svg).toContain('>200</text>')
      const [minX, , width] = view.bbox as [number, number, number, number]
      expect(width).toBeGreaterThan(55)
      // 归属随件号返回：下标 + 该零件的绝对路径，与 modelPaths 的下标口径一致。
      expect(view.anchors).toEqual([
        expect.objectContaining({ numeral: '100', model: 0, modelPath: FIXTURE }),
        expect.objectContaining({ numeral: '200', model: 1, modelPath: PIN_FIXTURE }),
      ])
      for (const anchor of view.anchors) {
        expect(anchor.point2d[0]).toBeGreaterThanOrEqual(minX)
        expect(anchor.point2d[0]).toBeLessThanOrEqual(minX + width)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('引线布局：标号避开别的零件与已放标号，不退回首选项', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadlabel-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE, PIN_FIXTURE],
        views: ['iso'],
        scale: 1,
        showHidden: false,
        callouts: [
          { numeral: '1', label: '立柱', model: 0 },
          { numeral: '2', label: '圆柱销', model: 1 },
        ],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
        views: { path: string; warnings?: string[] }[]
      }
      const view = manifest.views[0]
      expect(view).toBeDefined()
      if (view === undefined) return
      // 没有降级说明：两个标号都找到了既不压别的零件、也不压已放标号的位置。
      // 这条同时防住「候选生成退化成只剩首选方向」——那样第二个标号必然冲突。
      expect(view.warnings).toEqual([])
      // 标号与图线之间仍有可读净距：自动布局没有把它们贴到零件轮廓上。
      const report = checkFigureRendering(readFileSync(view.path, 'utf8'), { textClearanceMm: 1.5 })
      expect(report.findings.filter(finding => finding.check === 'text-clearance')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('自动锚点：省略 point3d 时在所属零件的真实顶点上选点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecdauto-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE, PIN_FIXTURE],
        views: ['front', 'iso'],
        scale: 1,
        showHidden: false,
        // 只声明归属，不给坐标：锚点由脚本在该零件上自动选。
        callouts: [
          { numeral: '100', label: '立柱', model: 0 },
          { numeral: '200', label: '圆柱销', model: 1 },
        ],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
        views: {
          name: string
          anchors: { numeral: string; model: number | null; point3d: number[]; point2d: number[] }[]
          parts?: { index: number; bbox3d: number[] }[]
        }[]
      }
      for (const view of manifest.views) {
        const parts = view.parts ?? []
        expect(view.anchors).toHaveLength(2)
        for (const anchor of view.anchors) {
          // 自动锚点必须真的选到某个 3D 点，而不是留空或落在原点。
          expect(anchor.point3d).toHaveLength(3)
          expect(anchor.point3d.some(value => value !== 0)).toBe(true)
          const part = parts.find(entry => entry.index === anchor.model)
          expect(part).toBeDefined()
          if (part === undefined) continue
          // 锚点落在所声明零件的 3D 包围盒内（顶点本就属于该零件，容差覆盖数值误差）。
          const [x, y, z, lengthX, lengthY, lengthZ] = part.bbox3d as [number, number, number, number, number, number]
          const [px, py, pz] = anchor.point3d as [number, number, number]
          expect(px).toBeGreaterThanOrEqual(x - 0.5)
          expect(px).toBeLessThanOrEqual(x + lengthX + 0.5)
          expect(py).toBeGreaterThanOrEqual(y - 0.5)
          expect(py).toBeLessThanOrEqual(y + lengthY + 0.5)
          expect(pz).toBeGreaterThanOrEqual(z - 0.5)
          expect(pz).toBeLessThanOrEqual(z + lengthZ + 0.5)
        }
      }
      // 选点以首个视图为准：同一件号在其余视图锚定的是同一个 3D 点。
      const first = manifest.views[0]?.anchors.map(anchor => anchor.point3d)
      const second = manifest.views[1]?.anchors.map(anchor => anchor.point3d)
      expect(second).toEqual(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('装配体：manifest 带每零件投影占位，落点与件号同帧', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadparts-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE, PIN_FIXTURE],
        views: ['front'],
        scale: 1,
        showHidden: false,
        callouts: [],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
        views: { bbox: number[]; parts?: { index: number; bbox3d: number[]; volume: number; bounds: number[] | null }[] }[]
      }
      const view = manifest.views[0]
      expect(view).toBeDefined()
      if (view === undefined) return
      const parts = view.parts
      // 每零件一条，下标与 modelPaths 同序——引线布局判「压到别的零件」就靠这份占位。
      expect(parts).toHaveLength(2)
      expect(parts?.map(part => part.index)).toEqual([0, 1])
      for (const part of parts ?? []) {
        expect(part.bbox3d).toHaveLength(6)
        expect(part.volume).toBeGreaterThan(0)
        expect(part.bounds).toHaveLength(4)
        // 占位是画布帧坐标：必须落在视图包围盒内（视图框已含内边距，故不会贴着边）。
        const [boxX, boxY, boxWidth, boxHeight] = view.bbox as [number, number, number, number]
        const [x, y, width, height] = part.bounds as [number, number, number, number]
        expect(x).toBeGreaterThanOrEqual(boxX)
        expect(y).toBeGreaterThanOrEqual(boxY)
        expect(x + width).toBeLessThanOrEqual(boxX + boxWidth)
        expect(y + height).toBeLessThanOrEqual(boxY + boxHeight)
      }
      // 两个零件在正视图里位置不同：合并成一个框就说明逐零件取样没生效。
      expect(parts?.[0]?.bounds).not.toEqual(parts?.[1]?.bounds)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('工具端到端：model_paths 走真实渲染出装配图，件号归属随结果返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadtool16-'))
    try {
      // 工具层到脚本的整条链：工具解析 model_paths → 渲染器 → 脚本一次投影两个零件。
      // 单测里的渲染是 mock，这里用本机 FreeCAD 跑真几何，故「多文件一起投影」不只是形状断言。
      const tool = createGenerateStructureFigureTool({
        render: spec => renderStructureViews(runtime, spec, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }),
        enabled: true,
        outputDir: dir,
        cwd: dir,
      })
      const result = await tool.execute({
        model_paths: [FIXTURE, PIN_FIXTURE],
        views: ['front'],
        callouts: [
          { numeral: '100', point3d: [0, 0, 24], label: '立柱', model: 0 },
          { numeral: '200', point3d: [30, 0, 40], label: '圆柱销', model: 1 },
        ],
        persist_index: false,
      }, { signal: new AbortController().signal } as never) as {
        figures: {
          modelPaths: string[]
          paths: string[]
          manifest: { views: { anchors: { numeral: string; model: number | null }[] }[] }
        }[]
        numeralMap: { numeral: string; label: string }[]
        indexed: boolean
      }
      expect(result.figures).toHaveLength(1)
      expect(result.figures[0]?.modelPaths).toEqual([FIXTURE, PIN_FIXTURE])
      expect(result.figures[0]?.manifest.views[0]?.anchors.map(a => [a.numeral, a.model])).toEqual([['100', 0], ['200', 1]])
      expect(result.numeralMap.map(m => `${m.numeral}-${m.label}`)).toEqual(['100-立柱', '200-圆柱销'])
      expect(result.indexed).toBe(false)
      const svg = readFileSync(join(dir, 'fig1', 'fig1_front.svg'), 'utf8')
      expect(svg).toContain('>200</text>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('件号归属核对用真实几何：锚点离所声明的零件多远就报多远', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadowner-'))
    try {
      // 圆柱销轴线上一点 (30, 0, 5) 声明为属于底板（model 0）：底板 x 只到 20，故实际偏离 10 毫米。
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE, PIN_FIXTURE],
        views: ['front'],
        scale: 1,
        showHidden: false,
        callouts: [{ numeral: '200', point3d: [30, 0, 5], label: '圆柱销', model: 0 }],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('render_failed')
      expect(result.error).toContain('callouts[0]')
      expect(result.error).toContain('不在 modelPaths[0]')
      expect(result.error).toContain('偏离 10 毫米')
      // 归属核对在渲染前跑：输入错误不产出任何视图 SVG。
      expect(existsSync(join(dir, structureSvgFilename(1, 'front')))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('真实投影片段的线宽分组可被后处理改写（含隐藏线档）', async () => {
    // 后处理按 `<g stroke-width>` 分组识别可见/隐藏线；FreeCAD 换版若改了片段结构，
    // 这里的断言与 applyStructureLineStyle 的告警一起暴露，而不是静默交出没生效的图。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadstyle-'))
    try {
      const result = await renderStructureViews(runtime, {
        modelPaths: [FIXTURE],
        views: ['front'],
        scale: 1,
        showHidden: true,
        callouts: [],
        figureNumber: 1,
        outputDir: dir,
      }, { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { views: { path: string }[] }
      const path = manifest.views[0]?.path as string
      const original = readFileSync(path, 'utf8')
      // 实测形态：可见线 0.7 一组、隐藏线 0.35 一组，全篇无 stroke-dasharray。
      expect(original).toContain('stroke-width="0.7"')
      expect(original).toContain('stroke-width="0.35"')
      expect(original).not.toContain('stroke-dasharray')
      const styled = applyStructureLineStyle(original, { lineWidthMm: 0.5, hiddenLineStyle: 'dashed' })
      expect(styled.warnings).toEqual([])
      const tags = [...styled.svg.matchAll(/<g\b[^>]*>/g)].map(match => match[0])
      // 可见线改宽且不加虚线；隐藏线保持 0.35 并加按该线宽算出的虚线。
      expect(tags.some(tag => tag.includes('stroke-width="0.5"') && !tag.includes('stroke-dasharray'))).toBe(true)
      expect(tags.some(tag => tag.includes('stroke-width="0.35"') && tag.includes('stroke-dasharray="4.2 1.05"'))).toBe(true)
      expect(measureInkBounds(styled.svg)).toEqual(measureInkBounds(original))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })
})

describe('SECTION fixture 头部签名（与 generate-section-fixture.py 生成器一致性）', () => {
  it('签入的 section-holes-plate.step 是 FreeCAD 导出的 ISO-10303-21 STEP', () => {
    const head = readFileSync(SECTION_FIXTURE, 'utf8').slice(0, 512)
    expect(head.startsWith('ISO-10303-21;')).toBe(true)
    expect(head).toContain('HEADER;')
    // 生成器签名：fixture 只能由 FreeCAD 导出；改生成脚本时必须重跑
    // `freecadcmd generate-section-fixture.py`（期望 solids=1、volume=13143.363）并复核。
    expect(head).toContain('FreeCAD')
    expect(head).toContain('Open CASCADE STEP processor')
  })
})

describe.skipIf(!hasFreeCad)('real FreeCAD section geometry (needs `freecadcmd` installed)', () => {
  const runtime = realSubprocess()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-'))
  const renderOptions = { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }

  /** 按外环/孔环分组（环序不是契约，按深度与包围盒归类）。 */
  function group(rings: readonly SectionRing[]): { outer: SectionRing; holes: SectionRing[] } {
    const outer = rings.find(ring => ring.depth === 0)
    if (outer === undefined) throw new Error('剖切结果没有深度 0 的外环')
    return { outer, holes: rings.filter(ring => ring.depth === 1) }
  }

  /** 环的包围盒（视图帧毫米）。 */
  function extent(ring: SectionRing): { width: number; height: number; centerX: number; centerY: number } {
    const xs = ring.points.map(point => point[0])
    const ys = ring.points.map(point => point[1])
    return {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      centerX: (Math.max(...xs) + Math.min(...xs)) / 2,
      centerY: (Math.max(...ys) + Math.min(...ys)) / 2,
    }
  }

  it('z=4 的轴对齐剖切切出外环 + 两个通孔，面积与解析值逐值相符', async () => {
    const result = await renderSectionGeometry(runtime, {
      modelPath: SECTION_FIXTURE,
      plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { geometry } = result

    // 模型信息：板 60×30×8、单实体；包围盒是模型单位的核对点（STEP 按毫米读入）。
    expect(geometry.model.solids).toBe(1)
    expect(geometry.model.boundBoxMm.min).toEqual([-30, -15, 0])
    expect(geometry.model.boundBoxMm.max).toEqual([30, 15, 8])
    expect(geometry.frame).toEqual({
      origin: [0, 0, 4],
      normal: [0, 0, 1],
      right: [1, 0, 0],
      down: [0, 1, 0],
    })
    expect(geometry.distanceMm).toBeCloseTo(4, 12)

    const { outer, holes } = group(geometry.rings)
    expect(geometry.rings).toHaveLength(3)
    expect(geometry.regions).toEqual([{ outer: 0, holes: [1, 2], netAreaMm2: 1800 - 2 * 78.539816 }])
    // 外环是矩形：四条直线边各取两端点，衔接后 4 个顶点。
    expect(outer.points).toHaveLength(4)
    expect(extent(outer)).toEqual({ width: 60, height: 30, centerX: 0, centerY: 0 })
    expect(outer.areaMm2).toBeCloseTo(SECTION_PLATE_WIDTH_MM * SECTION_PLATE_DEPTH_MM, 6)

    // 孔：1.5° 角度步长 → 全圆 240 点；半径 5、圆心 x = ±15 与模型逐值相符。
    expect(holes.map(hole => hole.points.length)).toEqual([240, 240])
    expect(holes.map(hole => extent(hole).centerX).sort((a, b) => a - b)).toEqual(SECTION_HOLE_CENTERS_MM)
    for (const hole of holes) {
      const box = extent(hole)
      expect(box.width / 2).toBeCloseTo(SECTION_HOLE_RADIUS_MM, 9)
      expect(box.height / 2).toBeCloseTo(SECTION_HOLE_RADIUS_MM, 9)
      expect(box.centerY).toBeCloseTo(0, 9)
      expect(hole.areaMm2).toBeCloseTo(Math.PI * SECTION_HOLE_RADIUS_MM ** 2, 6)
    }
    // 净面积 = 外环 − 两孔；解析值 1800 − 2π·25 = 1642.920367。
    expect(geometry.regions[0]?.netAreaMm2).toBeCloseTo(1642.920367, 5)
    // 离散多边形与 OCCT 精确面积的相对偏差（面积核对门限是 1e-3）：240 边形的内接
    // 相对误差 ≈ (2π/240)²/6 = 1.1e-4，即 78.54 毫米² 上差 0.009 毫米²（实测）。
    const holePolygonArea = Math.abs(shoeLace(holes[0] as SectionRing))
    expect(Math.abs(holePolygonArea - Math.PI * 25) / (Math.PI * 25)).toBeLessThan(1e-3)
    expect(Math.abs(holePolygonArea - Math.PI * 25)).toBeLessThan(0.01)
  }, 180_000)

  it('两次运行的几何逐字节一致（确定性）', async () => {
    const first = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-det-'))
    const second = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-det-'))
    try {
      const plane = { origin: [0, 0, 4] as const, normal: [0, 0, 1] as const }
      const a = await renderSectionGeometry(runtime, { modelPath: SECTION_FIXTURE, plane: { ...plane }, outputDir: first }, renderOptions)
      const b = await renderSectionGeometry(runtime, { modelPath: SECTION_FIXTURE, plane: { ...plane }, outputDir: second }, renderOptions)
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(readFileSync(join(first, SECTION_GEOMETRY_FILENAME), 'utf8'))
        .toBe(readFileSync(join(second, SECTION_GEOMETRY_FILENAME), 'utf8'))
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, 180_000)

  it('倾斜 10° 的剖切把通孔切成椭圆（面积与长短轴与解析值相符）', async () => {
    const tilt = (10 * Math.PI) / 180
    const result = await renderSectionGeometry(runtime, {
      modelPath: SECTION_FIXTURE,
      plane: { origin: [0, 0, 4], normal: [0, Math.sin(tilt), Math.cos(tilt)] },
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { outer, holes } = group(result.geometry.rings)
    expect(result.geometry.rings).toHaveLength(3)
    // 外环：平面从板的两个侧面穿出（y = ±15 处 z = 4 ∓ 15·tan10° ∈ (0, 8)），仍是矩形。
    expect(outer.points).toHaveLength(4)
    expect(outer.areaMm2).toBeCloseTo((SECTION_PLATE_WIDTH_MM * SECTION_PLATE_DEPTH_MM) / Math.cos(tilt), 5)
    // 孔：斜切圆柱得椭圆，长短半轴 = r/cos10° 与 r；面积 = πr²/cos10°（OCCT 精确值）。
    expect(holes).toHaveLength(2)
    for (const hole of holes) {
      const box = extent(hole)
      expect(hole.areaMm2).toBeCloseTo((Math.PI * SECTION_HOLE_RADIUS_MM ** 2) / Math.cos(tilt), 5)
      expect(box.width).toBeCloseTo(2 * SECTION_HOLE_RADIUS_MM, 2)
      expect(box.height).toBeCloseTo((2 * SECTION_HOLE_RADIUS_MM) / Math.cos(tilt), 2)
      // 椭圆边没有角度参数，走弦长步长档（0.1 毫米）→ 点数明显多于 1.5° 角度档的 240。
      expect(hole.points.length).toBeGreaterThan(240)
      expect(hole.points.length).toBeLessThanOrEqual(2000)
    }
    // 整块切片仍是「一个外环 + 两个孔」的材料区域。
    expect(result.geometry.regions).toHaveLength(1)
    expect(result.geometry.regions[0]?.holes).toHaveLength(2)
  }, 180_000)

  it('法向沿 X 时缺省参考方向退到 +Y，切出 y–z 断面', async () => {
    const result = await renderSectionGeometry(runtime, {
      modelPath: SECTION_FIXTURE,
      plane: { origin: [25, 0, 4], normal: [1, 0, 0] },
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.geometry.frame.right).toEqual([0, 1, 0])
    expect(result.geometry.frame.down).toEqual([0, 0, 1])
    const { outer, holes } = group(result.geometry.rings)
    expect(holes).toEqual([])
    expect(outer.points).toHaveLength(4)
    expect(outer.areaMm2).toBeCloseTo(SECTION_PLATE_DEPTH_MM * SECTION_PLATE_HEIGHT_MM, 6)
    expect(extent(outer)).toMatchObject({ width: 30, height: 8 })
  }, 180_000)

  it('平面未与模型相交、模型载入失败都归入 geometry_failed 且不产出几何', async () => {
    const missDir = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-miss-'))
    const missingDir = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-missing-'))
    try {
      const miss = await renderSectionGeometry(runtime, {
        modelPath: SECTION_FIXTURE,
        plane: { origin: [0, 0, 400], normal: [0, 0, 1] },
        outputDir: missDir,
      }, renderOptions)
      expect(miss.ok).toBe(false)
      if (miss.ok) return
      expect(miss.code).toBe('geometry_failed')
      // 本机 freecadcmd 的 stderr 不能编码中文，Python 把非 ASCII 转义成 \uXXXX
      // （实测），故这里断言消息里的 ASCII 部分与异常类型；面向模型的中文文案由工具层给。
      expect(miss.error).toContain('RuntimeError')
      expect(miss.error).toContain('origin=[0.0, 0.0, 400.0]')
      expect(existsSync(join(missDir, SECTION_GEOMETRY_FILENAME))).toBe(false)

      const missing = await renderSectionGeometry(runtime, {
        modelPath: join(missDir, 'not-a-model.step'),
        plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
        outputDir: missingDir,
      }, renderOptions)
      expect(missing.ok).toBe(false)
      if (missing.ok) return
      expect(missing.code).toBe('geometry_failed')
      // 实测：Part.read 对不存在的文件直接抛 FreeCAD 异常（不是返回空形状），
      // 消息由 OCCT 给出，故断言这段 ASCII 文案。
      expect(missing.error).toContain('File to load not existing or not readable')
      expect(existsSync(join(missingDir, SECTION_GEOMETRY_FILENAME))).toBe(false)
    } finally {
      rmSync(missDir, { recursive: true, force: true })
      rmSync(missingDir, { recursive: true, force: true })
    }
  }, 180_000)

  it('TMPDIR 指向不存在路径时 freecadcmd 无声崩溃，既不产出几何也不误报成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadsection-tmp-'))
    try {
      const scriptPath = join(dir, 'run.py')
      writeFileSync(scriptPath, buildSectionScript({
        modelPath: SECTION_FIXTURE,
        frame: resolveSectionFrame({ origin: [0, 0, 4], normal: [0, 0, 1] }),
        outputDir: dir,
      }), 'utf8')
      // 实测（FreeCAD 1.1.3）：TMPDIR 指向不存在的路径时 freecadcmd 在跑任何 Python 之前
      // SIGSEGV，stdout/stderr 全空、退出码为 null（被信号终止）；HOME 与 XDG_CACHE_HOME
      // 指向不存在路径只产生缓存/配置告警，不影响产出（286 字节 stderr，几何正常）。
      // 故渲染器必须在 spawn 前先 mkdir 隔离目录（freecad-renderer 的 FREECAD_HOME_DIRNAME）：
      // 否则这条链路会「无产物、无诊断」地失败。断言只钉住产品关心的部分。
      const absent = join(dir, '.absent-tmp')
      // 超时是这条用例的一部分：某些 FreeCAD 构建在 TMPDIR 不可用时挂起而不是
      // SIGSEGV。挂起同样是「没有产出、没有成功」，超时让套件结束，避免同步
      // spawnSync 阻塞事件循环后 vitest 的用例超时也无法生效。
      const run = spawnSync(findFreeCadCmd() as string, [scriptPath], {
        cwd: dir,
        encoding: 'utf8',
        timeout: FREECAD_TRAP_TIMEOUT_MS,
        env: { ...process.env, HOME: dir, TMPDIR: absent, TEMP: absent, TMP: absent },
      })
      expect(run.status).not.toBe(0)
      expect(run.stdout).not.toContain('SECTION_OK')
      expect(existsSync(join(dir, SECTION_GEOMETRY_FILENAME))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })
})

describe.skipIf(!hasFreeCad)('real FreeCAD section hatching (needs `freecadcmd` installed)', () => {
  const runtime = realSubprocess()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-freecadhatch-'))
  const renderOptions = { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }

  /** 打剖面线的板：40×20（与 hatch 探针同一形状，便于对照实测的条纹数）。 */
  const plate = (): (readonly [number, number])[] => hatchRect(40, 20)

  it('45° 剖面线：取向逐值相符、间距等于请求值、端点落在轮廓线上', async () => {
    const outline = plate()
    const result = await renderSectionHatch(runtime, {
      regions: [{ outline }],
      angleDeg: 45,
      spacingMm: 2,
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { segments } = result.geometry
    // 族参数区间的解析值：外框在 45° 法向上的投影为 ±(40+20)/2·cos45° = ±21.213，
    // 步长 2 → 索引 −10…10 共 21 条（步长 3 时 15 条，与探针实测一致）。
    expect(segments).toHaveLength(21)
    for (const segment of segments) {
      expect(Math.abs(hatchAngleDeg(segment) - 45)).toBeLessThan(1e-6)
      for (const point of [segment.from, segment.to]) {
        // 端点落在轮廓线上：x = ±20 或 y = ±10（裁剪按同一个离散轮廓，不伸不缩）。
        expect(Math.abs(Math.abs(point[0]) - 20) < 1e-6 || Math.abs(Math.abs(point[1]) - 10) < 1e-6).toBe(true)
      }
    }
    // 间距：把各条线段中点投影到线族法向，相邻族参数之差就是毫米间距（patScale 由 .pat 的
    // delta = 1 决定，实测逐值相等）。产物坐标按 6 位小数写出，故反推出来的间距带约 1e-6 的
    // 取整噪声（实测 2.0000006），余量取 1e-4 毫米（图面上不可辨）。
    const offsets = segments.map(segment => hatchOffset(segment.from, segment.to, 45, 'forward')).sort((a, b) => a - b)
    for (let index = 1; index < offsets.length; index += 1) {
      expect(Math.abs((offsets[index] as number) - (offsets[index - 1] as number) - 2)).toBeLessThan(1e-4)
    }
    // 本次生成的 .pat 落盘留档，图案名与角与请求一致。
    expect(readFileSync(join(outDir, HATCH_PAT_FILENAME), 'utf8')).toContain('*DSH, 45 deg')
  }, 180_000)

  it('含孔区域：孔里没有剖面线，穿孔的线被孔切成两段', async () => {
    const hole = hatchCircle(240, 5)
    const result = await renderSectionHatch(runtime, {
      regions: [{ outline: plate(), holes: [hole] }],
      angleDeg: 45,
      spacingMm: 3,
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { segments } = result.geometry
    // 同一外框不打孔时是 15 条（探针实测）；孔把穿过它的 3 条（族参数 0、±3）各切成两段 → 18 条。
    expect(segments).toHaveLength(18)
    // 独立量测一：没有任何线段中点落在孔内（本测试自带射线法，不复用被测代码）。
    expect(segments.filter(segment => hatchInsidePolygon(hatchMidpoint(segment), hole))).toEqual([])
    // 独立量测二：恰好 6 个端点落在孔圆上（3 条线各被切一刀、每刀两个端点）——孔环确实参与了成面。
    const onHole = segments
      .flatMap(segment => [segment.from, segment.to])
      .filter(point => Math.abs(Math.hypot(point[0], point[1]) - 5) < 1e-3)
    expect(onHole).toHaveLength(6)
  }, 180_000)

  it('backward 的剖面线取向是 180 − 请求角', async () => {
    const result = await renderSectionHatch(runtime, {
      regions: [{ outline: plate() }],
      angleDeg: 45,
      spacingMm: 3,
      direction: 'backward',
      outputDir: outDir,
    }, renderOptions)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.geometry.segments).toHaveLength(15)
    for (const segment of result.geometry.segments) {
      expect(Math.abs(hatchAngleDeg(segment) - 135)).toBeLessThan(1e-6)
    }
  }, 180_000)

  it('间距增大时线条数严格减少（patScale 与毫米间距同量纲）', async () => {
    const counts: number[] = []
    for (const spacingMm of [2, 6]) {
      const result = await renderSectionHatch(runtime, {
        regions: [{ outline: plate() }],
        angleDeg: 45,
        spacingMm,
        outputDir: outDir,
      }, renderOptions)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      counts.push(result.geometry.segments.length)
    }
    // 步长 2 → 21 条，步长 6 → 索引 −3…3 共 7 条。
    expect(counts).toEqual([21, 7])
  }, 180_000)

  it('两次运行的剖面线产物逐字节一致（确定性）', async () => {
    const first = mkdtempSync(join(tmpdir(), 'dsh-freecadhatch-det-'))
    const second = mkdtempSync(join(tmpdir(), 'dsh-freecadhatch-det-'))
    try {
      const spec = { regions: [{ outline: plate(), holes: [hatchCircle(240, 5)] }], angleDeg: 30, spacingMm: 4 }
      const a = await renderSectionHatch(runtime, { ...spec, outputDir: first }, renderOptions)
      const b = await renderSectionHatch(runtime, { ...spec, outputDir: second }, renderOptions)
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(readFileSync(join(first, HATCH_GEOMETRY_FILENAME), 'utf8'))
        .toBe(readFileSync(join(second, HATCH_GEOMETRY_FILENAME), 'utf8'))
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, 180_000)

  it('退化轮廓与非法角度都当场失败，不产出剖面线', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadhatch-bad-'))
    try {
      // 三点共线成不了面：脚本显式报错并 sys.exit(1)（freecadcmd 吞异常时退出码仍是 0）。
      const degenerate = await renderSectionHatch(runtime, {
        regions: [{ outline: [[0, 0], [10, 0], [20, 0]] }],
        angleDeg: 45,
        spacingMm: 2,
        outputDir: dir,
      }, renderOptions)
      expect(degenerate.ok).toBe(false)
      if (degenerate.ok) return
      expect(degenerate.code).toBe('hatch_failed')
      expect(degenerate.error).toContain('RuntimeError')
      expect(existsSync(join(dir, HATCH_GEOMETRY_FILENAME))).toBe(false)

      // 中文原样出现在消息里 = 文案由本进程给出（freecadcmd 的 stderr 会把中文转义成 \uXXXX，
      // 实测），即非法请求在启动子进程之前就被拒了。
      const badAngle = await renderSectionHatch(runtime, {
        regions: [{ outline: plate() }],
        angleDeg: 0,
        spacingMm: 2,
        outputDir: dir,
      }, renderOptions)
      expect(badAngle.ok).toBe(false)
      if (badAngle.ok) return
      expect(badAngle.code).toBe('hatch_failed')
      expect(badAngle.error).toContain('剖面线角度必须在 (0, 90] 度内')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('少传 patFile 的段错误陷阱不会静默成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-freecadhatch-trap-'))
    try {
      const regions = [{ outline: plate() }]
      const script = buildHatchScript({
        pattern: resolveHatchPattern({ regions, angleDeg: 45, spacingMm: 2 }),
        regions,
        outputDir: dir,
      })
      // 这条链路唯一的可静默失败点是「没显式传 patFile」：实测 freecadcmd 直接段错误，stdout 的
      // 块缓冲全丢。把第四个位置参数去掉来复现这个陷阱 —— 探针本身必须真的改动脚本，否则这条
      // 测试是空的。
      const broken = script.replace(
        'TechDraw.makeGeomHatch(face, PAT_SCALE, PAT_NAME, PAT_PATH)',
        'TechDraw.makeGeomHatch(face, PAT_SCALE, PAT_NAME)',
      )
      expect(broken).not.toBe(script)
      const scriptPath = join(dir, 'trap.py')
      writeFileSync(scriptPath, broken, 'utf8')
      const run = spawnSync(findFreeCadCmd() as string, [scriptPath], {
        cwd: dir,
        encoding: 'utf8',
        timeout: FREECAD_TRAP_TIMEOUT_MS,
        env: { ...process.env, HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir },
      })
      // 实测退出码 139（SIGSEGV）；即使某个 FreeCAD 版本改成返回空 Compound，脚本也会因 0 条边
      // 而 sys.exit(1)。两种结局都不可能「静默成功」，故这里钉住的是「不可能成功」而不是具体码。
      expect(run.status).not.toBe(0)
      expect(run.stdout).not.toContain('HATCH_OK')
      expect(existsSync(join(dir, HATCH_GEOMETRY_FILENAME))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })
})


describe.skipIf(!hasFreeCad)('real FreeCAD section source (needs `freecadcmd` installed)', () => {
  const runtime = realSubprocess()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-sectionsource-real-'))
  const renderOptions = { renderTimeoutMs: TEST_RENDER_TIMEOUT_MS }
  const ports: SectionSourcePorts = {
    sectionGeometry: spec => renderSectionGeometry(runtime, spec, renderOptions),
    sectionHatch: spec => renderSectionHatch(runtime, spec, renderOptions),
  }

  /** 有向 Hausdorff 距离（顶点集之间，保守：不小于真实曲线间的距离）。 */
  function directedHausdorff(from: readonly (readonly [number, number])[], to: readonly (readonly [number, number])[]): number {
    return Math.max(...from.map(point => Math.min(...to.map(other => Math.hypot(point[0] - other[0], point[1] - other[1])))))
  }

  /** 对称 Hausdorff 距离（顶点集之间）。 */
  function hausdorff(left: readonly (readonly [number, number])[], right: readonly (readonly [number, number])[]): number {
    return Math.max(directedHausdorff(left, right), directedHausdorff(right, left))
  }

  /** 点到闭合轮廓线（各边线段）的最短距离。 */
  function distanceToOutline(
    point: readonly [number, number],
    polygon: readonly (readonly [number, number])[],
  ): number {
    let best = Infinity
    for (let index = 0; index < polygon.length; index += 1) {
      const from = polygon[index] as readonly [number, number]
      const to = polygon[(index + 1) % polygon.length] as readonly [number, number]
      const dx = to[0] - from[0]
      const dy = to[1] - from[1]
      const lengthSquared = dx * dx + dy * dy
      const t = lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared))
      best = Math.min(best, Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy)))
    }
    return best
  }

  /** 与手工输入的 fig1.json 等效的剖视图输入：底板（含两个通孔）+ 一个标号。 */
  function sourceInput(): SectionFigureJson {
    return {
      source: {
        model_path: SECTION_FIXTURE,
        plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
        part_size_mm: [SECTION_PLATE_WIDTH_MM, SECTION_PLATE_DEPTH_MM, SECTION_PLATE_HEIGHT_MM],
      },
      parts: [{ label: '1', anchor: [0, 0], hatch: { angle_deg: 45, spacing_mm: 3 } }],
      labels: [{ text: '2', at: [37, -22], from: [20, -15] }],
    }
  }

  it('切出的轮廓与解析矩形、孔圆环的 Hausdorff 距离都小于 0.1 毫米', async () => {
    const expanded = await expandSectionSource(sourceInput(), { ports, cwd: import.meta.dirname, artifactDir: outDir })
    expect(expanded.sections.parts).toHaveLength(1)
    const [part] = expanded.sections.parts
    const outline = part?.outline as readonly (readonly [number, number])[]
    const rectangle: (readonly [number, number])[] = [
      [-30, -15], [30, -15], [30, 15], [-30, 15],
    ]
    expect(part?.holes).toHaveLength(2)
    expect(outline).toHaveLength(4)
    expect(hausdorff(outline, rectangle)).toBeLessThan(0.1)
    for (const [index, hole] of (part?.holes ?? []).entries()) {
      const centerX = SECTION_HOLE_CENTERS_MM[index] as number
      const circle = Array.from({ length: 720 }, (_, step) => {
        const angle = (2 * Math.PI * step) / 720
        return [centerX + SECTION_HOLE_RADIUS_MM * Math.cos(angle), SECTION_HOLE_RADIUS_MM * Math.sin(angle)] as const
      })
      expect(hole).toHaveLength(240)
      expect(hausdorff(hole, circle)).toBeLessThan(0.1)
    }
    expect(expanded.warnings.join('\n')).toContain('切出 1 个材料区域')
  }, 180_000)

  it('剖面线由模型按区域裁出：孔里没有剖面线，端点落在切出的轮廓上', async () => {
    const expanded = await expandSectionSource(sourceInput(), { ports, cwd: import.meta.dirname, artifactDir: outDir })
    const [part] = expanded.sections.parts
    const segments = part?.hatch_segments ?? []
    expect(segments.length).toBeGreaterThan(0)
    const outlines: (readonly (readonly [number, number])[])[] = [
      part?.outline as readonly (readonly [number, number])[],
      ...(part?.holes ?? []),
    ]
    let longestToOutline = 0
    for (const segment of segments) {
      // 中点不落在任何孔内：孔由 makeGeomHatch 精确裁剪（section-diagram 的逐多边形裁剪做不到）。
      const midpoint = [(segment.from[0] + segment.to[0]) / 2, (segment.from[1] + segment.to[1]) / 2] as const
      for (const [index] of (part?.holes ?? []).entries()) {
        const centerX = SECTION_HOLE_CENTERS_MM[index] as number
        expect(Math.hypot(midpoint[0] - centerX, midpoint[1])).toBeGreaterThan(SECTION_HOLE_RADIUS_MM)
      }
      // 端点到轮廓边（外环或孔环的线段）的距离：剖面线落在画出来的轮廓线上。
      for (const end of [segment.from, segment.to]) {
        longestToOutline = Math.max(longestToOutline, Math.min(...outlines.map(polygon => distanceToOutline(end, polygon))))
      }
      // 取向：45°（无向）。产物坐标取 6 位小数，端点各带约 1e-6 的取整噪声，故容差取 1e-3 度。
      const degrees = (Math.atan2(segment.to[1] - segment.from[1], segment.to[0] - segment.from[0]) * 180) / Math.PI
      expect(Math.abs((degrees + 180) % 180 - 45)).toBeLessThan(1e-3)
    }
    expect(longestToOutline).toBeLessThan(1e-5)
  }, 180_000)

  it('展开后的输入直接落图：渲染复核没有任何发现', async () => {
    const expanded = await expandSectionSource(sourceInput(), { ports, cwd: import.meta.dirname, artifactDir: outDir })
    const build = buildVectorFigure('cross_section', { sections: expanded.sections })
    const report = checkFigureRendering(vectorFigureSvg(build.spec, '剖视图'))
    expect(report.findings).toEqual([])
  }, 180_000)

  it('声明的零件尺寸与模型包围盒不符时当场报错（挡住单位读错）', async () => {
    const failure = await expandSectionSource({
      ...sourceInput(),
      source: {
        model_path: SECTION_FIXTURE,
        plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
        part_size_mm: [600, 300, 80],
      },
    }, { ports, cwd: import.meta.dirname, artifactDir: outDir }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SectionSourceError)
    expect((failure as SectionSourceError).code).toBe('invalid_input')
    expect((failure as SectionSourceError).message).toContain('80×300×600')
  }, 180_000)

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })
})

/** 矩形顶点（隐式闭合）。 */
function hatchRect(width: number, height: number): (readonly [number, number])[] {
  return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]
}

/** 正多边形（与 `buildSectionScript` 的 1.5° 角度步长同精度地近似圆孔）。 */
function hatchCircle(sides: number, radius: number): (readonly [number, number])[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = (2 * Math.PI * index) / sides
    return [radius * Math.cos(angle), radius * Math.sin(angle)]
  })
}

/** 线段在视图帧（y 向下）里的方向角，取 [0, 180) 的无向值。 */
function hatchAngleDeg(segment: { from: readonly [number, number]; to: readonly [number, number] }): number {
  const degrees = (Math.atan2(segment.to[1] - segment.from[1], segment.to[0] - segment.from[0]) * 180) / Math.PI
  return (degrees + 180) % 180
}

/** 线段中点在剖面线族法向上的投影（族参数）。 */
function hatchOffset(
  from: readonly [number, number],
  to: readonly [number, number],
  angleDeg: number,
  direction: 'forward' | 'backward',
): number {
  const radians = (angleDeg * Math.PI) / 180
  const sign = direction === 'forward' ? 1 : -1
  const normal: [number, number] = [-sign * Math.sin(radians), Math.cos(radians)]
  return ((from[0] + to[0]) / 2) * normal[0] + ((from[1] + to[1]) / 2) * normal[1]
}

/** 线段中点。 */
function hatchMidpoint(segment: { from: readonly [number, number]; to: readonly [number, number] }): [number, number] {
  return [(segment.from[0] + segment.to[0]) / 2, (segment.from[1] + segment.to[1]) / 2]
}

/** 点在多边形内判定（射线穿越；独立实现，不复用被测代码）。 */
function hatchInsidePolygon(point: readonly [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index] as readonly [number, number]
    const last = polygon[previous] as readonly [number, number]
    if ((current[1] > point[1]) === (last[1] > point[1])) continue
    const crossingX = current[0] + ((point[1] - current[1]) / (last[1] - current[1])) * (last[0] - current[0])
    if (point[0] < crossingX) inside = !inside
  }
  return inside
}

/** 环的有向面积（只为独立复核离散面积，不复用被测代码）。 */
function shoeLace(ring: SectionRing): number {
  let sum = 0
  for (let index = 0; index < ring.points.length; index += 1) {
    const current = ring.points[index] as readonly [number, number]
    const next = ring.points[(index + 1) % ring.points.length] as readonly [number, number]
    sum += current[0] * next[1] - next[0] * current[1]
  }
  return sum / 2
}
