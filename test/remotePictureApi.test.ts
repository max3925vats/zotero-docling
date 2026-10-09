// The pure #cold suite stays separate from the Zotero-dependent suites below.
/* eslint-disable mocha/max-top-level-suites */
import { assert } from "chai";
import { config } from "../package.json";
import { getWebApis, setFetchOverrideForTests } from "../src/modules/convert";
import {
  buildRemotePicField,
  clearCapabilitiesCache,
  readRemoteSettings,
  resolveRemoteMode,
  testRemoteApi,
  DEFAULT_PROMPT,
  headersFor,
  modelsUrl,
  PROVIDERS,
  validateRemoteSettings,
  type RemoteSettings,
} from "../src/modules/remotePictureApi";
import { PROVIDER_SECRET_IDS } from "../src/utils/secrets";

const base: RemoteSettings = {
  provider: "openai",
  url: PROVIDERS.openai.url,
  model: "gpt-x",
  prompt: "",
  timeoutSec: 120,
};

describe("remotePictureApi #cold", function () {
  describe("headersFor", function () {
    it("sends Bearer for OpenAI-style providers", function () {
      assert.deepEqual(headersFor("openai", "sk"), {
        Authorization: "Bearer sk",
      });
      assert.deepEqual(headersFor("openrouter", "sk"), {
        Authorization: "Bearer sk",
      });
    });

    it("sends no header for local providers without a key", function () {
      assert.deepEqual(headersFor("ollama", ""), {});
      assert.deepEqual(headersFor("vllm", ""), {});
      assert.deepEqual(headersFor("custom", ""), {});
    });

    it("sends Bearer for local providers when a key is set", function () {
      assert.deepEqual(headersFor("vllm", "k"), { Authorization: "Bearer k" });
    });

    it("sends Anthropic's headers", function () {
      assert.deepEqual(headersFor("anthropic", "ak"), {
        Authorization: "Bearer ak",
        "x-api-key": "ak",
        "anthropic-version": "2023-06-01",
      });
    });
  });

  describe("validateRemoteSettings", function () {
    it("accepts complete settings", function () {
      assert.isNull(validateRemoteSettings(base, "sk"));
    });

    it("requires a model", function () {
      assert.match(
        validateRemoteSettings({ ...base, model: " " }, "sk")!,
        /model/i,
      );
    });

    it("requires a valid http(s) URL", function () {
      assert.match(
        validateRemoteSettings({ ...base, url: "nope" }, "sk")!,
        /URL/,
      );
    });

    it("requires a key for paid providers only", function () {
      assert.match(validateRemoteSettings(base, "")!, /API key/);
      assert.isNull(
        validateRemoteSettings(
          { ...base, provider: "ollama", url: PROVIDERS.ollama.url },
          "",
        ),
      );
    });
  });

  describe("buildRemotePicField", function () {
    it("builds the legacy picture_description_api payload (captured 2026-10-09)", function () {
      const f = buildRemotePicField("legacy", { ...base, prompt: "P" }, "sk");
      assert.strictEqual(f.name, "picture_description_api");
      assert.deepEqual(JSON.parse(f.value), {
        url: PROVIDERS.openai.url,
        headers: { Authorization: "Bearer sk" },
        params: { model: "gpt-x" },
        prompt: "P",
        timeout: 120,
      });
    });

    it("builds the custom-config payload with the required model_spec", function () {
      const f = buildRemotePicField("custom", base, "sk");
      assert.strictEqual(f.name, "picture_description_custom_config");
      assert.deepEqual(JSON.parse(f.value), {
        engine_options: {
          engine_type: "api_openai",
          url: PROVIDERS.openai.url,
          headers: { Authorization: "Bearer sk" },
          params: { model: "gpt-x" },
          timeout: 120,
        },
        model_spec: {
          name: "zotero-docling-remote",
          default_repo_id: "none/none",
          prompt: DEFAULT_PROMPT,
          response_format: "markdown",
          api_overrides: {},
        },
        prompt: DEFAULT_PROMPT,
      });
    });

    it("trims the URL and model", function () {
      const f = buildRemotePicField(
        "legacy",
        { ...base, url: ` ${PROVIDERS.openai.url} `, model: " m " },
        "",
      );
      const v = JSON.parse(f.value);
      assert.strictEqual(v.url, PROVIDERS.openai.url);
      assert.deepEqual(v.params, { model: "m" });
    });
  });

  describe("provider key slots", function () {
    it("cover exactly the providers in PROVIDERS", function () {
      // secrets.ts keeps its own copy of the ids (it can't import modules/).
      assert.deepEqual([...PROVIDER_SECRET_IDS], Object.keys(PROVIDERS));
    });
  });

  describe("modelsUrl", function () {
    it("swaps /chat/completions for /models", function () {
      assert.strictEqual(
        modelsUrl("http://localhost:11434/v1/chat/completions"),
        "http://localhost:11434/v1/models",
      );
      assert.strictEqual(
        modelsUrl("https://openrouter.ai/api/v1/chat/completions/"),
        "https://openrouter.ai/api/v1/models",
      );
    });

    it("returns null for URLs it can't map", function () {
      assert.isNull(modelsUrl("https://example.com/describe"));
    });
  });
});

