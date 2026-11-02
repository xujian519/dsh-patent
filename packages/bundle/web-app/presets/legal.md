# Legal agent preset

English | [中文](legal.zh.md)

The `legal` agent preset composes a personal Chinese-law practice agent on the DeepSeek Harness. This bundle declares it in `presets/legal.patch.yml` and ships its content under `skills/legal/`.

## What it mounts

Beyond the standard working rows (shell, filesystem, jobs, reminders, skills, the goal command and tool, plan mode, compaction, delegation, web, and the clock row), the preset adds two deliverable rows: `@deepseek-ai/dsh-doc-template` renders Markdown/DOCX/PDF from reviewed templates and loads the party-document templates through `templateDirs`; `@deepseek-ai/dsh-document-deliver` records the delivered files and runs its deterministic document checks. The persona adds the legal identity, the citation discipline, and the delivery gate.

`tool-web` runs with `search: false` and `fetch: true`. Retrieval goes through the host's Yuandian MCP tools when the official plugin is installed, and through ego lite otherwise: the model runs `ego-browser nodejs` in `tool-bash` and follows the `legal-research` skill, so a search summary never stands in for an inspected source. `web_fetch` stays as a static fallback for public pages when the browser is unavailable. The preset itself declares no legal MCP row; Yuandian is a host plugin, so a profile without it keeps the keyless browser path.

## Yuandian MCP (optional)

Install the official `huayu-yuandian-legal-data` plugin into the same profile as a deployment step. Its tools register as `mcp__yuandian__*` (48 tools at 0.1.6: regulations, cases, companies, and securities compliance) and its four official skills join the catalog. Store the API key through the plugin's settings page or the harness credential store under `YUANDIAN_API_KEY`; never put it in this bundle or a patch file. Yuandian results are discovery and cross-check material: the persona and `legal-research` still require the original official source before a citation supports a conclusion.

## State layout

Every writable path is inside the session workspace, which keeps all mutations under the `workspace-write` sandbox:

- `./.legal/company-profile.md` — shared personal/practice facts.
- `./.legal/practice/<domain>.md` — practice profiles for the thirteen domains.
- `./.legal/references/` — shared references and domain law baselines.
- `./.legal/research/evidence.jsonl` — retrieval evidence.
- `./matters/<slug>/` — case workspace: `matter.md`, `input/`, `work/`, `output/`, `research/`, `audit/matter-log.md`.

Open your legal work root (for example `~/legal-workspace`) as the session workspace. `legal-setup` seeds the templates without overwriting edited profiles.

## Skills

Thirteen imported domain libraries (124 skills) plus one hand-written party-document skill under `skills/legal/handwritten/`, 125 domain skills in total, namespaced so the flat catalog has no collisions:

| Prefix | Skills | Coverage |
|--------|--------|----------|
| `legal-ai-*` | 9 | AI inventory, policy monitoring, use-case triage, AIA generation, vendor AI review |
| `legal-commercial-*` | 11 | NDA, vendor, SaaS/MSA, construction review, renewal tracking, escalation |
| `legal-corporate-*` | 13 | diligence, board minutes, written consent, closing checklist, tabular review |
| `legal-criminal-*` | 6 | case analysis, defense strategy, bail application, compliance non-prosecution |
| `legal-employment-*` | 19 | hiring, termination, classification, wage-hour, investigations, leave |
| `legal-ip-*` | 11 | clearance, FTO, portfolio, OSS review, takedown, cease-and-desist, intake |
| `legal-practice-*` | 4 | consultation analysis, complaint triage, service proposals |
| `legal-research-*` | 5 | authority check, case comparison, issue memo, lecture source pack |
| `legal-litigation-*` | 20 | intake, chronology, claim chart, demand letters, legal hold, hearing outline, Supreme People's Court party-document styles |
| `legal-privacy-*` | 8 | PIA, DSAR, DPA review, policy monitoring, regulatory gap analysis |
| `legal-procurement-*` | 5 | bid review, challenge complaint, contract performance, regime triage |
| `legal-product-*` | 6 | launch review, marketing claims, feature risk, issue triage |
| `legal-regulatory-*` | 8 | feed watching, policy diff, gap surfacing, comments, redrafting |

Five hand-written mode skills:

