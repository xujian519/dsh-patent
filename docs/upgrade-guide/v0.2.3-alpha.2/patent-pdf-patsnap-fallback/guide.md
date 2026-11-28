---
kind: upgrade-guide
description: "patent_pdf_download now tries Google Patents first and falls back to PatSnap's P020 API for numbers it cannot turn into a valid PDF; CNIPR no longer serves downloads."
---

# Patent PDF download falls back to PatSnap

English | [中文](guide.zh.md)

## Change

`patent_pdf_download` no longer sends China publication numbers to CNIPR. Every number goes to the Google Patents leg first — ego-browser response-body capture, then a browser-free CDN scrape plus fetch — and only a number whose body is not a valid PDF is handed to PatSnap.

The PatSnap leg is `@deepseek-ai/dsh-patent-data`'s new P020 channel (`createPatsnapChannel()`). It is off by default and enabled by `Config.patsnapEnabled`; the API key is read from the environment variable named by `Config.patsnapApiKeyEnv` (default `PATSNAP_API_KEY`), never from `cordis.yml`. New Config fields: `patsnapEnabled` (`false`), `patsnapApiKeyEnv` (`PATSNAP_API_KEY`), `patsnapBaseUrl` (`https://connect.patsnap.com`), `patsnapTimeoutMs` (`30000`), `patsnapBatchSize` (`20`, 1–50), and `patsnapReplaceByRelated` (`true`).

Each item keeps `channel`, which now names `Google Patents（nuo 引擎）` or `PatSnap（智慧芽）`. A family substitute adds `resolvedNumber` (the publication number actually printed on the PDF). Warnings name a channel that was consulted without serving, including a missing key or exhausted quota. `timeoutMs` remains a per-leg budget: the Google leg and the PatSnap leg each get it, so a fully degraded call can take twice the stated budget.

Affected: deployments that enabled `cniprEnabled` for downloads, callers that read `channel` or the rendered download summary, and anyone who pinned the `patent_pdf_download` output schema.

## Migration

1. Create a PatSnap Open Platform key (`sk-…`) and export it as `PATSNAP_API_KEY` (or point `patsnapApiKeyEnv` at another variable). A deployment that leaves `patsnapEnabled` off keeps the old Google-only behavior.
2. Where the patent preset is copied, add `patsnapEnabled: true` and the key variable name under `@deepseek-ai/dsh-patent-data`. The shipped patent preset enables it.
3. Reports that cite the channel for a download now expect `PatSnap（智慧芽）` on fallback items; a family substitute must cite `resolvedNumber` as the document's number.
4. Refresh the recorded tool-schema expectation with no key: `pnpm run test:snapshot:refresh`, then `pnpm run test:snapshot`. The tool description and the `resolvedNumber` output field changed.
5. CNIPR remains enabled for legal status, keyword search, and China metadata; it is no longer consulted by `patent_pdf_download` even for China publication numbers.

- Without `PATSNAP_API_KEY`, download a number Google cannot serve and confirm the item stays failed with the original reason plus a warning that names the missing key.
- With the key, repeat the call and confirm the item succeeds with `channel: PatSnap（智慧芽）`, a `resolvedNumber` when the response substituted a family member, and a warning naming the Google failure.
- A 50-patent batch must issue at most three P020 requests (`patsnapBatchSize: 20`) and charge only the records it returned.
