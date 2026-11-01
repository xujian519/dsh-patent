---
description: "Service Definition for the patent data seam (`ctx.patentData`): the LRU-cached search provider factory over the vendored [`@deepseek-ai/nuo-patent`](../../../vendor/nuo-patent/README.md) engine, the structured metadata mapper, the patent result cache, the ego-browser anti-crawl session runner over the injected subprocess service, and the CNIPR (search.cnipr.com) channel that serves Chinese patent full text, legal status, and keyword search over that session, plus the persistence and case-path helpers ported from Sati. Consumers own every model-facing surface; this package resolves and serves patent data."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-data

English | [中文](README.zh.md)

## Summary

Service Definition for the patent data seam (`ctx.patentData`): the LRU-cached search provider factory over the vendored [`@deepseek-ai/nuo-patent`](../../../vendor/nuo-patent/README.md) engine, the structured metadata mapper, the patent result cache, the ego-browser anti-crawl session runner over the injected subprocess service, and the CNIPR (search.cnipr.com) channel that serves Chinese patent full text, legal status, and keyword search over that session, plus the persistence and case-path helpers ported from Sati. Consumers own every model-facing surface; this package resolves and serves patent data.

## Table of Contents

- [Service](#service)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Service

The `PatentData` service injects `subprocess` and exposes three capability methods.

### createSearchProvider(options?)

Builds a nuo-backed `StageProvider` whose `search(query, { maxResults })` maps source hits to the `{ title, snippet, url }` stage vocabulary. Without `options.search` it wraps the nuo `searchPatents` in the LRU cache, so a repeated query within the TTL reuses the cached result instead of re-spawning the network path; only non-empty successful answers are stored, so a parse-degraded zero-hit reply cannot pin a transient failure for the whole TTL.

### createEgoSession(options?)

Builds an `EgoBrowserSession` over the injected `ctx.subprocess`. The runner checks ego-browser availability, probes the connection, names session-scoped task spaces, and runs scripts verbatim through stdin (the subprocess seam's batch stdin replaces the single-quoted heredoc, so script content is never shell-expanded). `options.runner` overrides the subprocess-backed default, and the deployment's `Config` supplies the command name, the probe and run deadlines, and the output cap; a per-call option overrides each of those.

### createCniprChannel(options?)

Builds the CNIPR channel over an ego-browser session, or returns nothing while the deployment leaves `Config.cniprEnabled` off — the caller then keeps its own channel for every number instead of holding an object that can only fail. The channel resolves the number form itself (`classifyCniprNumber`): publication numbers (`CN122072823A`) get their full-text PDF links, application numbers (`202311356097.5` / `2023113560975`, dotted before the check digit) get their legal-status records, and anything else is reported per number as unsupported; a keyword query gets the result page rows. All three capabilities run one generated script through the injected session (`cnipr-script.ts`), parse its receipt in this package (`cnipr-receipt.ts`), and reuse one named task space so the ego lite login state and tab carry over between calls. A per-number failure (number not found, no application number resolved) is a result entry; a channel failure (ego-browser missing, deadline exceeded, no receipt, expired login) throws `CniprChannelError` with a code the caller routes on.

## Configuration

cordis.yml `Config` declares the ego-browser values and the CNIPR page waits a deployment varies; a per-call option overrides the same-named field.

| Key | Default | Meaning |
| --- | --- | --- |
| `commandName` | `ego-browser` | CLI command name. |
| `probeTimeoutMs` | `8000` | Connection-probe timeout in milliseconds. |
| `defaultTimeoutMs` | `90000` | Default run timeout in milliseconds. |
| `maxTimeoutMs` | `300000` | Hard cap for a per-run timeout. |
| `maxOutputBytes` | `500000` | Soft cap in bytes for the merged output; truncation keeps whole UTF-8 characters. |
| `nuoRequestChannel` | `auto` | Channel nuo's requests travel over: `auto` keeps nuo's own availability probe and leaves the environment untouched, `native` forces the plain fetch, `browser` the ego-browser path, and `fallback` keeps the plain fetch first while retrying connection failures through the browser. Any explicit value writes the process-wide `NUO_PATENT_EGO_BROWSER`, because that variable is the only switch nuo exposes; the service restores the value it replaced when it disposes. The variable is process-wide, so explicit choices from multiple mounts are last-writer-wins. |
| `cniprEnabled` | `false` | Whether the deployment may serve Chinese patent full text, legal status, and keyword search through CNIPR. The channel reuses the ego lite login state on `search.cnipr.com`, so a deployment without that session gains nothing by enabling it; `createCniprChannel()` returns nothing, and the consuming tool keeps searching through the nuo engine and names the channel it used. |
| `cniprLoginPollMs` | `1000` | Login-state poll interval in milliseconds. |
| `cniprLoginAttempts` | `10` | Login-state poll attempts per round. |
| `cniprLoginRounds` | `2` | Login-state poll rounds; every round but the last reloads the home page. |
| `cniprNavigationTimeoutMs` | `45000` | Page-navigation deadline in milliseconds: home `goto`/reload and the search result URL. |
| `cniprActionTimeoutMs` | `15000` | Click and form-submit deadline in milliseconds. |
| `cniprResultTimeoutMs` | `30000` | Deadline in milliseconds for the result-page structures: detail-search form, legal-status form and result URL, pagination marker. |
| `cniprRenderTimeoutMs` | `20000` | Deadline in milliseconds for rendered content: result rows, application number, legal-status result heading. |
| `cniprDetailTimeoutMs` | `20000` | Deadline in milliseconds for the detail-search XHR that carries the full-text link. |

The remaining options are per-call only: they are test seams or values this service cannot know.

| Method | Key | Default | Meaning |
| --- | --- | --- | --- |
| `createSearchProvider` | `search` | LRU-cached nuo `searchPatents` | Underlying search function injection. |
| `createEgoSession` | `homeDir` | `os.homedir()` | Home directory locating `~/.local/bin`. |
| `createEgoSession` | `pathEntries` | `[<home>/.local/bin]` | Extra PATH directories injected into the spawn env and checked by the availability probe. |
| `createEgoSession` | `platform` | `process.platform` | Platform override. |
| `createEgoSession` | `env` | `process.env` | Environment override. |
| `createEgoSession` | `runner` | subprocess-backed runner | Spawn runner injection for tests. |
| `createCniprChannel` | `timeoutMs` | session `defaultTimeoutMs` | Deadline for one CNIPR script run. |
| `createCniprChannel` | `pageBudgets` | the resolved `Config` values | Per-wait overrides for one channel; a field replaces only that wait. |
| `createCniprChannel` | `cwd` | `process.cwd()` | Working directory of the script subprocess; the script writes nothing. |

## Model Experience

None, as the data seam resolves and serves patent data to the tool layer; dsh-patent-tools owns every model-facing schema and result.

#### KV Cache effect

Independent; the data seam registers no prompt, tool schema, or result of its own.

## Known Limitations and Deferred Work

- **External `ego-browser` CLI dependency** — the anti-crawl scrape path needs the external `ego-browser` (ego-lite) CLI installed and on the PATH (macOS only); the package ships no ego-browser script assets (Sati's `skills/ego-browser/` holds only learnings), so site anti-crawl upgrades are maintained outside this package.
- **nuo's browser path opens its own `ego-browser` process** — nuo 2.3.2 reads the browser response body through an in-page `fetch`, so a JSON viewer extension no longer turns the search XHR into HTML; `fallback` keeps the plain fetch first and retries connection failures through the browser. The browser path still spawns `ego-browser nodejs` outside the harness `ctx.subprocess` seam (128 MB output cap, no tree kill on abort), so a deployment that must keep all subprocesses under the seam sets `nuoRequestChannel: native`. The dsh-side ego session still covers the pdf-download path through the seam.
- **CNIPR channel scope and upkeep** — the channel drives `search.cnipr.com` through ego lite, so it needs that login state and it inherits the platform's limits: the site states it does not support scraping, which is why the channel takes one number at a time through ordinary page interaction and never batches or parallelizes. The channels created by one `PatentData` service share a serial queue, because every script reuses the same named task space and tab; concurrent tool calls in that service wait instead of driving the same page. The queue is service-scoped: separate dsh processes, and multiple services mounted against one ego lite profile, can still collide, so a deployment should run one CNIPR-serving patent-data mount per ego profile. Its page contracts (search box, detail-search POST, legal-status form, the result-row fields, the `pic.cnipr.com/pdfcn/...` link pattern) are the site's, so a site change surfaces as `page_state` on the first call rather than as a silent empty answer — the receipt either parses or it does not. Legal-status records come from the results page text, and a page that lists no records yields a null count rather than an invented zero. Search reads the result rows directly (they carry title, applicant, publication date, and abstract, so no per-record detail fetch is needed); the page shows ten rows and its 20/30-row options are refused for this deployment's account tier, so a larger `limit` is served by turning the site's own result pages, capped at three pages per call. Those two limits are site/account protocol values and stay fixed; every other page wait is a `Config` field so a slow host, a login-state refresh, or a site change is tuned without a release.
- **CNIPR live probe** — `tests/cnipr-live.e2e.ts` drives the real site end to end and is opt-in through `DSH_CNIPR_LIVE=1`; it skips without that switch or without `ego-browser`, and it consumes the deployment's CNIPR login state.
- **Consumer wiring** — the search provider and ego-session runner are consumed by `dsh-patent-tools` (patent_search/metadata/legal_status and patent_pdf_download); the CNIPR channel is consumed by `patent_pdf_download` (China full text), `patent_legal_status` (China legal-status records), `patent_search` (China keyword search when the engine fails or returns no hits), and `patent_metadata` (China publication numbers the engine fails, throws on, or cannot find). The cache, mapper, persistence, and path modules stay library exports for those consumers.

### Dev Note

None.

This package publishes no invariant companion: the data seam serves callers on demand and holds no package-owned persistent event stream; search and ego-browser runs are consumed by the tool layer, which owns the model-visible and session-log relationship.
