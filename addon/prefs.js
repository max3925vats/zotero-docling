// Plugin-side preferences (not sent to docling-serve)
pref("serverUrl", "http://localhost:5001");
pref("autoConvert", false);
pref("skipIfExists", true);

// Optional authentication against a protected docling-serve instance.
// "none" (default) sends no auth header. Stored in plain text in the user's
// Zotero profile — see SECURITY.md for the threat model.
pref("authScheme", "none"); // "none" | "bearer" | "basic" | "custom"
pref("authUsername", ""); // basic auth username
pref("authSecret", ""); // bearer token / basic password / custom header value
pref("authHeaderName", ""); // custom scheme only

// Tier 1: essentials → docling-serve form fields
pref("pipeline", "standard"); // "standard" | "vlm"
pref("doOcr", true); // do_ocr
pref("forceOcr", false); // force_ocr
pref("tableMode", "accurate"); // table_mode: "accurate" | "fast"
// image_export_mode: false → "embedded" (server default, base64 images
// inline); true → "placeholder" (each image becomes a tiny <!-- image -->
// comment, so the .md keeps text and tables only).
pref("excludeImages", false);

// Tier 2: enrichments
pref("doFormulaEnrichment", false); // do_formula_enrichment
pref("doCodeEnrichment", false); // do_code_enrichment
pref("doChartExtraction", false); // do_chart_extraction
pref("doPictureClassification", false); // do_picture_classification

// Tier 3: VLM (only sent when pipeline === "vlm" or doPictureDescription)
pref("vlmPreset", "default"); // vlm_pipeline_preset (server allowlist)
pref("doPictureDescription", false); // do_picture_description
pref("pictureDescriptionPreset", "default"); // picture_description_preset
pref("ocrLang", ""); // comma-separated, e.g. "en,fr,de"

// Tier 4: advanced — JSON object whose top-level keys are merged into the
// outgoing form fields. Overrides anything above. Empty string disables.
pref("advancedJson", "");

// Async transport (Phase 4). Off by default — the sync endpoint is faster
// for short conversions. Turn on for long VLM jobs that would otherwise 504.
pref("useAsyncEndpoint", false);
pref("asyncPollIntervalSec", 5); // poll cadence in seconds (min 1)
// Absolute client-side wait ceiling for one async task, in minutes. Does NOT
// cancel the server-side task (no upstream cancel API; see README). Bounded
// [1, 1440]. Default 240 (4 hours) — enough for most VLM batches but short
// enough that a dead server doesn't leave the plugin spinning all day.
pref("asyncMaxWaitMin", 240);

// Phase 5a: client-side polish
// Concurrent conversions in a batch (1 = sequential, current behavior).
// More only helps when paired with the async endpoint AND a server started
// with --workers >= 2; otherwise requests just queue server-side.
pref("maxConcurrency", 1);
// Prepend YAML frontmatter (title/authors/year/doi/url/zotero_key/citation_key)
// to every .md output. Off-by-default would be a regression — most lit-lake
// downstream tools (Obsidian, RAG pipelines) expect this metadata.
pref("addFrontmatter", true);
// Output sinks. Default: attach to the Zotero item (existing behavior).
// Setting exportFolderPath to an absolute directory ALSO writes the .md
// there, named "{citationKey || zoteroKey}.md". Both can be on at once.
pref("attachToItem", true);
pref("exportFolderPath", "");
// OS-level notification when a batch finishes, only if Zotero isn't focused.
pref("notifyOnComplete", false);

// Preferences-pane disclosure state. Collapsed by default so the first-run
// experience focuses on the 80%-case Essentials. Reset to defaults restores.
pref("prefsLayerConversionExpanded", false);
pref("prefsLayerAdvancedExpanded", false);
// Show a confirmation prompt before the destructive "Re-convert (replace)"
// menu action. Users can opt out via a "Don't ask again" checkbox in the
// dialog itself; Reset to defaults restores this.
pref("confirmReconvert", true);
// First-run onboarding nudge. Flipped to true after the first startup
// toast fires OR after the first successful Test Connection. Reset to
// defaults re-arms the nudge.
pref("firstRunCompleted", false);
// Last "Test Connection" result; surfaced when the prefs pane opens so a
// returning user sees the previous state without re-clicking. JSON string:
// {"ok": bool, "message": str, "at": ISO-8601 timestamp}. Empty when unset.
pref("lastHealthResult", "");
