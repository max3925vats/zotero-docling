import { assert } from "chai";
import { normalizeServerUrl } from "../src/modules/convert";

// Issue #44: docling-serve behind a reverse proxy lives at a sub-path such
// as http://host:9292/upstream/docling-serve. The configured URL is a base
// that every endpoint (/health, /v1/convert/file, ...) is appended to.
describe("normalizeServerUrl", function () {
  it("accepts a bare origin", function () {
    assert.deepEqual(normalizeServerUrl("http://localhost:5001"), {
      ok: true,
      url: "http://localhost:5001",
    });
  });

  it("keeps a base path for reverse-proxied servers", function () {
    assert.deepEqual(
      normalizeServerUrl("http://host:9292/upstream/docling-serve"),
      { ok: true, url: "http://host:9292/upstream/docling-serve" },
    );
  });

  it("strips trailing slashes and surrounding whitespace", function () {
    assert.deepEqual(normalizeServerUrl("  https://example.org/docling//  "), {
      ok: true,
      url: "https://example.org/docling",
    });
  });

  it("rejects an empty value", function () {
    assert.isFalse(normalizeServerUrl("   ").ok);
  });

  it("rejects a URL without a scheme and suggests adding http://", function () {
    // "localhost:5001" parses as scheme "localhost:", so this used to fall
    // through to a confusing "Unsupported scheme" message.
    const r = normalizeServerUrl("localhost:5001");
    assert.isFalse(r.ok);
    assert.include(
      (r as { message: string }).message,
      "Try http://localhost:5001",
    );
  });

  it("rejects non-http schemes", function () {
    assert.isFalse(normalizeServerUrl("ftp://example.org").ok);
  });

  it("rejects a query string or fragment, which would break appended paths", function () {
    assert.isFalse(normalizeServerUrl("http://host/docling?x=1").ok);
    assert.isFalse(normalizeServerUrl("http://host/docling#frag").ok);
  });
});
