import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STRUCTURE_VIEWS,
  STRUCTURE_ANCHOR_TOLERANCE_MM,
  STRUCTURE_DETAIL_MATTING_SLACK,
  STRUCTURE_MANIFEST_FILENAME,
  STRUCTURE_TEMPLATE_FILENAME,
  STRUCTURE_TRANSIENT_DIRNAME,
  STRUCTURE_VIEW_DIRECTIONS,
  STRUCTURE_VIEWS,
  buildStructureScript,
  structureDetailSvgFilename,
  structureSvgFilename,
  type StructureScriptParams,
} from '../src/figure/freecad-structure-script.ts'

/**
 * buildStructureScript 是纯函数：断言它把请求渲染成一段自包含 Python 源码，
 * 只使用本机 FreeCAD 1.1 实测存在的 API，并把参数以双重序列化 JSON 内嵌。
 * 全程不接触 FreeCAD、不做 IO。
 */

function params(overrides: Partial<StructureScriptParams> = {}): StructureScriptParams {
  return {
    modelPaths: ['/abs/model.step'],
    views: ['iso', 'front'],
    scale: 1,
    showHidden: false,
    callouts: [],
    figureNumber: 1,
    outputDir: '/abs/out',
    ...overrides,
  }
}

/** 从脚本源码里抽回内嵌 payload（json.loads("<双重转义 JSON>")），验证往返一致。 */
function extractPayload(script: string): Record<string, unknown> {
  // 内嵌字面量恒在单行（JSON.stringify 转义换行），不加 s 标志以免跨行贪婪误配后续 ")。
  const match = /json\.loads\((.*)\)/.exec(script)
  expect(match, 'script embeds a json.loads literal').not.toBeNull()
  const inner = JSON.parse(match![1] as string) as string
  return JSON.parse(inner) as Record<string, unknown>
}

