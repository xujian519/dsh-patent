# FreeCAD 工作区

[English](README.md) | 中文

依据 `reports/freecad-implementation-plan.md` 建立。目标版本 FreeCAD 1.1.4。

## 目录

```
templates/   SVG 图框（含 freecad:editable 与 freecad:autofill 字段）
parts/       零件族构建器（Python，调用 FreeCAD Part API）
params/      参数表（JSON，每个变体一份）
scripts/     build.py / verify.py / sheet.py / render_pdf.py / dim_rules.py / import2d.py / common/
out/         生成物，按 <part>/<variant>/ 分层（未跟踪，由脚本重新生成）
docs/        基线、命名规范、字段字典、API 片段、故障对策
```

接入客户图纸时按案件新建 `incoming/<案件>/`，原始图纸只读。

## 运行

脚本必须在 FreeCAD 的 Python 解释器下执行，不能直接用系统 `python3`：

```bash
freecadcmd scripts/build.py --pass params/plate-100x60.json
freecadcmd scripts/verify.py --out out/plate/100x60
freecadcmd scripts/sheet.py --pass params/plate-100x60.json
python3 scripts/render_pdf.py --dxf out/plate/100x60/model.dxf
```

`sheet.py` 需要先有 `out/<part>/<variant>/model.FCStd`，即先跑 `build.py`。DXF 可无头导出（用 `Part.HLRBRep` 直接投影 + 手写 DXF 实体，不依赖 TechDraw HLR）。PDF 由 `render_pdf.py` 从 DXF 渲染（系统 Python + `ezdxf`/`reportlab`），不需要 FreeCAD GUI；`sheet.py --pdf` 走 TechDraw 模板路径，需要 GUI（`xvfb-run -a freecad ...`）。

macOS 的可执行文件在 `FreeCAD.app/Contents/MacOS/FreeCADCmd`；Windows 为 `FreeCADCmd.exe`；Linux 发行版通常为小写 `freecadcmd`。

客户图纸接入用系统 Python，不进 FreeCAD：

```bash
pip install ezdxf
python3 scripts/import2d.py --input incoming/JWZF20K/source/JWZF20K带支架.DWG --case JWZF20K
python3 scripts/import2d.py --input drawing.dxf --drop-layer TITLE --drop-pattern '^标注'
```

| 输入 | 依赖 |
|---|---|
| `.dxf` | `ezdxf` |
| `.dwg` | LibreDWG 的 `dwg2dxf`（或先手动转 DXF） |
| `.pdf` | `pdftocairo`（poppler-utils） |

输出到 `out/<case>/converted/`：`model.svg`、`layers.json`（图层清单）、`convert.json`（来源哈希、转换器、删除计数）。默认删除尺寸实体、`TEXT`/`MTEXT`，并按 `--drop-layer` / `--drop-pattern` 删图层；PDF 路径没有图层信息，清理需人工，`convert.json` 会记 `cleaning: manual`。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 参数表不合法 |
| 3 | 几何无效（`isValid()` 为假、体积异常、包围盒与参数不符） |
| 4 | 导出失败 |
| 5 | 运行环境缺失（未在 FreeCADCmd 下运行或缺少模块） |

## 当前状态

- 阶段 0–3 的代码已建立：目录骨架、A4 图框、板/法兰/阶梯轴/L 形支架四类构建器，`build.py`、`verify.py`、`sheet.py`、`dim_rules.py`。
- 阶段 5 的 `import2d.py` 已实现，DXF 路径在沙箱用合成图实测通过；DWG/PDF 路径依赖本机转换器，未实测。
- 阶段 4 的上下文资产已建立：`docs/api_snippets.md`、`docs/field-dictionary.md`（含模板字段与四类零件参数表）、`docs/failure_playbook.md`、`docs/agent-contract.md`（代理权限与护栏）、四份 `params/*.json` 样例。
- 四份参数样例已通过 `scripts/common/params.py` 校验，并与各零件族的 `REQUIRED` 字段及数值约束一致。
- `build.py` / `verify.py` / `sheet.py` 已在 FreeCAD 0.21.2 下跑通四类零件：`build.py` 产出 FCStd/STEP/STL/manifest；`verify.py` 体积与包围盒校验通过；`sheet.py` 产出 DXF（含图框、标题栏、三视图、尺寸文字）、`dimensions.json` 与 `manual_review.md`；`render_pdf.py` 从 DXF 渲染单页 A4 横放 PDF。四类零件都有自动尺寸（轴类按轴类规则标总长与三段直径）。四份 DXF 均通过 `ezdxf` 的 `audit()`（0 error），图形全部落在 A4 图框内，四份 PDF 已生成并人工目视复核。

## 已知限制

- DXF 导出用 `Part.HLRBRep.Algo` 直接做三视图投影（无头模式下 TechDraw HLR 不运行），再手写 R12 DXF 实体：直线写 `LINE`、整圆写 `CIRCLE`、圆弧（圆角）写 `ARC`，其余曲线（如圆柱侧视轮廓的 BSpline）细化为短 `LINE` 段。
- 三视图按第一角法排布：主视图在上，俯视图在主视图正下方，左视图在主视图右侧；投影朝向给出的是右视图，左视图在导出时对 X 取反镜像。视图按图框可用区域自动缩放（不超过 1:1）并整体居中。
- 投影未做消隐（`showAll()` 下 `hCompound` 为空）：孔与相切过渡边按可见线绘制，视图内会出现阶梯状切线，轮廓与尺寸不受影响。
- DXF 为 R12（AC1009），没有 Unicode：文字按 `$DWGCODEPAGE=ANSI_936` 以 cp936 编码写入；直径符号用 AutoCAD 控制码 `%%c`（打开后显示为 ⌀），因为 U+2300 不在 GB2312/936 内。`render_pdf.py` 渲染时把 `%%c` 换成同字体支持的 `Ø`，因为内置中文字体缺 U+2300 字形。
- 尺寸值取自投影边匹配或 3D 包围盒/圆柱面回退测量；标注规则按零件族分组（`dim_rules.PART_RULES`），只对参数表声明了对应参数的规则生效，未声明的规则直接转人工。`dimensions.json` 中 `status=manual` 的项需人工核对（例如矩形孔阵无节圆）。轴类零件用独立规则集：总长取轴向包围盒，各段直径取轴向圆柱面（`shaft_length` / `shaft_dia_1..3`），按固定三段设计，少于三段的轴会把多余规则转人工。新增零件族必须在 `PART_RULES` 登记，否则 `sheet.py` 直接报错而不会套用板类规则。
- `shape.scale()` 在 FreeCAD 0.21 中会使 `edge.Curve` 无法读取，故视图缩放通过对坐标手动乘系数实现。
- `import2d.py` 的 DWG 路径依赖 `dwg2dxf`，沙箱没有该工具，未实测；多页 PDF 会产出 `model-2.svg` 等文件，`convert.json` 的 `outputs` 会列出全部 SVG。
- PDF 有两种路径：`render_pdf.py` 从 DXF 重绘（系统 Python，无需 GUI，交付物用这条）；`sheet.py --pdf` 走 TechDraw 模板，需要 GUI（`xvfb-run`），未在无头环境实测。