describe("resolveRemoteMode", function () {
  let calls = 0;
  function serve(res: () => Response): void {
    calls = 0;
    setFetchOverrideForTests((async (input: RequestInfo | URL) => {
      calls++;
      assert.match(String(input), /\/v1\/capabilities$/);
      return res();
    }) as typeof fetch);
  }
  const caps = (opt: string | null) => () =>
    new Response(
      JSON.stringify({
        stages: {
          picture_description: {
            option: "picture_description_preset",
            custom_config_option: opt,
          },
        },
      }),
      { status: 200 },
    );

  beforeEach(function () {
    return clearCapabilitiesCache();
  });

  afterEach(function () {
    return setFetchOverrideForTests(null);
  });

  it("picks custom when the server allows custom picture-description configs", async function () {
    serve(caps("picture_description_custom_config"));
    assert.strictEqual(
      await resolveRemoteMode("http://d.test", getWebApis()),
      "custom",
    );
  });

  it("picks legacy when custom configs are off", async function () {
    serve(caps(null));
    assert.strictEqual(
      await resolveRemoteMode("http://d.test", getWebApis()),
      "legacy",
    );
  });

  it("picks legacy when the endpoint is missing (docling-serve 1.18)", async function () {
    serve(() => new Response('{"detail":"Not Found"}', { status: 404 }));
    assert.strictEqual(
      await resolveRemoteMode("http://d.test", getWebApis()),
      "legacy",
    );
  });

  it("picks legacy on a non-JSON body", async function () {
    serve(() => new Response("<html>", { status: 200 }));
    assert.strictEqual(
      await resolveRemoteMode("http://d.test", getWebApis()),
      "legacy",
    );
  });

  it("picks legacy when the request throws", async function () {
    setFetchOverrideForTests((async () => {
      throw new TypeError("NetworkError");
    }) as typeof fetch);
    assert.strictEqual(
      await resolveRemoteMode("http://d.test", getWebApis()),
      "legacy",
    );
  });

  it("caches per server URL", async function () {
    serve(caps("picture_description_custom_config"));
    await resolveRemoteMode("http://d.test", getWebApis());
    await resolveRemoteMode("http://d.test", getWebApis());
    assert.strictEqual(calls, 1);
    await resolveRemoteMode("http://other.test", getWebApis());
    assert.strictEqual(calls, 2);
  });

  it("re-probes after clearCapabilitiesCache", async function () {
    serve(caps(null));
    await resolveRemoteMode("http://d.test", getWebApis());
    clearCapabilitiesCache();
    await resolveRemoteMode("http://d.test", getWebApis());
    assert.strictEqual(calls, 2);
  });
});

