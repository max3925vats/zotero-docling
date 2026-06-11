# zotero-docling

A Zotero plugin (Zotero 7 or later) that converts PDF attachments to structured
Markdown using the [Docling](https://github.com/docling-project/docling)
document-understanding pipeline, and attaches the resulting `.md` file back to
the same parent item.

[![Release](https://img.shields.io/github/v/release/max3925vats/zotero-docling?style=flat-square)](https://github.com/max3925vats/zotero-docling/releases/latest)
[![License](https://img.shields.io/github/license/max3925vats/zotero-docling?style=flat-square)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/max3925vats/zotero-docling/total?style=flat-square)](https://github.com/max3925vats/zotero-docling/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/max3925vats/zotero-docling/ci.yml?style=flat-square&label=CI)](https://github.com/max3925vats/zotero-docling/actions)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![Powered by Docling](https://img.shields.io/badge/Powered%20by-Docling-052FAD?style=flat-square)](https://github.com/docling-project/docling)

---

Markdown is plain text, so converted papers drop straight into note apps like
Obsidian, AI/RAG pipelines, citation extraction, summarisation, literature
reviews — anything that prefers text over PDFs.

---

## Quick start

The setup has two halves: a small **local server**
([docling-serve](https://github.com/docling-project/docling-serve)) does the
actual PDF → Markdown conversion, and this **plugin** connects Zotero to it.
You need both.

1. **Start the converter server.** The quickest path uses
   [uv](https://docs.astral.sh/uv/getting-started/installation/) (a Python
   tool installer); see [Install the server](#install-the-server-docling-serve)
   for pipx and Docker alternatives that may suit you better.

   ```bash
   uv tool install "docling-serve[ui]"   # one-time install
   docling-serve run                     # leave this terminal open
   ```

2. **Install the plugin.** Download the latest `.xpi` file from the
   [Releases page](https://github.com/max3925vats/zotero-docling/releases/latest)
   (if your browser tries to install it itself, right-click the link and
   choose "Save Link As…"). Then in Zotero: **Tools → Plugins → ⚙ →
   Install Plugin From File…** → pick the `.xpi`.

3. **Connect them.** In Zotero, open **Settings → zotero-docling** and click
   **Test Connection** — it should turn green. Then right-click any PDF in
   your library → **Convert with Docling**.

> [!NOTE]
> Your very first conversion downloads model weights and can take 2–10
> minutes while appearing to hang — that's normal, and later conversions
> take seconds. See
> [First conversion downloads model weights](#first-conversion-downloads-model-weights).

---

## Features

- **One-click conversion**: right-click any PDF attachment (or any parent item
  containing PDFs, or any mix of the two) → "Convert with Docling" → Markdown
  appears as a sibling attachment.
- **Re-convert (replace)**: right-click → "Re-convert with Docling (replace)"
  deletes the existing `.md` sibling and runs conversion again. A confirmation
  dialog guards the destructive action (toggleable in prefs).
- **Auto-convert on import** (opt-in): newly imported PDFs are converted
  automatically with a 3-second debounce that handles bulk imports gracefully.
- **Optional authentication**: Bearer token / Basic auth / Custom header
  schemes for protected `docling-serve` instances. Default is no auth.
- **Full Docling options surfaced**: pipeline (standard / VLM), OCR + language,
  table mode, formula / code / chart / picture enrichments, VLM presets, plus
  an Advanced JSON escape hatch for anything not in the UI.
- **Exclude images** (opt-in): keep the markdown text-and-tables only — each
  figure becomes a tiny placeholder comment instead of megabytes of embedded
  base64 image data. Tick **Exclude images** in **Settings → Output**.
- **Remove images from existing markdown**: right-click already-converted
  items (or **Tools → Docling: Remove images from markdown…**) to rewrite
  their `.md` attachments in place, swapping every embedded image for a
  `<!-- image -->` placeholder — the retroactive version of Exclude images,
  no re-conversion needed.
- **Per-parent status tags**: parents get tagged `docling/done`,
  `docling/incomplete`, or `docling/error` so you can filter your library by
  conversion status.
- **Skip-if-exists**: re-running on a parent that already has the corresponding
  `.md` siblings skips them (matched by filename, so `paper.pdf` only skips if
  `paper.md` exists).
- **Markdown `.zip` export**: right-click a selection (or **Tools → Docling:
  Export markdown to .zip**) → save a single `.zip` of `{citationKey}.md`
  files ready to drop into Obsidian, a RAG indexer, or any downstream
  pipeline.

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

Pick one of the three paths below — they all yield a `docling-serve` you can
point the plugin at. If you've never touched Python tooling, the container
path avoids it entirely. Roughly:

| Option        | Best for                                                        | Needs                |
| ------------- | --------------------------------------------------------------- | -------------------- |
| **uv**        | You already have a Python toolchain or want the smallest setup. | Python 3.10+, `uv`   |
| **pipx**      | You already use pipx for isolated CLI tools.                    | Python 3.10+, `pipx` |
| **Container** | You'd rather not touch Python at all, or want GPU isolation.    | Docker / Podman      |

### Option A — uv (recommended)

Don't have `uv` yet? It's a one-line install — see the
[uv installation guide](https://docs.astral.sh/uv/getting-started/installation/).

```bash
uv tool install "docling-serve[ui]"   # one-time install
docling-serve run                      # leave this terminal open
```

### Option B — pipx

Don't have `pipx` yet? See the
[pipx installation guide](https://pipx.pypa.io/stable/installation/).

```bash
pipx install "docling-serve[ui]"      # one-time install
docling-serve run
```

### Option C — container

```bash
# CPU-only (works on any host)
docker run -p 5001:5001 \
  -e DOCLING_SERVE_ENABLE_UI=true \
  quay.io/docling-project/docling-serve:latest

# CUDA variant for NVIDIA GPUs
docker run --gpus all -p 5001:5001 \
  -e DOCLING_SERVE_ENABLE_UI=true \
  quay.io/docling-project/docling-serve-cu128:latest
```

### Sanity check (any option)

Open <http://localhost:5001/ui> in your browser — the docling-serve
playground page should load. Or, from a terminal:

```bash
curl http://localhost:5001/health    # → {"status":"ok"}
```

### First conversion downloads model weights

⚠️ The first time you convert a PDF, `docling-serve` downloads the model files
from Hugging Face. Expect **2–10 minutes** for the standard pipeline and
**significantly longer** (multi-GB) for VLM presets. Subsequent conversions
are fast. The Zotero progress window will appear to hang during the
download — that's normal.

**Recommended**: set an `HF_TOKEN` before starting the server so the
download isn't rate-limited:

```bash
export HF_TOKEN=hf_yourTokenHere     # get one at https://huggingface.co/settings/tokens
docling-serve run
```

---

## Install the plugin

### From a release (recommended)

1. Download the latest `.xpi` from the
   [Releases page](https://github.com/max3925vats/zotero-docling/releases/latest).
   If your browser tries to install the file itself (Firefox does this),
   right-click the link and choose **Save Link As…** instead.
2. In Zotero: **Tools → Plugins** → click the gear icon (⚙) →
   **Install Plugin From File…** → pick the downloaded `.xpi`.

### From source (for development)

Requires [Node.js](https://nodejs.org/) 20 or later:

```bash
git clone https://github.com/max3925vats/zotero-docling.git
cd zotero-docling
npm install
npm run build       # outputs .scaffold/build/*.xpi
```

Then install the `.xpi` via **Tools → Plugins** as above.

> **macOS note** (for the `npm start` development workflow): profile paths
> that contain spaces (for example
> `~/Library/Application Support/Zotero/...`) must be written literally in
> `.env` — **no** backslash escapes. See [`.env.example`](.env.example) for
> the exact format.

---

## Usage

1. **Settings**: open Zotero → **Settings → zotero-docling**.
2. Verify the server URL (default `http://localhost:5001`) and click **Test
   Connection** — it should turn green. If it doesn't, make sure the
   `docling-serve` terminal from the install step is still running.
3. Right-click a PDF (or parent item) in your library → **Convert with
   Docling**. A `.md` child appears under the parent — within seconds once
   the [first-run model download](#first-conversion-downloads-model-weights)
   is out of the way.
4. (Optional) tick **Auto-convert new PDF attachments** in Behavior to run
   conversion automatically as you import new PDFs.

All docling-serve options exposed in the preferences pane (pipeline, OCR,
VLM presets, enrichments, etc.) live inside two collapsible disclosure
sections — **Conversion options** and **Advanced** — collapsed by default so
the first-run experience stays focused on Server, Behavior, and Output.
Click either header to expand. Hover any field for inline help.

### Exporting markdown to a .zip

Once a set of items has been converted, you can bundle the markdown into a
single zip for downstream tools:

1. Select one or more items (parents, PDF attachments, or any mix) in your
   library. Or skip this step to operate on the current view.
2. Either **right-click → Export markdown to .zip**, or open
   **Tools → Docling: Export markdown to .zip…**.
3. If any selected item has no `.md` yet, a dialog offers three choices:
   **Skip and export**, **Convert first**, or **Cancel**.
4. Pick a save location in the file dialog (default name:
   `docling-markdown-YYYY-MM-DD.zip`).

The zip is flat — each markdown file lives at the root, named
`{citationKey}.md` (falling back to `{zoteroKey}.md` if Better BibTeX
hasn't assigned a citation key). When a parent has multiple converted
PDFs, the second and subsequent get `.1.md`, `.2.md`, … suffixes to
prevent collisions.

### Removing images from already-converted markdown

Markdown converted without the **Exclude images** option embeds every
figure as base64 data, which can make a single paper's `.md` tens of
megabytes. To slim down existing files without re-converting:

1. Select the items (parents, PDF attachments, or `.md` attachments) in
   your library.
2. **Right-click → Remove images from markdown**, or open
   **Tools → Docling: Remove images from markdown…**.
3. Confirm the dialog. Each `.md` attachment is rewritten in place with
   every image replaced by a `<!-- image -->` placeholder; a toast reports
   how many images were removed and how much space was saved.

The image data is gone for good after this — re-convert the PDF if you
ever need the figures back. Code blocks inside the markdown are left
untouched.

---

## Known limitations

### No cancel for an in-flight conversion (upstream-blocked)

The plugin does not expose a cancel button. This is intentional — docling-serve
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

### Client-side async wait ceiling (opt-in)

The async-transport poll loop runs **without** a client-side time limit by
default — same honesty argument as cancel: docling-serve has no per-task
cancel API, so abandoning a poll just orphans the server task. If you
want a hard ceiling anyway, set **Max wait** to a positive minute value
in **Settings → zotero-docling → Advanced → Async transport** (the
**Advanced** section is collapsed by default; click to expand). When
exceeded, the plugin stops polling and reports an error; the server-side
task may still complete in the background.

Separately, if poll requests start failing repeatedly (server crashed
mid-task, network blip, etc.), a one-time toast surfaces around the
tenth consecutive failure so a dead server isn't silent. This behavior
is always on and doesn't depend on the Max wait setting.

---

## Troubleshooting

### Apple Silicon (M1/M2/M3/M4): `MPS Tensor to float64` error

If conversion fails on a Mac with Apple Silicon and the `docling-serve`
log contains a long Python traceback ending with:

```
TypeError: Cannot convert a MPS Tensor to float64 dtype as the MPS
framework doesn't support float64. Please use float32 instead.
```

…this is an upstream interop bug between `transformers`' RT-DETRv2
layout model and PyTorch's MPS (Metal) backend. The model hard-codes a
`float64` tensor that MPS cannot represent.

**Fastest workaround**: restart `docling-serve` with PyTorch's
fall-back-to-CPU flag set, so unsupported MPS ops route to CPU
silently:

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 docling-serve run
```

The layout stage will be slightly slower than full-MPS, but the rest of
the pipeline keeps using MPS where it works.

**Cleaner workaround** — force the layout stage entirely onto CPU:

```bash
DOCLING_PIPELINE_OPTIONS_ACCELERATOR_OPTIONS_DEVICE=cpu docling-serve run
```

(Older `docling-serve` builds spell this env var differently; check
`docling-serve --help | grep -i accel` on your version.)

This is **not** a plugin bug — the plugin only forwards form fields
docling-serve accepts. We surface the workaround in the conversion-error
toast when the response body contains both `MPS` and `float64`, but the
fix has to be applied server-side. Tracking upstream in the
[transformers issue tracker](https://github.com/huggingface/transformers/issues)
under the `rt_detr_v2` / MPS keywords.

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

### Contributors

Thanks to everyone who has contributed code, bug reports, or review:

<a href="https://github.com/max3925vats/zotero-docling/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=max3925vats/zotero-docling" alt="Contributors" />
</a>

<sub>Avatars auto-rendered by [contrib.rocks](https://contrib.rocks); bots (e.g. dependabot) are filtered out by the upstream service.</sub>

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

This is a strong copyleft license: derivative works that are distributed (or
provided as a network service) must release their source under the same terms.
For a Zotero plugin running locally on a user's machine, the practical impact
is minimal — but if you fork and redistribute, please respect the license.
