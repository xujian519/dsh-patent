---
kind: upgrade-guide
description: "Patent document and filing tools now reject an explicit output directory or brand path whose real location leaves the process working directory."
---

# Patent tools reject paths outside the working directory

English | [中文](guide.zh.md)

## Change

`render_patent_document` accepts `outputDir` and `brandPath`; `build_patent_filing` accepts `outputDir`. Both tools previously wrote to, or read from, any absolute path the caller supplied. Each path is now resolved against the process working directory and compared by real location: `..` segments, an absolute path elsewhere, and a symlink that points outside all fail before the tool writes or reads anything.

Two limits matter for migration:

- Absolute paths inside the working directory still work, as do relative paths.
- The comparison normalizes symlinks, so the macOS `/var` → `/private/var` alias does not reject a directory that really sits under the working directory.

Who observes it: a model or script that passes a path under another root, for example `outputDir: "~/Desktop/deliver"` or a theme in a user configuration directory. Such a call now fails with `输出目录 越出工作目录: …` (`brandPath`: `品牌配置路径 越出工作目录: …`); the tool result carries that message and no file is produced.

## Migration

1. Move the target directory under the working directory and pass it relatively, for example change `outputDir: "/Users/me/Desktop/deliver"` to `outputDir: "deliver"`.
2. For a brand theme kept elsewhere, copy `theme.json` into the working directory (for example `brand/theme.json`) and pass that relative path as `brandPath`.
3. To keep the existing target location, start the Session with that directory as its working directory; the same absolute path then resolves inside it.
4. Re-run the tool call and confirm the result names the written path. A rejection keeps the old message format, so a second identical failure means the path still resolves outside the working directory (`realpath` the target to check).
