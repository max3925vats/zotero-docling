# Zotero Docling

A Zotero 7+/9 plugin that converts PDF attachments to structured Markdown using
the [Docling](https://github.com/docling-project/docling) document-understanding
pipeline, and attaches the resulting `.md` file back to the same parent item.

Designed for **literature-lake** workflows: structured markdown becomes a clean
upstream for note apps, RAG pipelines, citation extraction, summarisation,
literature reviews, and any downstream tool that prefers plain text over PDFs.

---

## Features

- **One-click conversion**: right-click any PDF attachment (or any parent item
  containing PDFs, or any mix of the two) → "Convert with Docling" → Markdown
  appears as a sibling attachment.
- **Auto-convert on import** (opt-in): newly imported PDFs are converted
  automatically with a 3-second debounce that handles bulk imports gracefully.
- **Full Docling options surfaced**: pipeline (standard / VLM), OCR + language,
  table mode, formula / code / chart / picture enrichments, VLM presets, plus
  an Advanced JSON escape hatch for anything not in the UI.
- **Per-parent status tags**: parents get tagged `docling/done`,
  `docling/incomplete`, or `docling/error` so you can filter your library by
  conversion status.
- **Skip-if-exists**: re-running on a parent that already has the corresponding
  `.md` siblings skips them (matched by filename, so `paper.pdf` only skips if
  `paper.md` exists).

---

## Requirements

- **Zotero** 7.0 or later (tested on Zotero 9.0.3).
- **[docling-serve](https://github.com/docling-project/docling-serve)** running
  locally or reachable over HTTP.
- For VLM pipelines: enough RAM/disk for the model weights (Granite-Docling
  ≈ 500 MB, larger models more). Apple Silicon Macs benefit from `mlx-vlm`,
  which ships with the default `docling-serve[ui]` install.

---

## Install the server (docling-serve)

```bash
# Recommended: install as a uv tool so it lives in its own venv but is on PATH
uv tool install "docling-serve[ui]"

# Start the server (leave this terminal open while using the plugin)
docling-serve run

# Sanity check
curl http://localhost:5001/health    # → {"status":"ok"}
```

Optional: set `HF_TOKEN` so the first model download isn't rate-limited:

```bash
export HF_TOKEN=hf_yourTokenHere     # get one at https://huggingface.co/settings/tokens
```

---

## Install the plugin

### From a release (when available)

Download the latest `.xpi` from the [Releases page](https://github.com/max3925vats/zotero-docling/releases),
then in Zotero: **Tools → Plugins → ⚙ → Install Plugin From File…** → pick the
`.xpi`.

### From source

```bash
git clone https://github.com/max3925vats/zotero-docling.git
cd zotero-docling
npm install
npm run build       # outputs .scaffold/build/*.xpi
```

Then install the `.xpi` via **Tools → Plugins** as above.

---

## Usage

1. **Settings**: open Zotero → **Settings → Zotero Docling**.
2. Verify the server URL (default `http://localhost:5001`) and click **Test
   Connection** — it should turn green.
3. Right-click a PDF (or parent item) in your library → **Convert with
   Docling**. Within seconds you'll see a `.md` child appear under the parent.
4. (Optional) tick **Auto-convert new PDF attachments** in Behavior to run
   conversion automatically as you import new PDFs.

A reference of all docling-serve options exposed in the preferences pane (VLM
presets, enrichments, etc.) is in the **Conversion / VLM / Enrichments / Advanced**
sections of the prefs UI itself. Hover any field for inline help.

---

## Known limitations

### No cancel or async timeout for an in-flight conversion

The plugin does not expose a cancel button, and the async-transport poll
loop has no client-side timeout. This is intentional — docling-serve
(the upstream server we talk to) currently has **no per-task cancel API**
and **does not detect client disconnects** during processing, so any
"give up" mechanism on the client side just orphans a server task that
keeps running invisibly. Verified on docling-serve 1.18.0:

- The OpenAPI surface exposes no `DELETE` or `cancel` route.
- The server source contains `# TODO: abort task!` markers but no
  implementation.
- Tracking upstream:
  [docling-project/docling-serve#447 — Cancellation api](https://github.com/docling-project/docling-serve/issues/447)
  and
  [#401 — Interrupt Parsing on Disconnected Request](https://github.com/docling-project/docling-serve/issues/401).

Practical consequences:

- Closing the toast or quitting Zotero does **not** stop the server-side
  conversion. The PDF will continue to be processed in the background until
  it completes naturally.
- If you start a long VLM batch and want it to stop, the only way is to
  restart `docling-serve`.
- Once the upstream cancel API exists, we'll add a cancel button that
  actually does what it says.

---

## Acknowledgments

- The **[Docling team](https://github.com/docling-project)** for shipping
  Docling itself and the production-ready `docling-serve` FastAPI wrapper that
  this plugin talks to. None of this would exist without them.
- **windingwind** for the excellent
  [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
  and the [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
  helpers — they make Zotero plugin development tractable.
- The **Zotero team** for an extensible, scriptable reference manager that
  invites this kind of integration.
- Built with help from **Anthropic's Claude** (Claude Code).

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

This is a strong copyleft license: derivative works that are distributed (or
provided as a network service) must release their source under the same terms.
For a Zotero plugin running locally on a user's machine, the practical impact
is minimal — but if you fork and redistribute, please respect the license.
