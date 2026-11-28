# Agent Note: Fall back to PatSnap when Google Patents cannot deliver a PDF

Status: implemented

English | [中文](2026-11-28-patent-pdf-patsnap-fallback.zh.md)

## Problem

`patent_pdf_download` served China publication numbers through CNIPR first and everything else through Google Patents. Both legs fail in ways the deployment cannot absorb: Google enters minute-scale HTTP 503 windows through the local proxy (the 2026-10-03 audit measured 89 of 106 failures as 503), and CNIPR's download leg depends on an ego lite login, serves one number at a time under an explicit anti-scraping notice, and is the channel most often rate-limited in practice. Coverage also differs by jurisdiction and document type: Google Patents misses many Chinese utility models and designs, while the CNIPR path is limited to China.

A paid alternative was already available: PatSnap Open Platform's P020 endpoint returns a patent PDF URL by publication number, and the trial ships 10,000 credits. Before this change it was only reachable through MCP servers or ad-hoc scripts, so the tool had no deterministic, billable fallback and reports could not name the channel that produced a document.

## Decision

`patent_pdf_download` tries Google Patents first and hands only the items whose downloaded body is not a valid PDF to PatSnap. The order is a property of the tool, not the browser runner: the failure that matters (an HTTP error, an HTML page, a body without the PDF magic) is decided after the download attempt, so the runner returns Google's candidate URL and the tool applies the fallback.

The PatSnap leg is a new channel in `@deepseek-ai/dsh-patent-data` (`createPatsnapChannel()`), built on P020 with a bearer key read from the environment variable named by `Config.patsnapApiKeyEnv`. It is off by default (`Config.patsnapEnabled`), sends publication numbers in batches of `Config.patsnapBatchSize`, and returns per-number results plus the gateway's `x-openapi-amount` total. A missing key throws rather than returning an object that can only fail; the tool catches channel-level failures into `warnings` and keeps the original per-item failure.

CNIPR leaves the download path. The channel stays for legal status, keyword search, and China metadata, where its published fields and login state remain useful.

P020's measured behavior decided the channel's edge cases. A successful record costs one amount unit and a batch of five costs five; a number the service cannot serve is silently omitted and costs nothing; a batch whose numbers all lack a PDF returns `68300008`, which the channel maps to per-number `not_found` instead of a channel failure. Business failures arrive with HTTP 200, so the channel parses `status`/`error_code`, while `6720000x` stays a channel-level classification. `replace_by_related` returns `pn_related`, surfaced as `resolvedNumber` so a report does not present a family member as the requested document.

## Alternatives considered

**Keep CNIPR first for China numbers and add PatSnap after it.** Rejected: the deployment asked for Google first, and CNIPR's login state, anti-scraping limits, and per-number page interaction make it the least suitable leg for batch downloads. Its strengths are legal status and China search, not PDF volume.

**Drive PatSnap through its MCP server.** Rejected for the tool path: a model-mediated call is nondeterministic, spends tokens in addition to credits, and cannot participate in the tool's per-item budget or MANIFEST resume. MCP remains the right surface for interactive agent use.

**Put the PatSnap leg inside `createDownloadChannelRunner`.** Rejected: that runner only produces candidate URLs, and a Google CDN 403/timeout is discovered by the tool's fetch fallback after the runner returns. A fallback there would miss the most common failure. The runner stays Google-only and the tool owns the second attempt.

**Make PatSnap primary.** Rejected: Google is free and broad, and the trial's 90-day window and 10-request-per-minute limit make it unsuitable as the default. The fallback is the role that matches the measured behavior.

## Consequences

Every download item still names one channel. A fallback success names PatSnap and carries the Google failure in `warnings`; a family substitute adds `resolvedNumber`. A missing key or exhausted quota is visible in `warnings` instead of silently dropping the fallback, and the item keeps its original failure.

`timeoutMs` remains a per-leg budget: the Google leg and the PatSnap leg each receive it, so a fully degraded call can take twice the stated budget. This matches the existing contract and keeps the CNIPR-era test expectations meaningful.

The fallback spends credits only for records PatSnap returns. Invalid numbers never leave the process; omitted numbers cost nothing; duplicates are deduplicated before the request. A 50-patent batch issues at most three P020 requests at the default batch size, which absorbs the trial's 10-request-per-minute limit.

The channel's HTTP contract is PatSnap's: the P020 path, the `status`/`error_code` envelope, and the `x-openapi-amount` header. A protocol change surfaces as `invalid_response` or an empty result rather than a silent miss. The trial PDFs are official office documents without a visible watermark in the measured sample; redistribution still follows the platform terms.

The tool description, the output schema (`resolvedNumber`), and the patent preset changed, so the tool catalog, the package READMEs, the upgrade guide, and the recorded tool-schema expectation move with this change.
