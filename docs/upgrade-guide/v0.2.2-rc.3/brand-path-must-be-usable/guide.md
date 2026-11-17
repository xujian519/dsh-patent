---
kind: upgrade-guide
description: "A configured brandPath that cannot be read now fails render_patent_document instead of silently rendering the default brand."
---

# A configured brand path must be usable

English | [中文](guide.zh.md)

## Change

`render_patent_document` used to fall back to the default brand whenever `brandPath` existed but could not be read: a mistyped path, malformed JSON, or a missing `documents.patent` namespace produced no warning and the rendered document carried the default firm, disclaimer, and colors.

A `brandPath` the caller supplied is a configuration decision, so an unusable one now fails the call with `DocumentRenderError` (reported as `invalid_tool_input`): the file is missing or unreadable, the JSON is malformed, the top level is not an object, `documents.patent` is not an object, or a value inside it is not a string. Omitting `brandPath` still renders with the templates' default tokens.

## Migration

1. A deployment that pointed `brandPath` at a file that never existed will now see a failed render instead of the default brand. Fix the path, or remove the option when the default brand is intended.
2. A `theme.json` whose `documents.patent` values are numbers or nested objects must be corrected to strings. The loader names the offending key in the error.
3. Callers that recognized the removed warning text ("品牌配置文件不存在，已回退默认") as a signal should handle the `DocumentRenderError` instead; `loadBrandFromPath` remains the direct API and now throws the same error.
