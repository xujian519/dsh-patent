# Document agent preset

English | [中文](document.zh.md)

The `document` agent preset composes a document-delivery agent on the DeepSeek Harness. It builds on the `standard` preset and replaces the persona and plan-mode section with document-delivery ones, adds six delivery skills, and mounts an isolated OpenDesign skill provider that gives the agent the full render-template and design-skill library when an OpenDesign checkout is present.

## What it mounts

Beyond the standard coding rows a document workflow needs (shell, filesystem, jobs, reminders, skills, goals and the `/goal` command, plan mode, compaction, delegation, ask-user, todo, web, and the clock row that gives the model the current date), the preset contributes:

- Six delivery skills in `skills/document/`: `document-brief` (requirement → delivery spec), `document-html` (single-file HTML artifacts), `document-report` (long reports: Markdown → HTML → PDF-ready), `document-deck` (HTML decks + optional PPTX), `document-word` (`.docx` from a template, then officecli for the layout a template does not cover), and `document-quality-gate` (P0/P1 pre-delivery checklist plus the tool-computed checks).
- An **OpenDesign skill provider**: a second `skill-filesystem` instance named `open-design` that mounts the checkout's `skills/` and `design-templates/` directories when `OPEN_DESIGN_DIR` is set — the same wiring as `examples/opendesign`, built in. Without the variable it registers with no roots (an explicit empty catalog), so the preset works standalone.
- A **structured deliverable registration**: the `document_deliver` tool records the delivered files, export formats, and the model's P0/P1 quality-gate claim into the session log, and reads each delivered file to report its own deterministic findings (residual placeholders, undeclared anchors, empty sections, forbidden style words, the declared length budget) on the result. A blocking finding refuses the registration; the P0/P1 claim is recorded, not verified. The [delivery studio](../../../client/ui-document-studio/README.md) derives its file list, gate badges, and machine-check badge from that log entry and its result metadata, so binary outputs produced outside the mutation tools (`.docx`/`.pptx` via officecli, PDFs from the print action) become visible in the studio when registered.
- A **document template and style row**: `doc-template` registers `list_doc_templates` and `render_doc_template` over the packaged template assets, and injects the `assistant-neutral` writing-style guide (`styleGuide`) as a system-prompt section — the same style `document_deliver` checks against, so the words the model is told to avoid and the words the gate checks are one list.
- A document-delivery persona — professional identity; six work disciplines; the standard workflow; and the tool-and-skill guidance (packaged templates, writing style, delivery registration, long-task routing) — and a document-flavored plan-mode section: delivery specs, outlines, template choices, and export lists are "plans" — no deliverable files are produced before approval.

Against the row set `standard` carries, this preset deliberately omits four rows — `tool-plugin-market`, `present`, `tool-plugin-manager`, and `openviking`. `tool-plugin-market` is read-only catalog browsing; installing or removing a plugin is a deployment action taken through the `dsh plugin` CLI, not a step of producing a document. `present` declares an arbitrary accessible file as a deliverable for the client UI, and this mode declares its deliverables through `document_deliver`, which carries the deterministic check results the studio renders; a second declaration channel would split that state. `tool-plugin-manager` writes profile configuration and the host patch ships it disabled; a document delivery has no profile-editing step. `openviking` is opt-in external memory over an HTTP service this composition does not run: a document delivery is grounded in the files and sources the user supplies, not in recalled session history. `scripts/preset-mode-baseline.json` records each reason and holds every delivery mode to the shared row set.

## Skills

Six skills ship in `skills/document/`, forming one pipeline: `document-brief` → outline → `document-html` / `document-report` / `document-deck` / `document-word` → `document-quality-gate` → delivery.

- `document-brief` — captures goal, audience, format, design system, success criteria, and constraints into `brief.md`; the input contract for every other skill.
- `document-html` — single-file `index.html` pipeline; prefers OpenDesign render templates (web-prototype / saas-landing / dashboard), falls back to a built-in baseline.
- `document-report` — `outline.md` plus per-chapter `chapters/*.md` sources assembled into `report.md`, then rendered to `report.html` with TOC, anchors, and footer.
- `document-deck` — `deck.html` horizontal-slide deck with magazine layout; optional `.pptx` via officecli.
- `document-word` — `.docx` from `render_doc_template` (format `docx`): `output_path` is required and writes the file through the session filesystem; the result carries the path and byte count without repeating the package. officecli continues from the same file for headers, footers, page numbers, and TOC fields.
- `document-quality-gate` — P0 and P1 checklist: naming, self-containment, no placeholders, no broken links, sourced facts, accessibility, mobile reflow, budget; plus the table of tool-computed checks, which the registration refuses on a blocking finding. No delivery without passing P0 is the agent's own discipline: the tool records the P0/P1 claim beside its machine checks instead of verifying it.

## Prerequisites

None. The preset is fully functional standalone. For the OpenDesign enhancement, clone OpenDesign and export its root:

```sh
git clone https://github.com/nexu-io/open-design.git
export OPEN_DESIGN_DIR="$PWD/open-design"
```

The `open-design` skill provider then catalogs that checkout's 276 skill and template directories (measured against open-design main 0.20.3). `document-word` additionally benefits from a user-level `officecli` skill when present; without it the agent delivers Markdown and says so.

## Model Experience

The model sees the Chinese document-delivery persona (four sections: professional identity; six work disciplines — deliverables are files, unsourced facts are withdrawn, no invented brands, self-contained output, mandatory HITL confirmation points, mandatory quality gate; the standard workflow; and the tool-and-skill guidance for packaged templates, writing style, delivery registration, and long-task routing), the document plan-mode section, the six preset skills plus any OpenDesign skills (when mounted), and the standard coding tools.

## Known Limitations and Deferred Work

- **PDF is export guidance, not a renderer** — `document-report` / `document-html` deliver self-contained HTML; PDF export happens through the delivery studio's print action (desktop print-to-PDF or browser print), not inside the preset. The host also runs an Office→PDF conversion (`office-to-pdf`) that feeds the sidebar's Office preview; it is not a delivery path.
- **`document-word` needs an Office skill that this preset does not mount** — the first-party `skill-office` row is composed by the desktop host, not by the web bundle, so a web session relies on a user-level `officecli` skill. Without either, the agent falls back to Markdown and says so.
- **OpenDesign skills are optional** — without `OPEN_DESIGN_DIR` the agent uses the built-in baseline templates; template variety is reduced but delivery is not blocked.
- **The panel does not render binaries inline** — for `.docx`, `.pptx`, and `.pdf` the studio offers "Preview in sidebar" and hands the file to `ui-sidebar-documentpreview`; only Markdown and HTML render inside the panel.
- **`document_deliver` registers, it does not convert** — the tool only checks that a declared file exists in the session workspace; PDF export or binary conversion still needs the matching pipeline step (print action / officecli), and files saved outside the workspace cannot be registered.
- **No delivery gate, unlike patent mode** — patent mode refuses its render and filing tools until the round's rule, citation, and archive runs have succeeded; this preset declares no `deliveryGate` at all, and a session can end with an unregistered deliverable. The bytes are written before `document_deliver` is called and no tool follows it, so there is no later call for a prerequisite to precede. The consequence, the two rejected designs, and what the tool does guarantee are recorded in [the tool's README](../../../document/document-deliver/README.md).
