---
description: "Domain-neutral shared-mechanics family: the statute-citation library and the knowledge-database query library both the legal and the patent domains consume."
kind: "package-group"
---

# law/ — domain-neutral shared-mechanics family

English | [中文](README.zh.md)

## Summary

The law group carries the mechanics that are neither legal-domain nor patent-domain: the statute-citation machinery one decision rule is assembled from, and the knowledge-database query machinery the SQLite engines are assembled from. Domain packages keep their own grammars, indexes, tables, filters, tool names, and messages; only the shared mechanics live here.

## Packages

| Package | Role |
|---|---|
| [`law-core/`](law-core/README.md) | Domain-neutral statute-citation library consumed by `dsh-legal-law` directly and by `dsh-patent-law` through the `dsh-patent-core` re-export |
| [`knowledge-core/`](knowledge-core/README.md) | Domain-neutral knowledge-database query library consumed by `dsh-legal-knowledge` and `dsh-patent-knowledge` directly; `dsh-patent-core` re-exports it for the patent domain's existing import surface |
