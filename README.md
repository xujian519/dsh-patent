# DSH Patent

English | [中文](README.zh.md)

**DSH Patent** is the patent-practice fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), an open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It keeps the upstream **everything-is-a-plugin** architecture, powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Upstream documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## What this fork adds

- **Patent practice**: invention-disclosure analysis, prior-art search, novelty and inventive-step analysis, claim and specification drafting, office-action responses, invalidation, and infringement comparison.
- **Patent tools**: search, metadata, legal status, document rendering, deadlines, and fees, with a quality gate that runs before delivery.
- **Legal domain**: statute citation verification, evidence assessment, and case and regulation lookup.
- **Patent agent preset**: a preset named **专利模式** (Patent mode), delivered with the Web UI bundle.

These capabilities are included in this repository; packaging and verification status varies by feature. See [docs/architecture.md](docs/architecture.md) for how packages compose.

**Outputs are drafting assistance, not formal legal advice.** See [SAFETY.md](SAFETY.md).

## Developer preview

DSH Patent follows the upstream _developer preview_ status and iterates rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from source

Fork capabilities are built from this repository; the published upstream package does not include them. Requires Node.js >= 24.9 and pnpm 11.28.5.

```sh
git clone https://github.com/xujian519/dsh-patent.git
cd dsh-patent
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding. The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See the [Web UI guide](docs/user/guide/index.md).

### Run the upstream package

`npx @deepseek-ai/dsh web` installs the upstream release, which does not include this fork's patent or legal capabilities.

## Quick start: patent work

1. Start the Web UI from source as above.
2. Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it.
3. Open a matter in this same repository, using the New matter steps below.
4. Create a task and select the **专利模式** agent preset.
5. Describe the task, for example: "Read the disclosure document in this workspace and list the technical problem, the inventive concept, the key technical features, and the technical effects."

The [patent quick start](docs/user/guide/patent-quickstart.md) covers the full first-run path. The matter truth source is [ADR-001](docs/adr/ADR-001-matter-folder-index.md).

## New matter

One repository holds many matters. Do not open a separate Cursor or git project for each matter. The work root is configurable; a typical value is `/Users/xujian/工作`.

1. Create the matter folder under the work root, for example `/Users/xujian/工作/<案号>/`, and put `_matter-log.md` in it. Do not create a separate `patent-workspace/<案号>` tree that ignores this root.
2. Scan the folder into the workbench ledger, the SQLite database under `~/.dsh/workbench`. The ledger row stores metadata and `workspace_path` only. Matter file bodies stay in the folder. They do not go to the cloud or into `knowledge.db`.
3. Open this same repository and select that matter. The workbench entry points at the matter folder.
4. Write in that folder. The matter directory and `_matter-log.md` are the truth source. A bridge may read projections. Writing back to the matter folder is not the ledger.

## Community and support

- Report bugs and request features in this repository's [Issues](https://github.com/xujian519/dsh-patent/issues).
- For the upstream harness, use [upstream Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) and the [DeepSeek Harness Discord community](https://discord.gg/4MrtZUhpxg).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
