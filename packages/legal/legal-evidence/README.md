---
description: "Legal evidence triple-attribute assessment for the DeepSeek Harness: deterministic scoring of relevance, legality, and authenticity for the eight statutory evidence types under PRC Civil Procedure Law Art. 66, with the evaluate_legal_evidence tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-evidence

English | [中文](README.zh.md)

## Summary

Legal evidence triple-attribute assessment for the DeepSeek Harness: deterministic scoring of relevance, legality, and authenticity for the eight statutory evidence types under PRC Civil Procedure Law Art. 66, with the evaluate_legal_evidence tool.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Evidence types](#evidence-types)
- [Scoring and rules](#scoring-and-rules)
- [Tool](#tool)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

A legal evidence assessment has to say the same thing twice for the same input, and it has to separate what the record states from what a reviewer inferred. This package scores the three attributes the law asks about — relevance, legality, and authenticity — from the evidence record's own fields and a YAML rule set, with no model call. The same engine backs the library API and the `evaluate_legal_evidence` tool, so a caller and the model see one verdict.

<a id="evidence-types"></a>
## Evidence types

The eight statutory types are `party_statement`, `documentary`, `physical`, `audio_visual`, `electronic`, `witness_testimony`, `expert_opinion`, and `inspection_record`, exported as `LEGAL_EVIDENCE_TYPES`. Each type has its own evaluator: documentary evidence checks the original and its signature; electronic evidence checks the recorded hash, timestamp, and storage integrity; witness testimony checks the relationship disclosure and corroboration; expert opinions check qualification, procedure, and conclusion clarity; inspection records check witnesses and completeness. Evidence types without a type-specific evaluator use the generic dimension judgments.

<a id="scoring-and-rules"></a>
## Scoring and rules

`LegalEvidenceEngine` combines the three dimension judgments into a weighted overall score; `DEFAULT_LEGAL_WEIGHTS` is `0.35` relevance, `0.30` legality, and `0.35` authenticity, and the shipped `assets/legal-evidence-rules.yaml` declares the same weights. `parseLegalRuleSet` reads the weights and declarative rule metadata; a rule names its evidence type, check, severity, statutory basis, and required conditions. The weights drive scoring. The two `general` rules (`LEGAL-EVI-GEN-001` fact-to-prove and `LEGAL-EVI-GEN-002` collection legality) are enforced by the engine for every evidence type and only emit a finding on failure. The remaining type-specific checks live in the per-type evaluators, so the YAML documents those checks and supplies the weights; a rule-table test locks the YAML-to-finding correspondence. Loading the plugin fails when the rules file is missing or unparseable; individual rule entries that fail validation are warnings and are logged. Each assessment carries per-dimension scores and reasoning plus the findings its evaluator and the general rules produced.

<a id="tool"></a>
## Tool

`evaluate_legal_evidence` accepts the evidence id, type, source, content, fact to prove, and the type-specific booleans and strings (original, signature, formation time, hash and its verification, timestamp, storage integrity, witness conflict and disclosure, corroboration, expert qualification and procedure, inspection witness and completeness, collection and form legality, burden holder, standard) and returns the assessment plus a summary line. Input that names no evidence id is rejected; the evaluation itself is deterministic and makes no model request.

<a id="model-experience"></a>
## Model Experience

### evaluate_legal_evidence tool

#### What the model sees

One registered tool named `evaluate_legal_evidence` with the evidence fields above; `evidenceId` and `evidenceType` are the identifying pair, and the type-specific fields describe what the record states, not what a reviewer concluded. The result carries the assessment — evidence id and type, the four scores, and the three dimension judgments with their level and reasoning — plus the rule findings and a short summary. The tool description states the eight evidence types, that scoring is deterministic, and that a score below `0.5` needs corroboration or another proof channel.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is one assessment object plus a short summary, resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The score is a rule-driven heuristic, not a legal judgment.** It measures whether the record carries the fields the rules ask for; it does not decide admissibility, weight, or whether the evidence proves the fact. A high score on a record with false fields is still a false record.
- **Missing answers default conservatively.** An absent boolean about originals, signatures, or verification reads as unanswered and lowers the dimension score; the engine does not infer a fact the caller did not state.
- **The weights are deployment-tunable, the rules are not.** `DEFAULT_LEGAL_WEIGHTS` and the shipped YAML agree, but a deployment can change the weights without changing the rule set; the two are checked separately.
- **Type coverage is the eight statutory types only.** A record that names another evidence form has no type-specific evaluator and is judged by the generic dimensions.
- **No model call.** The tool never asks a model to score; a caller that needs a narrative explanation must produce it from the returned judgments.

### Dev Note

None.
