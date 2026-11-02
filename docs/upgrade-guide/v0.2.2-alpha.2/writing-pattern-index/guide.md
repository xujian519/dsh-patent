---
kind: upgrade-guide
description: "The writing-patterns:skills section carries a compact index instead of every pattern's steps, and stagePatterns maps workflow stages to 3–5 patterns."
---

# Writing patterns become an index with per-stage selection

English | [中文](guide.zh.md)

## Change

The `writing-patterns:skills` system-prompt section now carries a `<pattern_index>` block: one line per pattern with its id, category, and name. It no longer compiles each pattern's summary, steps, do-rules, and do-not-rules into the prompt. At the shipped corpus the index is 1,819 characters; the former ten-pattern block was 17,461 characters, and compiling the current eighteen patterns in full would take 27,234 characters. A model retrieves a pattern's body through `query_writing_patterns`.

`sectionCategories` now selects which patterns the index lists. The shipped corpus grows from ten patterns to eighteen, adding a three-step self-check against the closest prior art, the A26.3 embodiment matrix, article 33 amendment reserves, unity of invention, functional limitations, the software method/device/medium trio, Markush equivalents, and numeric-range fallback.

The plugin adds the optional `stagePatterns` configuration: a map from workflow stage id to 3–5 pattern ids. Mounting the plugin resolves the map against the loaded corpus and provides the `writingPatterns` service (`patternsForStage`, `compiledForStage`, `stageIds`); an atom reads its stage's patterns there. An unknown or duplicate pattern id, or a count outside 3 to 5, fails the plugin load. Asking the service for a stage the deployment did not declare throws. The shipped `patent` preset declares maps for `draft_claims`, `draft_specification`, `spec_check`, `enablement_report`, `claim_breadth`, and `response-plan`.

This affects deployments that pin or parse the prompt section, presets that set `sectionCategories`, and atoms or scripts that expect the full pattern text in the prompt.

## Migration

1. Call `query_writing_patterns` before drafting from a pattern; the section no longer carries steps or rules.
2. Stop parsing `<writing_skills>` out of the section. Read `<pattern_index>` for the available ids, or call `compileWritingSkills` when you need the full block.
3. Declare `stagePatterns` for each stage whose atom should read patterns; list 3 to 5 ids that exist in the loaded corpus.
4. If `patternDir` replaces the shipped corpus, make every id referenced by `stagePatterns` exist there, or the plugin fails to load.
5. Re-record any snapshot that pins the `writing-patterns:skills` section text, and review the smaller index before committing it.
