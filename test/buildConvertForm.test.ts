import { assert } from "chai";
import { buildConvertForm } from "../src/modules/convert";
import { config } from "../package.json";

const PREFIX = config.prefsPrefix;

// Snapshot/restore the prefs we touch so tests don't leak into each other or
// into a live user's profile if someone runs them against a real install.
const TOUCHED_KEYS = [
  "pipeline",
  "doOcr",
  "forceOcr",
  "tableMode",
  "excludeImages",
  "doFormulaEnrichment",
  "doCodeEnrichment",
  "doChartExtraction",
  "doPictureClassification",
  "vlmPreset",
  "doPictureDescription",
  "pictureDescriptionPreset",
  "ocrLang",
  "advancedJson",
];

function setPref(key: string, value: unknown): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value as never, true);
}

function clearPref(key: string): void {
  Zotero.Prefs.clear(`${PREFIX}.${key}`, true);
}

function defaultPrefs(): void {
  setPref("pipeline", "standard");
  setPref("doOcr", true);
  setPref("forceOcr", false);
  setPref("tableMode", "accurate");
  setPref("excludeImages", false);
  setPref("doFormulaEnrichment", false);
  setPref("doCodeEnrichment", false);
  setPref("doChartExtraction", false);
  setPref("doPictureClassification", false);
  setPref("vlmPreset", "default");
  setPref("doPictureDescription", false);
  setPref("pictureDescriptionPreset", "default");
  setPref("ocrLang", "");
  setPref("advancedJson", "");
}

function getApi(): { FormData: typeof FormData; Blob: typeof Blob } {
  const g = globalThis as any;
  const win = (Zotero as any).getMainWindow?.();
  return {
    FormData: g.FormData ?? win?.FormData,
    Blob: g.Blob ?? win?.Blob,
  };
}

describe("buildConvertForm", function () {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

  beforeEach(function () {
    defaultPrefs();
  });

  afterEach(function () {
    for (const key of TOUCHED_KEYS) {
      try {
        clearPref(key);
      } catch {
        /* ignore */
      }
    }
  });

  it("produces the expected base set of fields with defaults", function () {
    const form = buildConvertForm(bytes, "paper.pdf", getApi());
    assert.strictEqual(form.get("to_formats"), "md");
    assert.strictEqual(form.get("abort_on_error"), "false");
    assert.strictEqual(form.get("pipeline"), "standard");
    assert.strictEqual(form.get("do_ocr"), "true");
    assert.strictEqual(form.get("force_ocr"), "false");
    assert.strictEqual(form.get("table_mode"), "accurate");
    assert.strictEqual(form.get("image_export_mode"), "embedded");
    assert.strictEqual(form.get("do_picture_description"), "false");
    // Picture-description preset is suppressed when doPictureDescription is off.
    assert.isNull(form.get("picture_description_preset"));
  });

  it("excludeImages switches image_export_mode to placeholder", function () {
    setPref("excludeImages", true);
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    assert.strictEqual(form.get("image_export_mode"), "placeholder");
  });

  it("advancedJson image_export_mode beats the excludeImages checkbox", function () {
    setPref("excludeImages", true);
    setPref("advancedJson", '{"image_export_mode": "referenced"}');
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    assert.deepStrictEqual(form.getAll("image_export_mode"), ["referenced"]);
  });

  it("emits ocr_lang as repeated fields, not comma-joined", function () {
    setPref("ocrLang", "en, fr,  de");
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    const langs = form.getAll("ocr_lang");
    assert.deepStrictEqual(langs, ["en", "fr", "de"]);
  });

  it("advancedJson overrides earlier fields and wins", function () {
    setPref("advancedJson", '{"pipeline": "vlm", "do_ocr": false}');
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    assert.strictEqual(form.get("pipeline"), "vlm");
    assert.strictEqual(form.get("do_ocr"), "false");
  });

  it("advancedJson nested-object value is JSON-stringified, not flattened", function () {
    setPref("advancedJson", '{"picture_description_api": {"url": "u"}}');
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    const v = form.get("picture_description_api");
    assert.strictEqual(typeof v, "string");
    assert.strictEqual(v, '{"url":"u"}');
  });

  it("advancedJson array value emits multiple form entries", function () {
    setPref("advancedJson", '{"my_list": ["a", "b", "c"]}');
    const form = buildConvertForm(bytes, "p.pdf", getApi());
    assert.deepStrictEqual(form.getAll("my_list"), ["a", "b", "c"]);
  });

  it("throws a typed error on invalid advancedJson", function () {
    setPref("advancedJson", "{not valid");
    assert.throws(
      () => buildConvertForm(bytes, "p.pdf", getApi()),
      /advancedJson preference is not valid JSON/,
    );
  });

  it("throws when advancedJson is a non-object JSON value", function () {
    setPref("advancedJson", "[1, 2, 3]");
    assert.throws(
      () => buildConvertForm(bytes, "p.pdf", getApi()),
      /advancedJson must be a JSON object/,
    );
  });
});