- `legal-setup` — seed the workspace layout.
- `legal-matter` — create, list, switch, and close cases.
- `legal-research` — ego lite retrieval with an evidence log.
- `legal-citation-check` — verify statutes, interpretations, and cases.
- `legal-quality-gate` — P0/P1 delivery gate and disclaimer.

### Party-document styles

`legal-litigation-party-document-templates` carries the Supreme People's Court's "party reference civil-litigation document styles": 32 leaf categories and 105 forms published 2016-09-28 and retrieved 2026-10-26 (the site's 非诉程序 node is a group), each with its official body and explanatory notes. The skill selects by stage and party type, preserves the official structure, and states that the Civil Procedure Law article numbers in a 2016 form are historical: every citation must be checked against current law before it supports a conclusion. Twelve dedicated doc-template assets cover the common filings (complaints, answers, appeals, retrial, execution, preservation, jurisdiction objection, recusal, authorization letters, and legal-representative certificates); one generic template carries the remaining styles. The body of a court filing carries no AI disclaimer; the disclaimer, the AI-use note, and unresolved items belong in the delivery summary or an internal review memo.

The privacy and product reference baselines include comparative U.S./EU watch lists, labeled `法域提示` at the top of each file. Chinese substantive privacy rules live in `pipil-core-provisions.md`, and the regulatory watcher uses the Chinese regulator list in its skill body.

## Deliberate omissions

`tool-plugin-market`, `present`, and `tool-plugin-manager` stay out: this is a personal composition, and installing or editing plugins is a deployment action taken through the `dsh plugin` CLI. Scheduled agents and cookbooks from the source corpus are not ported in this phase because they depend on Slack, mail, and commercial MCP integrations. Their manual skills remain available, and `tool-schedule` can create reminders; the watcher agents themselves have no running counterpart. The source's `law-student`, `legal-clinic`, and `legal-builder-hub` domains stay out as well: they cover legal education, supervised clinic administration with U.S. jurisdiction bands, and plugin installation rather than personal Chinese-law practice.

## Deliverable limits

`render_doc_template` produces clean Markdown, DOCX, and PDF files. A delivered file passes `output_path`, so the tool writes it and reports the path and byte count instead of returning the document; `docx` requires it. The DOCX path does not preserve tracked changes, comments, footnotes, or inline images. When a matter needs those, deliver a clean copy plus a separate review memo that lists each change, comment, and citation; do not describe the output as a redline.

## Evaluation status

The shipped evidence is the keyless composition test and the preset gates: they prove which skills and tools mount and that the persona carries the citation and gate rules. They do not measure legal output quality. No graded real-case evaluation has been run. Before relying on the mode for live matters, run at least three matters end to end, have a second lawyer score the P0/P1 gate items, and keep the scored results with the matter audit log.

## Source and license

The imported corpus comes from [claude-for-legal-ZH](https://github.com/CSlawyer1985/claude-for-legal-ZH) 1.1.0, Copyright 陈石律师 / CSlawyer1985, licensed under the Apache License 2.0. `skills/legal/LICENSE` and `skills/legal/NOTICE` carry the license and attribution; `skills/legal/SOURCES.md` records the source version and commit. The modifications are listed in the NOTICE: namespaced skill names, rewritten paths and commands, product-name normalization, one matter pointer, ego lite retrieval, and the comparative-law labeling. The surrounding bundle remains MIT.

The party-document style transcriptions in `legal-litigation-party-document-templates` come from the Supreme People's Court website (published 2016-09-28, retrieved 2026-10-26). They are official state documents reproduced as a format reference and are not part of the Apache-licensed corpus; `skills/legal/SOURCES.md` records the source and retrieval date.

## Windows

The mode skills include PowerShell equivalents for workspace setup and matter management; retrieval through `ego-browser` works on Windows with the `%TEMP%` request path documented in `legal-research`.

## Prerequisites

- `ego-browser` on `PATH`; run `ego-browser skill` once per installed version.
- A session workspace the user owns; profiles still containing `[PLACEHOLDER]` require the matching `legal-<domain>-cold-start-interview`.
- A DeepSeek API key for the model. Sessions are personal; enable log upload or telemetry only deliberately.
- Optional: the official Yuandian plugin and a `YUANDIAN_API_KEY` credential for MCP retrieval; without them the ego lite path remains.
