import { expect } from "chai";
import { config } from "../package.json";
import {
  convertAttachment,
  setFetchOverrideForTests,
} from "../src/modules/convert";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

const PREFIX = config.prefsPrefix;
const TOUCHED = [
  "serverUrl",
  "addFrontmatter",
  "attachToItem",
  "exportFolderPath",
  "useAsyncEndpoint",
];

// With Parallel conversions > 1, two PDFs under one parent write the same
// export file at once. A direct write could interleave them.
describe("export folder writes under parallel conversions", function () {
  this.timeout(20000);
  let folder: string;

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
  });

  beforeEach(async function () {
    folder = PathUtils.join(PathUtils.tempDir, `zd-export-${Date.now()}`);
    Zotero.Prefs.set(`${PREFIX}.serverUrl`, "http://docling.test", true);
    Zotero.Prefs.set(`${PREFIX}.addFrontmatter`, false, true);
    Zotero.Prefs.set(`${PREFIX}.useAsyncEndpoint`, false, true);
    Zotero.Prefs.set(`${PREFIX}.attachToItem`, false, true);
    Zotero.Prefs.set(`${PREFIX}.exportFolderPath`, folder, true);
  });

  afterEach(async function () {
    setFetchOverrideForTests(null);
    for (const k of TOUCHED) Zotero.Prefs.clear(`${PREFIX}.${k}`, true);
    await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
    await cleanupTestItems();
  });

  it("When two PDFs under one parent export at once, then the file is one complete conversion and no temp files are left", async function () {
    // Arrange: each PDF converts to a large, distinct markdown body.
    const bodies: Record<string, string> = {
      "first.pdf": `# first\n${"a".repeat(2_000_000)}`,
      "second.pdf": `# second\n${"b".repeat(500_000)}`,
    };
    setFetchOverrideForTests((async (_url: string, init: RequestInit) => {
      const file = (init.body as FormData).get("files") as File;
      return new Response(
        JSON.stringify({
          status: "success",
          document: { md_content: bodies[file.name] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    const parent = await makeParentItem();
    const first = await makeFileAttachment(
      parent,
      "first.pdf",
      "application/pdf",
    );
    const second = await makeFileAttachment(
      parent,
      "second.pdf",
      "application/pdf",
    );

    // Act
    const results = await Promise.all([
      convertAttachment(first),
      convertAttachment(second),
    ]);

    // Assert
    expect(results.map((r) => r.status)).to.deep.equal(["ok", "ok"]);
    const written = await IOUtils.readUTF8(
      PathUtils.join(folder, `${parent.key}.md`),
    );
    expect(Object.values(bodies)).to.include(written);
    expect(await IOUtils.getChildren(folder)).to.have.lengthOf(1);
  });
});
