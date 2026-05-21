pref-server-title = docling-serve
pref-server-url = Server URL
pref-test-connection = Test Connection

pref-behavior-title = Behavior
pref-auto-convert =
    .label = Auto-convert new PDF attachments on import
pref-skip-if-exists =
    .label = Skip items that already have a Markdown attachment
pref-max-concurrency = Parallel conversions
pref-max-concurrency-help = How many PDFs to convert in parallel within one batch. Default 1 (sequential, safest). Higher values only speed things up when paired with the async endpoint AND a docling-serve started with --workers ≥ 2.
pref-notify-on-complete =
    .label = OS notification when a batch finishes (only if Zotero isn't focused)

pref-output-title = Output
pref-attach-to-item =
    .label = Attach the .md as a Zotero child attachment (recommended)
pref-add-frontmatter =
    .label = Prepend YAML frontmatter with Zotero metadata
pref-frontmatter-help = Adds title, authors, year, doi, url, zotero_key, citation_key to every .md output as a YAML --- block at the top.
pref-export-folder = Export folder
pref-export-folder-help = Absolute path. If set, every converted .md is ALSO written here as "{citationKey || zoteroKey}.md". Leave empty to disable.

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

pref-async-title = Async transport
pref-async-help = Submit the job to docling-serve's async endpoint and poll for results. Recommended for long VLM conversions that would otherwise time out an upstream proxy. The sync endpoint is faster for short PDFs.
pref-use-async =
    .label = Use the async endpoint (/v1/convert/file/async)
pref-async-poll = Poll interval (s)

pref-advanced-title = Advanced
pref-advanced-help = JSON object whose keys are sent as additional form fields to docling-serve. Overrides anything above. Leave empty to disable.

pref-reset = Reset to defaults
pref-reset-help = Reverts every Zotero Docling preference (including Server URL) to its built-in default.
pref-reset-confirm-title = Reset Zotero Docling preferences?
pref-reset-confirm-body = This reverts every plugin preference (Server URL, auto-convert, pipeline, VLM preset, output, etc.) to its built-in default. Your Zotero library and existing markdown attachments are not touched.
pref-reset-done = Preferences reset to defaults

pref-build-info = { $name } { $version } · built { $time }
