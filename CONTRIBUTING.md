# Contributing to zotero-docling

Thanks for your interest. This is a solo-maintained plugin and contributions of any size are welcome — from typo fixes to whole features. The notes below should save you a round-trip on the obvious questions.

## Reporting bugs

Open a [GitHub Issue](https://github.com/max3925vats/zotero-docling/issues) using the **Bug report** template. The template asks for:

- Zotero version (e.g. 7.0.x, 9.0.x)
- docling-serve version (`curl http://localhost:5001/version`)
- Operating system
- Steps to reproduce
- What you expected vs what happened
- Any relevant log lines from Zotero's **Help → Debug Output Logging** OR the Browser Toolbox console (filter for `[zotero-docling]` or `[Docling/*]`)

Please **don't** paste large debug logs into the issue body — attach as a file, or paste the relevant ~20 lines around the failure.

## Suggesting features

Open a **Feature request** issue. Frame the underlying need rather than a specific implementation if possible — that gives more room to find the best fit.

For broader discussions about Zotero workflows, the [Zotero Forums](https://forums.zotero.org/) are a better venue than this repo's issues.

## Security issues

Please **do not** report security issues in public issues. Use [GitHub's Private Vulnerability Reporting](https://github.com/max3925vats/zotero-docling/security/advisories/new) — details in [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/max3925vats/zotero-docling.git
cd zotero-docling
npm install
cp .env.example .env
# Then edit .env: set ZOTERO_PLUGIN_ZOTERO_BIN_PATH and
# ZOTERO_PLUGIN_PROFILE_PATH. Use a dedicated dev profile.
npm start
```

`npm start` launches Zotero with the plugin hot-loaded. Save any source file and the scaffold rebuilds + reloads.

### Dev profile

Create a separate Zotero profile for development so you don't risk your real library. Run Zotero with `--ProfileManager` once to make one, then point `ZOTERO_PLUGIN_PROFILE_PATH` at its directory.

### Common gotchas

- **macOS path with spaces**: don't shell-escape with `\ ` in `.env` — dotenv reads it literally. Just write the raw path: `ZOTERO_PLUGIN_PROFILE_PATH=/Users/you/Library/Application Support/Zotero/Profiles/abc.dev`.
- **HF_TOKEN**: set in your shell before running `docling-serve` so model downloads aren't rate-limited.
- **Zotero 9 sandbox**: some Web APIs (FormData, Blob, AbortController) aren't bare globals in the plugin sandbox — see `getWebApis()` in `src/modules/convert.ts` for the pattern.

## Code style and checks

Before opening a PR:

```bash
npm run lint:check    # prettier + eslint (CI enforces this)
npm run build         # confirms the production .xpi builds
npx tsc --noEmit      # full typecheck
```

Or just `npm run lint:fix` to auto-format. CI runs the same checks on every PR.

## Branching and PRs

- Branch from `main`. Use a short descriptive branch name (e.g. `fix-skipifexists`, `add-export-folder`).
- One logical change per PR. Smaller diffs get reviewed faster.
- Run the local checks above before pushing.
- PR title and body: see `.github/PULL_REQUEST_TEMPLATE.md` — it's pre-filled when you open a PR.

### Commit messages

Keep them descriptive and imperative present-tense ("Fix skip on duplicate filename", not "Fixed skipping duplicates"). No rigid prefix convention (no Conventional Commits). Multi-line bodies are welcome for non-trivial changes.

### Tests

There's a minimal `test/` directory from the scaffold. No deep test suite yet. Manual testing in a dev profile is the current bar — describe what you tested in the PR description.

## Project layout

```
addon/              # static plugin assets (manifest, prefs, FTL locales, XUL)
src/
  addon.ts          # singleton holding plugin state
  hooks.ts          # lifecycle hooks (startup, shutdown, prefs events)
  index.ts          # entry point
  modules/
    convert.ts      # core: read PDF → POST to docling-serve → attach .md
    menu.ts         # right-click menus + batch orchestration
    notifier.ts     # auto-convert on PDF import (debounced queue)
    preferenceScript.ts  # prefs pane dynamic behaviour
    ui.ts           # ProgressWindow wrappers (incl. blur-aware managed)
  utils/            # small helpers (concurrency, db lock, frontmatter, …)
typings/            # scaffold-generated d.ts files (committed)
```

## License

By contributing, you agree your contributions are licensed under [AGPL-3.0-or-later](LICENSE) — the same as the rest of the project.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Treat fellow contributors and users with respect.

## Acknowledgments

This plugin stands on:

- [Docling](https://github.com/docling-project/docling) — the conversion pipeline
- [docling-serve](https://github.com/docling-project/docling-serve) — the HTTP wrapper we talk to
- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) and [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) by windingwind — the scaffold and helpers
- The Zotero team — for an extensible, scriptable reference manager
