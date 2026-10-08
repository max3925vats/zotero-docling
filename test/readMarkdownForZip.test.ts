import { assert } from "chai";
import { readMarkdownForZip } from "../src/modules/markdownZipExport";

// Issue #56 follow-up: IOUtils.read() hands back a Uint8Array from Zotero's
// realm, and JSZip's `instanceof Uint8Array` check fails across realms inside
// the plugin sandbox ("Can't read the data of 'x.md'. Is it in a supported
// JavaScript type"). Reading as a string sidesteps that — strings are
// primitives, so they are the same type in every realm.
describe("readMarkdownForZip", function () {
  let path: string;

  beforeEach(async function () {
    path = PathUtils.join(
      PathUtils.tempDir,
      `zd-readMarkdownForZip-${Date.now()}.md`,
    );
  });

  afterEach(async function () {
    await IOUtils.remove(path, { ignoreAbsent: true });
  });

  it("returns the file contents as a string, not bytes", async function () {
    await IOUtils.writeUTF8(path, "# Title\n");
    const data = await readMarkdownForZip(path);
    assert.strictEqual(typeof data, "string");
  });

  it("round-trips non-ASCII text unchanged", async function () {
    const text = "# µg/mL — Größe 漢字 ✓\n";
    await IOUtils.writeUTF8(path, text);
    assert.strictEqual(await readMarkdownForZip(path), text);
  });
});
