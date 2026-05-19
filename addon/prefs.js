// Plugin-side preferences (not sent to docling-serve)
pref("serverUrl", "http://localhost:5001");
pref("autoConvert", false);
pref("skipIfExists", true);

// Tier 1: essentials → docling-serve form fields
pref("pipeline", "standard"); // "standard" | "vlm"
pref("doOcr", true); // do_ocr
pref("forceOcr", false); // force_ocr
pref("tableMode", "accurate"); // table_mode: "accurate" | "fast"

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
pref("asyncMaxWaitSec", 1800); // 30 min hard cap; 0 = wait indefinitely
