---
description: "Domain-neutral statute-citation family: the law-core library both the legal and the patent domains consume for citation text, reference extraction, overlap scoring, and the per-article citation decision."
kind: "package-group"
---

# law/ — domain-neutral statute-citation family

English | [中文](README.zh.md)

## Summary

The law group carries the statute-citation machinery that is neither legal-domain nor patent-domain: one decision rule for statute-article citations, plus the citation text, reference extraction, overlap scoring, and tool scaffolding the rule is assembled from. Domain packages keep their own grammars, indexes, tool names, and messages; only the shared mechanics live here.

## Packages

| Package | Role |
|---|---|
| [`law-core/`](law-core/README.md) | Domain-neutral statute-citation library consumed by `dsh-legal-law` directly and by `dsh-patent-law` through the `dsh-patent-core` re-export |
