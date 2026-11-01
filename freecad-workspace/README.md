# FreeCAD workspace

English | [中文](README.zh.md)

Built from `reports/freecad-implementation-plan.md`. Target version FreeCAD 1.1.4.

## Layout

```
templates/   SVG 图框（含 freecad:editable 与 freecad:autofill 字段）
parts/       零件族构建器（Python，调用 FreeCAD Part API）
params/      参数表（JSON，每个变体一份）
scripts/     build.py / verify.py / sheet.py / render_pdf.py / dim_rules.py / import2d.py / common/
out/         生成物，按 <part>/<variant>/ 分层（未跟踪，由脚本重新生成）
docs/        基线、命名规范、字段字典、API 片段、故障对策
```

For each customer drawing, create `incoming/<case>/` per case; the original drawings stay read-only.

## Running

The scripts must run under FreeCAD's Python interpreter, not under the system `python3`:

```bash
freecadcmd scripts/build.py --pass params/plate-100x60.json
freecadcmd scripts/verify.py --out out/plate/100x60
freecadcmd scripts/sheet.py --pass params/plate-100x60.json
python3 scripts/render_pdf.py --dxf out/plate/100x60/model.dxf
```

`sheet.py` needs `out/<part>/<variant>/model.FCStd` first, so run `build.py` before it. DXF can be exported headless (direct `Part.HLRBRep` projection plus hand-written DXF entities, without the TechDraw HLR). The PDF comes from `render_pdf.py`, which renders the DXF (system Python plus `ezdxf`/`reportlab`) and therefore needs no FreeCAD GUI; `sheet.py --pdf` takes the TechDraw template path and does need a GUI (`xvfb-run -a freecad ...`).

On macOS the executable lives in `FreeCAD.app/Contents/MacOS/FreeCADCmd`; on Windows it is `FreeCADCmd.exe`; Linux distributions usually ship the lowercase `freecadcmd`.

Customer drawing intake runs under the system Python, outside FreeCAD:

```bash
pip install ezdxf
python3 scripts/import2d.py --input incoming/JWZF20K/source/JWZF20K带支架.DWG --case JWZF20K
python3 scripts/import2d.py --input drawing.dxf --drop-layer TITLE --drop-pattern '^标注'
```

| Input | Dependency |
|---|---|
| `.dxf` | `ezdxf` |
| `.dwg` | LibreDWG's `dwg2dxf` (or convert to DXF by hand first) |
| `.pdf` | `pdftocairo` (poppler-utils) |

The output goes to `out/<case>/converted/`: `model.svg`, `layers.json` (the layer list), and `convert.json` (source hash, converter, deletion counts). Dimension entities and `TEXT`/`MTEXT` are dropped by default, and layers are dropped per `--drop-layer` / `--drop-pattern`; the PDF path carries no layer information, so its cleanup stays manual and `convert.json` records `cleaning: manual`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | invalid parameter table |
| 3 | invalid geometry (`isValid()` is false, the volume is abnormal, or the bounding box disagrees with the parameters) |
| 4 | export failed |
| 5 | missing runtime (not run under FreeCADCmd, or a module is missing) |

## Current state

- The stage 0–3 code is in place: the directory skeleton, the A4 drawing frame, four part-family builders (plate, flange, stepped shaft, L-shaped bracket), `build.py`, `verify.py`, `sheet.py`, and `dim_rules.py`.
- The stage 5 `import2d.py` is implemented; the DXF path passed a sandbox test with synthetic drawings, while the DWG and PDF paths depend on a local converter and stay untested.
- The stage 4 context assets are in place: `docs/api_snippets.md`, `docs/field-dictionary.md` (covering the template fields and the four part-family parameter tables), `docs/failure_playbook.md`, `docs/agent-contract.md` (agent permissions and guardrails), and four `params/*.json` samples.
- The four parameter samples pass `scripts/common/params.py` validation and agree with each part family's `REQUIRED` fields and numeric constraints.
- `build.py` / `verify.py` / `sheet.py` run for all four part families under FreeCAD 0.21.2: `build.py` produces FCStd/STEP/STL/manifest; `verify.py` passes the volume and bounding-box checks; `sheet.py` produces the DXF (with drawing frame, title block, three views, and dimension text), `dimensions.json`, and `manual_review.md`; `render_pdf.py` renders a single-page A4 landscape PDF from the DXF. All four part families get automatic dimensions (shaft parts follow the shaft rules for the overall length and the three diameters). All four DXF files pass `ezdxf`'s `audit()` with 0 errors, every drawing stays inside the A4 frame, and all four PDFs were generated and reviewed by eye.

## Known limitations

- DXF export uses `Part.HLRBRep.Algo` directly for the three-view projection (TechDraw HLR does not run headless), then hand-writes R12 DXF entities: straight lines as `LINE`, full circles as `CIRCLE`, arcs (fillets) as `ARC`; the remaining curves (such as the BSpline outline of a cylinder side view) are approximated by short `LINE` segments.
- The three views follow first-angle projection: the front view on top, the top view directly below it, and the left view to the right of the front view; the projection orientation yields the right view, so the left view is mirrored by negating X at export time. Views scale to the frame's usable area (never beyond 1:1) and are centred as a group.
- The projection does no hidden-line removal (`hCompound` is empty under `showAll()`): holes and tangent transition edges are drawn as visible lines, so the views show stepped tangent lines; outlines and dimensions are unaffected.
- DXF is R12 (AC1009) and has no Unicode: text is written in cp936 with `$DWGCODEPAGE=ANSI_936`; the diameter sign uses the AutoCAD control code `%%c` (shown as ⌀ once opened) because U+2300 is not in GB2312/936. `render_pdf.py` renders `%%c` as `Ø`, which the built-in Chinese font supports, because that font has no U+2300 glyph.
- Dimension values come from projected-edge matching, with a fallback to 3D bounding-box or cylindrical-face measurement; the annotation rules are grouped by part family (`dim_rules.PART_RULES`) and apply only to the rules whose parameters the table declares, so an undeclared rule goes to manual review. `dimensions.json` entries with `status=manual` need manual review (a rectangular hole pattern has no bolt circle, for example). Shaft parts use their own rule set: the overall length comes from the axial bounding box and each segment diameter from the axial cylindrical faces (`shaft_length` / `shaft_dia_1..3`), following a fixed three-segment design, so a shaft with fewer than three segments sends the surplus rules to manual review. A new part family must be registered in `PART_RULES`, otherwise `sheet.py` fails outright instead of applying the plate rules.
- `shape.scale()` makes `edge.Curve` unreadable in FreeCAD 0.21, so the view scaling multiplies the coordinates by a factor by hand.
- The DWG path of `import2d.py` depends on `dwg2dxf`, which the sandbox does not have, so it stays untested; multi-page PDFs produce `model-2.svg` and the like, and `convert.json`'s `outputs` lists every SVG.
- PDFs have two paths: `render_pdf.py` redraws from the DXF (system Python, no GUI, the path used for deliveries), while `sheet.py --pdf` takes the TechDraw template and needs a GUI (`xvfb-run`), which stays untested headless.