describe("readRemoteSettings", function () {
  // Resolved lazily: config access in the describe body trips mocha/no-setup-in-describe.
  const P = (): string => config.prefsPrefix;

  afterEach(function () {
    for (const k of [
      "remotePicApiProvider",
      "remotePicApiUrl",
      "remotePicApiModel",
      "remotePicApiPrompt",
      "remotePicApiTimeoutSec",
    ])
      Zotero.Prefs.clear(`${P()}.${k}`, true);
  });

  it("reads prefs and falls back to 120 s for a bad timeout", function () {
    Zotero.Prefs.set(`${P()}.remotePicApiProvider`, "ollama", true);
    Zotero.Prefs.set(`${P()}.remotePicApiModel`, "qwen2.5vl:3b", true);
    Zotero.Prefs.set(`${P()}.remotePicApiTimeoutSec`, 0, true);
    const s = readRemoteSettings();
    assert.strictEqual(s.provider, "ollama");
    assert.strictEqual(s.model, "qwen2.5vl:3b");
    assert.strictEqual(s.timeoutSec, 120);
  });

  it("treats an unknown provider as custom", function () {
    Zotero.Prefs.set(`${P()}.remotePicApiProvider`, "nonsense", true);
    assert.strictEqual(readRemoteSettings().provider, "custom");
  });
});

describe("testRemoteApi", function () {
  const s = {
    provider: "openai" as const,
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-x",
    prompt: "",
    timeoutSec: 120,
  };
  let seen: {
    url?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {};
  function serve(res: () => Response): void {
    seen = {};
    setFetchOverrideForTests((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen = {
        url: String(input),
        headers: init?.headers as Record<string, string>,
        method: init?.method,
      };
      return res();
    }) as typeof fetch);
  }
  const list =
    (...ids: string[]) =>
    () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
      });

  afterEach(function () {
    setFetchOverrideForTests(null);
  });

  it("asks before contacting a paid provider and sends nothing on Cancel", async function () {
    serve(list("gpt-x"));
    let asked = "";
    const r = await testRemoteApi(
      s,
      "sk",
      async (p, u) => {
        asked = `${p} ${u}`;
        return false;
      },
      getWebApis(),
    );
    assert.deepEqual(r, { ok: false, cancelled: true });
    assert.strictEqual(asked, "OpenAI https://api.openai.com/v1/models");
    assert.isUndefined(seen.url);
  });

  it("GETs /models with the provider's auth after confirmation", async function () {
    serve(list("gpt-x"));
    const r = await testRemoteApi(s, "sk", async () => true, getWebApis());
    assert.deepEqual(r, { ok: true, modelListed: true });
    assert.strictEqual(seen.url, "https://api.openai.com/v1/models");
    assert.strictEqual(seen.method, "GET");
    assert.deepEqual(seen.headers, { Authorization: "Bearer sk" });
  });

  it("does not ask for free local providers", async function () {
    serve(list("qwen2.5vl:3b"));
    let asked = false;
    const r = await testRemoteApi(
      {
        ...s,
        provider: "ollama",
        url: "http://localhost:11434/v1/chat/completions",
        model: "qwen2.5vl:3b",
      },
      "",
      async () => ((asked = true), true),
      getWebApis(),
    );
    assert.isFalse(asked);
    assert.deepEqual(r, { ok: true, modelListed: true });
  });

  it("reports a model missing from the list without failing", async function () {
    serve(list("other"));
    const r = await testRemoteApi(s, "sk", async () => true, getWebApis());
    assert.deepEqual(r, { ok: true, modelListed: false });
  });

  it("rejects a 200 that isn't an OpenAI-style model list", async function () {
    serve(() => new Response("<html>login</html>", { status: 200 }));
    const html = await testRemoteApi(s, "sk", async () => true, getWebApis());
    assert.isFalse(html.ok);
    assert.match(
      (html as { message: string }).message,
      /not an OpenAI-style model list/,
    );
    serve(() => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const noData = await testRemoteApi(s, "sk", async () => true, getWebApis());
    assert.isFalse(noData.ok);
  });

  it("explains a rejected key", async function () {
    serve(() => new Response("{}", { status: 401 }));
    const r = await testRemoteApi(s, "bad", async () => true, getWebApis());
    assert.isFalse(r.ok);
    assert.match((r as { message: string }).message, /key was rejected/i);
  });

  it("refuses a URL it can't turn into /models", async function () {
    const r = await testRemoteApi(
      { ...s, provider: "custom", url: "https://x.test/describe" },
      "",
      async () => true,
      getWebApis(),
    );
    assert.match((r as { message: string }).message, /chat\/completions/);
  });
});