describe('buildStructureScript', () => {
  it('使用实测存在的 TechDraw API，不使用已知的 1.1.3 破坏 API', () => {
    const script = buildStructureScript(params())
    expect(script).toContain('TechDraw.viewPartAsSvg')
    expect(script).toContain('view.projectPoint')
    expect(script).toContain('Part.read')
    expect(script).toContain('TechDraw::DrawViewPart')
    // 隐藏线开关的四个布尔属性
    for (const prop of ['HardHidden', 'IsoHidden', 'SmoothHidden', 'SeamHidden']) {
      expect(script).toContain(prop)
    }
    // DrawProjGroup.addProjection 在 1.1.3 抛 TypeError，脚本必须避开
    expect(script).not.toContain('addProjection')
    expect(script).not.toContain('DrawProjGroup')
  })

  it('以 DrawPage + DrawSVGTemplate 承载视图（投影只在带模板的页面上执行）', () => {
    const script = buildStructureScript(params())
    expect(script).toContain('TechDraw::DrawPage')
    expect(script).toContain('TechDraw::DrawSVGTemplate')
    expect(script).toContain('page.addView')
    // 自带最小空白模板，不依赖 FreeCAD bundle 模板路径
    expect(script).toContain(STRUCTURE_TEMPLATE_FILENAME)
    expect(script).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
  })

  it('freecadcmd 吞异常，脚本显式 sys.exit(1) 让渲染器据退出码 fail-loud', () => {
    const script = buildStructureScript(params())
    expect(script).toContain('import sys')
    expect(script).toContain('import traceback')
    expect(script).toContain('traceback.print_exc()')
    expect(script).toContain('sys.exit(1)')
  })

  it('每次 open() 都显式指定 UTF-8，写出不依赖宿主 locale', () => {
    const script = buildStructureScript(params())
    const opens = script.match(/\bopen\([^)]*\)/g) ?? []
    // 四处文本写出：模板、每视图 SVG、放大视图 SVG、含中文件号名的 manifest。
    expect(opens).toHaveLength(4)
    for (const call of opens) {
      expect(call).toContain('encoding="utf-8"')
    }
  })

  it('stderr 改 UTF-8：中文失败原因不被转义成 \\uXXXX（渲染器据 stderr 归类失败）', () => {
    const script = buildStructureScript(params())
    // 实测：LANG=C 时 freecadcmd 的 stderr 是 ascii + backslashreplace，中文报错
    // 会变成 \u4e0d\u5728 这类字面量传出去，调用方读不懂。
    expect(script).toContain('sys.stderr.reconfigure(encoding="utf-8")')
  })

  it('把文档 TransientDir 锚定到 outputDir 子目录（TechDraw 以它拷贝模板）', () => {
    const script = buildStructureScript(params())
    // FreeCAD 只在自身缓存目录可写时才派生内存文档的 TransientDir；它为空串时
    // TechDraw 把模板拷到根目录（/）导致渲染失败，故脚本必须显式锚定。
    expect(script).toContain(STRUCTURE_TRANSIENT_DIRNAME)
    expect(script).toContain('os.makedirs(transient_dir, exist_ok=True)')
    expect(script).toContain('doc.TransientDir = transient_dir')
  })

  it('片段按画布帧原样落图：不再整体 scale(1,-1)，件号与画布同帧', () => {
    const script = buildStructureScript(params())
    // 实测：viewPartAsSvg 的片段本身就是 y 向下、已按投影紧致几何居中的画布帧
    // （projectPoint 才是 y 向上），再翻一次会把整张图上下镜像。件号锚点、画布
    // 上下边界都按 C_y - y_projectPoint 算，故三者同帧、引线落在真实投影上。
    expect(script).not.toContain('scale(1,-1)')
    expect(script).toContain('-(projected.y - c_y)')
    expect(script).toContain('-geo_max_y')
  })

  it('往返一致：内嵌 payload 双重序列化后可还原为原请求', () => {
    const script = buildStructureScript(params({
      modelPaths: ['/abs/含空格 model.step'],
      views: ['iso', 'front', 'top'],
      scale: 2.5,
      showHidden: true,
      callouts: [{ numeral: '100', point3d: [1, -2.5, 3], label: '立柱' }],
      figureNumber: 7,
      outputDir: '/abs/out "quoted"',
    }))
    const payload = extractPayload(script)
    expect(payload.modelPaths).toEqual(['/abs/含空格 model.step'])
    expect(payload.views).toEqual(['iso', 'front', 'top'])
    expect(payload.scale).toBe(2.5)
    expect(payload.showHidden).toBe(true)
    expect(payload.figureNumber).toBe(7)
    expect(payload.outputDir).toBe('/abs/out "quoted"')
    expect(payload.callouts).toEqual([{ numeral: '100', point3d: [1, -2.5, 3], label: '立柱', model: null }])
    expect(payload.manifestFilename).toBe(STRUCTURE_MANIFEST_FILENAME)
    expect(payload.templateFilename).toBe(STRUCTURE_TEMPLATE_FILENAME)
    expect(payload.transientDirname).toBe(STRUCTURE_TRANSIENT_DIRNAME)
  })

  it('为每个请求视图注入 Direction/XDirection 与输出文件名', () => {
    const script = buildStructureScript(params({ views: ['iso', 'right'], figureNumber: 3 }))
    const payload = extractPayload(script)
    const directions = payload.directions as Record<string, number[][]>
    expect(directions.iso).toEqual([...STRUCTURE_VIEW_DIRECTIONS.iso])
    expect(directions.right).toEqual([...STRUCTURE_VIEW_DIRECTIONS.right])
    // 未请求的视图不注入方向表
    expect(Object.keys(directions).sort()).toEqual(['iso', 'right'])
    expect(payload.svgFilenames).toEqual({
      iso: 'fig3_iso.svg',
      right: 'fig3_right.svg',
    })
  })

  it('无 callouts 时仍产出合法脚本，件号列表为空', () => {
    const script = buildStructureScript(params({ callouts: [] }))
    expect(extractPayload(script).callouts).toEqual([])
    // 引线/件号绘制逻辑仍在（供有件号时使用）
    expect(script).toContain('<text')
  })

  it('相同入参恒返回相同源码（纯函数）', () => {
    const a = buildStructureScript(params({ callouts: [{ numeral: '100', point3d: [0, 0, 0] }] }))
    const b = buildStructureScript(params({ callouts: [{ numeral: '100', point3d: [0, 0, 0] }] }))
    expect(a).toBe(b)
  })

  it('callout label 缺省时归一为空字符串（payload 不携带 undefined）', () => {
    const script = buildStructureScript(params({ callouts: [{ numeral: '102', point3d: [1, 2, 3] }] }))
    const payload = extractPayload(script)
    expect(payload.callouts).toEqual([{ numeral: '102', point3d: [1, 2, 3], label: '', model: null }])
  })

  it('局部放大：payload 带窗口、文件名按序号，脚本用实测属性接线', () => {
    const script = buildStructureScript(params({
      views: ['front'],
      details: [{ base: 'front', center: [0, 0, 8], radiusMm: 8, scale: 2, reference: 'Ⅰ' }],
      figureNumber: 4,
    }))
    const payload = extractPayload(script)
    expect(payload.details).toEqual([{ base: 'front', center3d: [0, 0, 8], radiusMm: 8, scale: 2, reference: 'Ⅰ' }])
    expect(structureDetailSvgFilename(4, 1)).toBe('fig4_detail1.svg')
    expect(payload.detailFilenames).toEqual([structureDetailSvgFilename(4, 1)])
    expect(payload.mattingSlack).toBe(STRUCTURE_DETAIL_MATTING_SLACK)
    // 1.1.3 的 DrawViewDetail 只有 BaseView/AnchorPoint/Radius/Scale/Reference
    // 这组属性（没有 ReferenceX/ReferenceY），且圆心必须取「基视图帧」的
    // projectPoint(圆心) - C——传 projectPoint 原始值会把窗口挪到别处。
    expect(script).toContain('TechDraw::DrawViewDetail')
    expect(script).toContain('view.BaseView = base_view')
    expect(script).toContain('view.AnchorPoint = App.Vector(projected.x - base_center[0], projected.y - base_center[1], 0)')
    expect(script).not.toContain('ReferenceX')
    // 基视图上的「放大部位」标记圆由脚本自己画：ShowHighlight 只进 GUI 页面，
    // viewPartAsSvg(基视图) 在细节视图存在前后逐字节相同。
    expect(script).toContain('<circle cx="%s" cy="%s" r="%s"')
    expect(script).toContain('detail_marking_fragments')
  })

  it('局部放大：不传 details 时不产出窗口文件名，输出与从前一致', () => {
    const script = buildStructureScript(params())
    const payload = extractPayload(script)
    expect(payload.details).toEqual([])
    expect(payload.detailFilenames).toEqual([])
    // 标记圆逻辑仍在（供有窗口时使用），但本次不产出任何 circle 片段。
    expect(script).toContain('detail_marking_fragments')
  })

  it('局部放大：放大视图的画布用片段自身坐标（片段已按 Scale 放大，不再乘 SCALE）', () => {
    const script = buildStructureScript(params({
      views: ['front'],
      details: [{ base: 'front', center: [0, 0, 8], radiusMm: 8, scale: 2, reference: '1' }],
    }))
    // 基视图画布 = 坐标 × SCALE（片段不随 DrawViewPart.Scale 变），放大视图画布
    // 直接用坐标（片段已随 DrawViewDetail.Scale 放大过）。
    expect(script).toContain('fmt(width * SCALE)')
    expect(script).toContain('radius * MATTING_SLACK')
    expect(script).not.toContain('size * SCALE')
  })

  it('装配体：每个模型文件一个 Part::Feature，一起挂到同一视图的 Source 上', () => {
    const script = buildStructureScript(params({ modelPaths: ['/abs/plate.step', '/abs/pin.step'] }))
    const payload = extractPayload(script)
    expect(payload.modelPaths).toEqual(['/abs/plate.step', '/abs/pin.step'])
    // 逐个载入并各建一个对象：件号归属（callouts[].model）需要按零件分开的形状。
    expect(script).toContain('for index, model_path in enumerate(MODEL_PATHS):')
    expect(script).toContain('doc.addObject("Part::Feature", "Model_%d" % index)')
    expect(script).toContain('view.Source = shape_objs')
    // 投影中心取样覆盖全部零件（片段是所有零件的合并投影）。
    expect(script).toContain('for shape in shapes:')
  })

  it('件号归属随 payload 下发；未声明的记为 null', () => {
    const script = buildStructureScript(params({
      modelPaths: ['/abs/plate.step', '/abs/pin.step'],
      callouts: [
        { numeral: '100', point3d: [0, 0, 24], label: '立销', model: 1 },
        { numeral: '102', point3d: [20, -12, 8], label: '底板' },
      ],
    }))
    const payload = extractPayload(script)
    expect(payload.callouts).toEqual([
      { numeral: '100', point3d: [0, 0, 24], label: '立销', model: 1 },
      { numeral: '102', point3d: [20, -12, 8], label: '底板', model: null },
    ])
    expect(payload.anchorTolerance).toBe(STRUCTURE_ANCHOR_TOLERANCE_MM)
  })

  it('归属核对：体外点按 distToShape 的真实偏移报错，且在渲染前跑', () => {
    const script = buildStructureScript(params({
      modelPaths: ['/abs/plate.step', '/abs/pin.step'],
      callouts: [{ numeral: '100', point3d: [0, 0, 40], model: 0 }],
    }))
    // 判据与报错文本：指明 callouts 下标、声明归属的 modelPaths 下标与偏离量。
    expect(script).toContain('distToShape(Part.Vertex(App.Vector(px, py, pz)))')
    expect(script).toContain('callouts[%d].point3d')
    expect(script).toContain('不在 modelPaths[%d]')
    expect(script).toContain('callouts[%d].model = %d 超出 modelPaths 范围')
    // 锚点错位是输入错误：不得先花掉一次完整投影再报。
    const verifyAt = script.indexOf('verify_callout_owners(shapes)')
    expect(verifyAt).toBeGreaterThan(0)
    expect(verifyAt).toBeLessThan(script.indexOf('TechDraw::DrawPage'))
  })

  it('manifest 记每个件号的归属（下标 + 绝对路径），未声明的记 null', () => {
    const script = buildStructureScript(params({ modelPaths: ['/abs/plate.step', '/abs/pin.step'] }))
    expect(script).toContain('"model": owner')
    expect(script).toContain('"modelPath": None if owner is None else MODEL_PATHS[owner]')
    expect(script).toContain('"modelPaths": MODEL_PATHS')
  })
})

