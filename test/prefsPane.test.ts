import { assert } from "chai";
import { config } from "../package.json";
import { buildConvertForm } from "../src/modules/convert";
import {
  ALL_PREF_KEYS,
  authSecretLabelId,
  migrateLegacyCustomPreset,
} from "../src/modules/preferenceScript";
import {
  bindSecretField,
  providerDefaults,
} from "../src/modules/remotePicPane";
import {
  clearAllSecrets,
  getSecret,
  secretWritesSettled,
  setSecret,
} from "../src/utils/secrets";

// Audit H4 / M10: the auth secret label was relabelled with a bare Fluent ID
// (blank label), and each preset's menulist and its "custom" text box were
// bound to the same pref — a saved custom name vanished on reopen and the
// literal "__custom__" could be sent to docling-serve.

const PREFIX = config.prefsPrefix;
const KEYS = [
  "pipeline",
  "vlmPreset",
  "vlmPresetCustom",
  "doPictureDescription",
  "pictureDescriptionPreset",
  "pictureDescriptionPresetCustom",
];
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function setPref(key: string, value: unknown): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value as never, true);
}

function api() {
  const g = globalThis as any;
  const win = (Zotero as any).getMainWindow?.();
  return { FormData: g.FormData ?? win?.FormData, Blob: g.Blob ?? win?.Blob };
}

function allValues(form: FormData): string[] {
  const out: string[] = [];
  form.forEach((v) => out.push(String(v)));
  return out;
}

describe("prefs pane", function () {
  afterEach(function () {
    for (const k of KEYS) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
  });

  describe("custom presets in the request", function () {
    it("sends the typed custom VLM preset name", function () {
      setPref("pipeline", "vlm");
      setPref("vlmPreset", "__custom__");
      setPref("vlmPresetCustom", "  my_vlm  ");
      const form = buildConvertForm(bytes, "p.pdf", api());
      assert.strictEqual(form.get("vlm_pipeline_preset"), "my_vlm");
    });

    it("never sends the __custom__ placeholder when nothing was typed", function () {
      setPref("pipeline", "vlm");
      setPref("vlmPreset", "__custom__");
      setPref("vlmPresetCustom", "");
      setPref("doPictureDescription", true);
      setPref("pictureDescriptionPreset", "__custom__");
      setPref("pictureDescriptionPresetCustom", "");
      const form = buildConvertForm(bytes, "p.pdf", api());
      assert.notInclude(allValues(form), "__custom__");
      assert.isNull(form.get("vlm_pipeline_preset"));
      assert.isNull(form.get("picture_description_preset"));
    });

    it("sends the typed custom picture-description preset name", function () {
      setPref("doPictureDescription", true);
      setPref("pictureDescriptionPreset", "__custom__");
      setPref("pictureDescriptionPresetCustom", "my_pic");
      const form = buildConvertForm(bytes, "p.pdf", api());
      assert.strictEqual(form.get("picture_description_preset"), "my_pic");
    });

    it("still sends a legacy custom name stored in the preset pref", function () {
      setPref("pipeline", "vlm");
      setPref("vlmPreset", "legacy_name");
      const form = buildConvertForm(bytes, "p.pdf", api());
      assert.strictEqual(form.get("vlm_pipeline_preset"), "legacy_name");
    });
  });

  describe("migrateLegacyCustomPreset", function () {
    const known = ["default", "smoldocling", "__custom__"];

    it("moves an unknown stored name into the custom field", function () {
      assert.deepEqual(migrateLegacyCustomPreset("legacy_name", known), {
        preset: "__custom__",
        custom: "legacy_name",
      });
    });

    it("leaves a known preset alone", function () {
      assert.isNull(migrateLegacyCustomPreset("smoldocling", known));
    });
  });

  describe("authSecretLabelId", function () {
    it("uses build-prefixed Fluent IDs so the label isn't blank", function () {
      const p = config.addonRef;
      assert.strictEqual(authSecretLabelId("bearer"), `${p}-pref-auth-token`);
      assert.strictEqual(authSecretLabelId("basic"), `${p}-pref-auth-password`);
      assert.strictEqual(
        authSecretLabelId("custom"),
        `${p}-pref-auth-header-value`,
      );
      assert.strictEqual(authSecretLabelId("none"), `${p}-pref-auth-secret`);
    });
  });

  describe("bindSecretField", function () {
    afterEach(async function () {
      await clearAllSecrets();
    });

    function fakeWin(input: HTMLInputElement): Window {
      return { document: { getElementById: () => input } } as unknown as Window;
    }

    it("fills the input from the store and saves edits back", async function () {
      const doc = Zotero.getMainWindow().document;
      const input = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input",
      ) as HTMLInputElement;
      await setSecret("docling-serve-auth", "stored");
      const refresh = bindSecretField(
        fakeWin(input),
        "x",
        "docling-serve-auth",
      );
      assert.strictEqual(input.value, "stored");
      input.value = "edited";
      input.dispatchEvent(new (Zotero.getMainWindow() as any).Event("change"));
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(getSecret("docling-serve-auth"), "edited");
      await setSecret("docling-serve-auth", "");
      refresh();
      assert.strictEqual(input.value, "");
    });

    function newInput(): HTMLInputElement {
      return Zotero.getMainWindow().document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input",
      ) as HTMLInputElement;
    }
    const fire = (input: HTMLInputElement, type: string) =>
      input.dispatchEvent(new (Zotero.getMainWindow() as any).Event(type));

    it("saves typed text after a short pause, without a change event", async function () {
      const input = newInput();
      bindSecretField(fakeWin(input), "x", "docling-serve-auth");
      input.value = "typed";
      fire(input, "input");
      await new Promise((r) => setTimeout(r, 600));
      await secretWritesSettled();
      assert.strictEqual(getSecret("docling-serve-auth"), "typed");
    });

    it("a reader that settles right after typing sees the new value", async function () {
      const input = newInput();
      bindSecretField(fakeWin(input), "x", "docling-serve-auth");
      input.value = "just-typed";
      fire(input, "input");
      // No wait for the debounce: settling flushes the pending edit.
      await secretWritesSettled();
      assert.strictEqual(getSecret("docling-serve-auth"), "just-typed");
    });
  });

  describe("providerDefaults", function () {
    it("returns the provider URL for presets and null for Custom", function () {
      assert.deepEqual(providerDefaults("ollama"), {
        url: "http://localhost:11434/v1/chat/completions",
      });
      assert.isNull(providerDefaults("custom"));
    });
  });

  describe("remote prefs", function () {
    const REMOTE = [
      "remotePicApiEnabled",
      "remotePicApiProvider",
      "remotePicApiUrl",
      "remotePicApiModel",
      "remotePicApiPrompt",
      "remotePicApiTimeoutSec",
    ];

    it("are all cleared by Reset", function () {
      for (const k of REMOTE) assert.include(ALL_PREF_KEYS, k);
    });

    it("are all bound in the pane", async function () {
      // Read the shipped XHTML as text; a missing preference="" binding would
      // leave the field unsaved with no other symptom.
      const url = `chrome://${config.addonRef}/content/preferences.xhtml`;
      const src = await Zotero.File.getContentsFromURLAsync(url);
      // The scaffold build prefixes pref names in the shipped XHTML.
      for (const k of REMOTE) {
        assert.include(
          src,
          `preference="${config.prefsPrefix}.${k}"`,
          `${k} must be bound`,
        );
      }
    });
  });
});
