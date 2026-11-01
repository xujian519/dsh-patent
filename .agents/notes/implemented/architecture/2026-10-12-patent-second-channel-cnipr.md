# Agent Note: Serve Chinese patent full text and legal status through a second channel

Status: implemented

English | [中文](2026-10-12-patent-second-channel-cnipr.zh.md)

## Problem

Patent search work left the managed tools. Over the 2026-08-14 → 2026-10-11 corpus, sessions reached CNIPR through ad-hoc scripts 78 times and CNIPA 38 times while the bundled tools failed on their only channel: `patent_search` 41.6% (52/125) and `patent_metadata` 62.1% (54/87) of calls after 2026-10-03, with 89 of 106 failures being HTTP 503 from Google Patents through the local proxy. The same issue's trail had already established that the failure lives at the upstream channel, not in the tools: bounded retry (1.6 s of backoff against a minute-scale quota) and call spacing cannot absorb it, and the window is measured in hours. A bypass script is a working channel, but nothing in the tool layer records the channel a fact came from, and the deployment's discipline — verify one key fact through two independent channels — cannot be mechanically checked when one of them is a shell pipeline.

The registered next step was therefore the one that does not depend on the upstream recovering: make the already-verified CNIPR channel a provider of the patent data seam. What CNIPR publishes decided the shape: its search result rows carry publication numbers, titles, applicants, publication dates, abstracts, whether a record is an examination publication or a grant, and the `pic.cnipr.com/pdfcn/...` full-text link; they carry no inventorship, classification, citation, or filing-date fields. Its legal-status query returns dated status records for one application. So CNIPR serves Chinese keyword search, Chinese metadata for a publication number, Chinese full text, and Chinese legal status.

## Decision

`@deepseek-ai/dsh-patent-data` gains a CNIPR channel (`createCniprChannel()`, `cnipr-channel.ts`) beside the nuo search provider and the ego-browser session runner. It returns nothing while the deployment leaves `Config.cniprEnabled` off (default `false`), so a consumer holds no object that can only fail. Three capabilities (full-text links, legal status, and keyword search) share one generated script (`cnipr-script.ts`), one receipt parser (`cnipr-receipt.ts`), and one named ego task space, which is what carries the ego lite login state and tab between calls.

Number form selects the channel and each result names the one that served it:

- `patent_pdf_download` sends China publication numbers to CNIPR for their full-text link and leaves every other number — and every number CNIPR could not serve — to the Google Patents leg (ego-browser response-body capture, then the browser-free scrape). Every item carries `channel`, so a report cites the channel that produced the document instead of inferring it from `pdfUrl`.
- `patent_legal_status` retries through CNIPR the numbers whose nuo result is missing, failed, or `UNKNOWN`; a number CNIPR has records for becomes a CNIPR item whose `status` is the record with the newest announcement date and whose `events` are all its records. A number CNIPR has nothing for keeps the engine's own reason.
- `patent_search` re-searches through CNIPR when the nuo result is failed or empty, and skips the channel for queries carrying Google field syntax (`assignee:`, date ranges) because CNIPR does only keyword search. A served result names CNIPR and carries the rows it publishes; a consulted-but-unserved channel is reported in `warnings`.
- `patent_metadata` re-looks-up a China publication number (`CN218483312U`) through CNIPR when the nuo result failed, threw, or reported no record for it; only the fields CNIPR publishes are filled (title, assignee, publication date, abstract), the rest stay empty, and an invalid number is not re-looked-up because its defect belongs to the number itself. A served result names CNIPR; a consulted-but-unserved channel goes into `warnings`, and a call that still fails appends that warning to the failure text.

A per-number failure (number not found, no application number resolved) is a result entry. A channel failure (ego-browser absent, deadline exceeded, no receipt, expired login) throws `CniprChannelError` with a code the caller routes on; the consuming tool reports it in `warnings` and hands the numbers to the other channel rather than failing the batch. Failover happens on channel-level failure only: a genuine zero-hit result stays a zero-hit result, because the upstream discards the total that would distinguish it from a parse failure.

The package owns the CNIPR page scripts. They are generated with their parameters embedded, because ego's Node runtime takes a script only on stdin and inherits no environment; the deployment skill's fixed-path request file exists for that constraint and is unnecessary in-repo. Page text comes back verbatim and the parsing, number classification, and result alignment live in tested pure functions; only the login gate and the result-page render check stay in the script.

## Alternatives considered

**Make CNIPR the primary `patent_search` provider.** Rejected: its rows carry title, applicant, publication date, and abstract but no URL, priority date, or Google field syntax, so the tool would silently drop fields it documents, and this account tier serves ten rows per page so a larger `limit` costs up to three page turns. It serves as the second channel instead — consulted only when the engine fails or returns no hits, skipped for queries carrying field syntax.

**Deliver the CNIPR download channel as a fallback behind the Google Patents leg for China numbers.** Rejected because the bypass evidence rules it out: `patent_pdf_download` already succeeded on every call after its capture fix (0/33), and Chinese PDF direct-link bypasses still ran 41 times across 12 sessions with only one session overlapping the tool's. A channel the model only reaches after a failure does not displace the script it already trusts.

**Have the deployment config point at the skill's scripts (`cniprScriptPath`) instead of owning them.** Rejected for this deployment: it keeps zero copies, but the channel is then unavailable wherever nobody configures a path, the receipt contract has no type or test behind it, and the shipped preset — the deployment that uses it — would have to reach into the user's skill directory. The package README states which copy serves the bundled tools.

**Drive both capabilities through one script run.** Rejected: a batch of legal-status queries and a batch of link extractions have different page sequences, the results would be far apart, and the two tools call them at different times.

## Consequences

Chinese full text, Chinese legal status, Chinese keyword search, and Chinese metadata for a publication number now arrive through managed tools that name the channel that served each item or call, so a report's channel facts are traceable to the call record. A CNIPR failure is visible instead of silent: `warnings` names the channel that was consulted without serving, which is also how a deployment learns its CNIPR login state expired.

The deployment now depends on that login state for Chinese numbers. With `cniprEnabled` on and the session expired, `patent_pdf_download` and `patent_legal_status` take one CNIPR round trip before falling back to Google Patents, while `patent_metadata` and `patent_search` take the Google Patents leg first and then the CNIPR round trip; either way the result names the channel that served it and warns about the one it consulted without serving. Enabling the channel therefore belongs to deployments that maintain an ego lite login on search.cnipr.com, which the shipped patent preset does.

The channel's page contracts are the site's: search box, detail-search POST, legal-status form, and the `pic.cnipr.com/pdfcn/...` link pattern. A site change surfaces as `page_state` on the first call rather than as a silent empty answer; the receipt either parses or the channel fails loud. The site states it does not support scraping, so full-text and legal-status work one number at a time through ordinary page interaction and the keyword channel turns the site's own result pages; no call batches or parallelizes.

`patent_pdf_download` now reports a `channel` per item and a `warnings` array, `patent_legal_status` the same, and `patent_search` and `patent_metadata` report the serving `channel` plus a `warnings` array; the MANIFEST records the channel that produced an entry (entries written before this change carry none and resume without a channel name). The model-visible schemas changed, so the tool catalog and the patent session's schema sidecar moved with them.

The channel adds request volume to CNIPR when a session downloads Chinese patents, checks Chinese legal status, looks up Chinese publication metadata, or searches and the engine fails or finds nothing. Its budget is the deployment's `defaultTimeoutMs` on the session, and the download leg shares the call budget with the Google Patents leg (half, floored at the ego default) so that a CNIPR failure cannot consume the whole batch.
