import { expect } from "chai";
import { config } from "../package.json";
import { collectZipEntries } from "../src/modules/markdownZipExport";
import { stripImagesFromFiles } from "../src/modules/removeImages";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Remove Images and the zip export now read (and rewrite) several markdown
// files at once. Results and zip entry names must match the old one-at-a-
// time behavior.

const IMAGE = "![fig](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)";

describe("parallel markdown file I/O", function () {
  this.timeout(30000);

  before(function () {
    const g = globalThis as any;
    g.addon = (Zotero as any)[config.addonInstance];
    // A getter, not a snapshot: window loads replace addon.data.ztoolkit.
    Object.defineProperty(g, "ztoolkit", {
      configurable: true,
      get: () => g.addon.data.ztoolkit,
    });
  });

  afterEach(async function () {
    await cleanupTestItems();
  });

  describe("stripImagesFromFiles", function () {
    it("When many files are rewritten, then every file is stripped and the counts add up", async function () {
      // Arrange: 9 files with images, 2 without, 1 whose file is gone.
      const parent = await makeParentItem();
      const md = (name: string, text: string) =>
        makeFileAttachment(parent, name, "text/markdown", text);
      const withImages = [];
      for (let i = 0; i < 9; i++) {
        withImages.push(await md(`fig${i}.md`, `# Paper ${i}\n${IMAGE}\n`));
      }
      const plain = [
        await md("plain1.md", "# No figures\n"),
        await md("plain2.md", "# Text only\n"),
      ];
      const gone = await md("gone.md", `# Gone\n${IMAGE}\n`);
      await IOUtils.remove(gone.getFilePath() as string);

      // Act
      const stats = await stripImagesFromFiles([...withImages, ...plain, gone]);

      // Assert
      expect({
        changed: stats.changed,
        imagesReplaced: stats.imagesReplaced,
        untouched: stats.untouched,
        failed: stats.failed,
      }).to.deep.equal({
        changed: 9,
        imagesReplaced: 9,
        untouched: 2,
        failed: 1,
      });
      const after = await IOUtils.readUTF8(
        withImages[4].getFilePath() as string,
      );
      expect(after).to.equal("# Paper 4\n<!-- image -->\n");
    });
  });

  describe("collectZipEntries", function () {
    it("When rows are read in parallel, then entry names follow row order and unreadable rows don't claim a name", async function () {
      // Arrange: one parent with four PDFs; the second PDF's .md is gone and
      // the fourth has none, so names go .md, .1.md for rows 1 and 3.
      const parent = await makeParentItem();
      const rows = [];
      for (let i = 0; i < 4; i++) {
        const pdf = await makeFileAttachment(
          parent,
          `part${i}.pdf`,
          "application/pdf",
        );
        const mdChild =
          i === 3
            ? null
            : await makeFileAttachment(
                parent,
                `part${i}.md`,
                "text/markdown",
                `# Part ${i}\n`,
              );
        rows.push({ parent, pdf, mdChild });
      }
      await IOUtils.remove(rows[1].mdChild!.getFilePath() as string);

      // Act
      const collected = await collectZipEntries(rows);

      // Assert
      expect(collected.entries).to.deep.equal([
        { name: `${parent.key}.md`, text: "# Part 0\n" },
        { name: `${parent.key}.1.md`, text: "# Part 2\n" },
      ]);
      expect([collected.skipped, collected.failedReads]).to.deep.equal([1, 1]);
    });
  });
});