describe('structure view constants', () => {
  it('视图表覆盖全部 STRUCTURE_VIEWS，每项为两个非零三维向量', () => {
    expect(Object.keys(STRUCTURE_VIEW_DIRECTIONS).sort()).toEqual([...STRUCTURE_VIEWS].sort())
    for (const view of STRUCTURE_VIEWS) {
      const [dir, xdir] = STRUCTURE_VIEW_DIRECTIONS[view]
      for (const vec of [dir, xdir]) {
        expect(vec).toHaveLength(3)
        // 注：iso 的 XDirection 是方向提示，TechDraw 内部对其 Direction 重新正交化，
        // 故不要求与 Direction 严格点积为 0（本机实测该组值产出正确的等轴测图）。
        expect(Math.hypot(vec[0], vec[1], vec[2])).toBeGreaterThan(0)
      }
    }
  })

  it('缺省视图集是 STRUCTURE_VIEWS 的子集', () => {
    for (const view of DEFAULT_STRUCTURE_VIEWS) {
      expect(STRUCTURE_VIEWS).toContain(view)
    }
  })

  it('structureSvgFilename 遵循 fig{N}_{view}.svg 约定', () => {
    expect(structureSvgFilename(2, 'top')).toBe('fig2_top.svg')
  })
})

describe('结构线稿的标号引线', () => {
  it('引线止于数字占位框外缘，并标注 leader 角色', () => {
    const script = buildStructureScript(params({
      callouts: [{ numeral: '102', point3d: [10, 20, 30], label: '底板' }],
    }))
    expect(script).toContain('data-dsh-role="leader"')
    expect(script).toContain('end_x, end_y = leader_end(box_x, box_y, half_w, half_h, dir_x, dir_y)')
    // 旧写法把数字锚点直接当引线终点，必然穿过自己的标号。
    expect(script).not.toContain('% (fmt(anchor_x), fmt(anchor_y), fmt(text_x), fmt(text_y), fmt(STROKE_WIDTH))')
  })

  it('标号按候选位选择：绕首选方向每 30° 一圈、三档距离，压盖则换下一个', () => {
    const script = buildStructureScript(params())
    expect(script).toContain('CALLOUT_DIRECTION_STEPS = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]')
    expect(script).toContain('CALLOUT_DISTANCE_SCALES = [1.0, 1.6, 2.4]')
    expect(script).toContain('def choose_callout_position(')
    // 首选方向取自所属零件的投影中心，而不是画布中心：零件位于图面中央时
    // 后者是任意方向，标号会被丢进图形内部。
    expect(script).toContain('out_x = anchor_x - part_cx')
    expect(script).not.toContain('length = math.hypot(anchor_x, anchor_y)')
    // 压盖判定只认别的零件与已放标号；自身零件的占位不算。
    expect(script).toContain('if part_index == own_part or part_rect is None:')
  })

  it('字宽比例与复核侧 glyph-box 一致，画布按真实占位框外扩', () => {
    const script = buildStructureScript(params())
    expect(script).toContain('GLYPH_WIDTH_RATIO = 0.62')
    expect(script).toContain('GLYPH_ASCENT_RATIO = 0.75')
    expect(script).toContain('GLYPH_DESCENT_RATIO = 0.12')
    expect(script).toContain('min_x = min(min_x, box_x - half_w)')
    expect(script).toContain('max_x = max(max_x, box_x + half_w)')
  })
})
