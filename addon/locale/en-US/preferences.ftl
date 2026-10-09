pref-server-title = docling-serve
pref-server-url = Server URL
pref-test-connection = Test Connection
pref-auth-scheme = Auth
pref-auth-scheme-none =
    .label = None
pref-auth-scheme-bearer =
    .label = Bearer token
pref-auth-scheme-basic =
    .label = Basic auth
pref-auth-scheme-custom =
    .label = Custom header
pref-auth-username = Username
pref-auth-header-name = Header name
pref-auth-secret = Secret
pref-auth-token = Token
pref-auth-password = Password
pref-auth-header-value = Header value
pref-auth-help = Sent on every request to docling-serve, including Test Connection. Stored in Zotero's login manager (encrypted, but readable by anyone with a copy of your Zotero profile) — use a least-privilege key, and prefer HTTPS for non-local servers.

pref-behavior-title = Behavior
pref-auto-convert =
    .label = Auto-convert new PDF attachments on import
pref-auto-convert-help = Newly imported PDFs only — does not retroactively convert your existing library.
pref-skip-if-exists =
    .label = Skip items that already have a Markdown attachment
pref-max-concurrency = Parallel conversions
pref-max-concurrency-help = How many PDFs to convert in parallel within one batch. Default 1 (sequential, safest). Higher values only speed things up when paired with the async endpoint AND a docling-serve started with --workers ≥ 2.
pref-notify-on-complete =
    .label = OS notification when a batch finishes (only if Zotero isn't focused)
pref-confirm-reconvert =
    .label = Confirm before "Re-convert (replace)" replaces existing markdown

pref-output-title = Output
pref-attach-to-item =
    .label = Attach the .md as a Zotero child attachment (recommended)
pref-add-frontmatter =
    .label = Prepend YAML frontmatter with Zotero metadata
pref-frontmatter-help = Adds title, authors, year, doi, url, zotero_key, citation_key to every .md output as a YAML --- block at the top.
pref-exclude-images =
    .label = Exclude images — keep only text and tables
pref-exclude-images-help = By default every figure is embedded in the .md as base64 data, which can grow a paper's markdown by tens of megabytes. When enabled, each image is replaced with a tiny <!-- image --> placeholder comment instead.
pref-export-folder = Export folder
pref-export-folder-help = Absolute path. If set, every converted .md is ALSO written here. Filename uses the item's citation key when available, otherwise the Zotero item key. Leave empty to disable.

pref-conversion-title = Conversion
pref-pipeline = Pipeline
pref-pipeline-standard =
    .label = Standard
pref-pipeline-vlm =
    .label = VLM (vision-language model)
pref-do-ocr =
    .label = Run OCR on bitmap content (do_ocr)
pref-force-ocr =
    .label = Force OCR even when text is extractable (force_ocr)
pref-ocr-lang = OCR languages
pref-ocr-lang-help = Comma-separated language codes. The accepted format depends on the OCR backend docling-serve was built with — Tesseract wants ISO 639-2 three-letter codes (eng,fra,deu); EasyOCR wants two-letter codes (en,fr,de). Leave empty to let the server decide.
pref-table-mode = Table mode

pref-enrichments-title = Enrichments
pref-enrichments-help = These are off by default. They slow conversion down and may require extra server-side models.
pref-do-formula =
    .label = Extract formulas as LaTeX (do_formula_enrichment)
pref-do-code =
    .label = Recognize code blocks (do_code_enrichment)
pref-do-chart =
    .label = Extract numeric data from charts (do_chart_extraction)
pref-do-picture-class =
    .label = Classify pictures (do_picture_classification)

pref-vlm-title = Vision-Language Model
pref-vlm-help = Only used when Pipeline is VLM. First request loads the model — expect a multi-minute cold start.
pref-vlm-preset = VLM preset
pref-do-picture-desc =
    .label = Describe pictures with a VLM (do_picture_description)
pref-pic-preset = Picture-description preset
pref-preset-custom = Custom…
pref-remote-pic-enabled =
    .label = Describe pictures with a remote vision API instead of a local model
pref-remote-pic-provider = Provider
pref-remote-pic-url = API URL
pref-remote-pic-model = Model
pref-remote-pic-key = API key
pref-remote-pic-prompt = Prompt
pref-remote-pic-timeout = Timeout (seconds)
pref-remote-pic-test =
    .label = Test Remote API
pref-remote-pic-help = docling-serve calls this API, not Zotero: start it with DOCLING_SERVE_ENABLE_REMOTE_SERVICES=true (and DOCLING_SERVE_ALLOW_CUSTOM_PICTURE_DESCRIPTION_CONFIG=true on 1.36+). The URL must be reachable from the docling-serve machine — in Docker, use host.docker.internal instead of localhost. The key is stored in Zotero's login manager and passes through docling-serve, so use HTTPS for a remote server. Test Remote API checks from this computer and is free.
pref-remote-pic-confirm-title = Test connection to { $provider }?
pref-remote-pic-confirm-body = This sends one request to { $url } using your API key, to check the URL, the key and the model name. Listing models is free, so no credits are used and no PDF or image is sent.
pref-remote-pic-confirm-send = Send test request

pref-async-title = Async transport
pref-async-help = Submit the job to docling-serve's async endpoint and poll for results. Recommended for long VLM conversions that would otherwise time out an upstream proxy. The sync endpoint is faster for short PDFs.
pref-use-async =
    .label = Use the async endpoint (/v1/convert/file/async)
pref-async-poll = Poll interval (s)
pref-async-max-wait = Max wait (min)
pref-async-max-wait-help = Client-side ceiling for a single async task (default 240, maximum 1440; 0 = no limit). When exceeded, the plugin stops polling and reports an error. docling-serve has no per-task cancel API, so the server-side task may still complete in the background — set 0 if you'd rather the plugin always wait for it.

pref-timeouts-title = Timeouts
pref-timeouts-help = How long to wait for docling-serve before giving up on a request. A request that runs past its timeout is cancelled and reported as an error, so a stalled server can't hang a batch.
pref-health-timeout = Connection check (s)
pref-poll-timeout = Async status poll (s)
pref-async-upload-timeout = Async upload (min)
pref-async-result-timeout = Async result download (min)
pref-sync-timeout = Sync conversion (min)
pref-sync-timeout-help = docling-serve stops waiting on its own after DOCLING_SERVE_MAX_SYNC_WAIT (default 120 s). If you raise that on the server, raise this too — or turn on the async endpoint for long conversions.

pref-advanced-title = Advanced
pref-advanced-help = JSON object whose top-level keys are sent as form fields to docling-serve and override the controls above. Use this for any docling-serve option not exposed elsewhere in this pane. The full schema is documented in the docling-serve OpenAPI surface at /docs on your running server.

pref-disclosure-conversion-collapsed = ▶ Conversion options
pref-disclosure-conversion-expanded = ▼ Conversion options
pref-disclosure-advanced-collapsed = ▶ Advanced
pref-disclosure-advanced-expanded = ▼ Advanced

pref-reset = Reset to defaults
pref-reset-help = Reverts every zotero-docling preference (including Server URL) to its built-in default.
pref-reset-confirm-title = Reset zotero-docling preferences?
pref-reset-confirm-body = This reverts every plugin preference (Server URL, auto-convert, pipeline, VLM preset, output, etc.) to its built-in default. Your Zotero library and existing markdown attachments are not touched.
pref-reset-done = Preferences reset to defaults

pref-build-info = { $name } { $version } · built { $time }
