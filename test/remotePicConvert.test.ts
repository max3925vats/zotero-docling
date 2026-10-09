import { assert } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import { clearCapabilitiesCache } from "../src/modules/remotePictureApi";
import { clearAllSecrets, setSecret } from "../src/utils/secrets";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// End-to-end through convertAttachment with a scripted docling-serve: the
// right picture-description field reaches /v1/convert/file.

const P = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "useAsyncEndpoint",
  "addFrontmatter",
  "attachToItem",
  "remotePicApiEnabled",
  "remotePicApiProvider",
  "remotePicApiUrl",
  "remotePicApiModel",
];
const set = (k: string, v: unknown) =>
  Zotero.Prefs.set(`${P}.${k}`, v as never, true);

function server(
  customAllowed: boolean,
  seen: { form?: FormData },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/capabilities")) {
      return new Response(
        JSON.stringify({
          stages: {
            picture_description: {
              custom_config_option: customAllowed
                ? "picture_description_custom_config"
                : null,
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/v1/convert/file")) {
      seen.form = init?.body as FormData;
      return new Response(
        JSON.stringify({
          status: "success",
          document: { md_content: "# ok\n\nMOCK-DESCRIPTION" },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }) as typeof fetch;
}

describe("remote picture API in conversions", function () {
  this.timeout(20000);

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
  });

  beforeEach(async function () {
    clearCapabilitiesCache();
    set("serverUrl", "http://docling.test");
    set("useAsyncEndpoint", false);
    set("addFrontmatter", false);
    set("attachToItem", true);
    set("remotePicApiEnabled", true);
    set("remotePicApiProvider", "openai");
    set("remotePicApiUrl", "https://api.openai.com/v1/chat/completions");
    set("remotePicApiModel", "gpt-x");
    await setSecret("remote-picture-api", "sk-test");
  });

  afterEach(async function () {
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${P}.${k}`, true);
    await clearAllSecrets();
    await cleanupTestItems();
  });

  async function convertOne(): Promise<
    Awaited<ReturnType<typeof convertAttachment>>
  > {
    const parent = await makeParentItem();
    const pdf = await makeFileAttachment(
      parent,
      "paper.pdf",
      "application/pdf",
      "%PDF-1.4",
    );
    return convertAttachment(pdf);
  }

  it("sends the legacy field when the server doesn't allow custom configs", async function () {
    const seen: { form?: FormData } = {};
    setFetchOverrideForTests(server(false, seen));
    const r = await convertOne();
    assert.strictEqual(r.status, "ok");
    const v = JSON.parse(String(seen.form!.get("picture_description_api")));
    assert.deepEqual(v.headers, { Authorization: "Bearer sk-test" });
    assert.isNull(seen.form!.get("picture_description_custom_config"));
  });

  it("sends the custom-config field when the server allows it", async function () {
    const seen: { form?: FormData } = {};
    setFetchOverrideForTests(server(true, seen));
    await convertOne();
    assert.ok(seen.form!.get("picture_description_custom_config"));
    assert.isNull(seen.form!.get("picture_description_api"));
  });

  it("fails before contacting docling-serve when the model is missing", async function () {
    set("remotePicApiModel", "");
    const seen: { form?: FormData } = {};
    setFetchOverrideForTests(server(false, seen));
    const r = await convertOne();
    assert.strictEqual(r.status, "error");
    assert.match((r as { message: string }).message, /model name/);
    assert.isUndefined(seen.form);
  });
});
