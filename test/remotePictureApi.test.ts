import { assert } from "chai";
import {
  buildRemotePicField,
  DEFAULT_PROMPT,
  headersFor,
  modelsUrl,
  PROVIDERS,
  validateRemoteSettings,
  type RemoteSettings,
} from "../src/modules/remotePictureApi";

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
