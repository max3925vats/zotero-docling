import { assert } from "chai";
import {
  findMatchingMdChild,
  hasMarkdownChild,
  mdNameForPdf,
} from "../src/utils/zotero";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Audit H1: a PDF whose filename has no ".pdf" extension (e.g. "fulltext")
// used to be its own "matching .md" — so Convert always skipped it and
// Re-convert permanently erased the PDF. The markdown sibling must be a
// markdown attachment named <stem>.md, never the PDF itself.
describe("markdown sibling matching", function () {
  describe("mdNameForPdf", function () {
    it("swaps a .pdf extension for .md", function () {
      assert.strictEqual(mdNameForPdf("paper.pdf"), "paper.md");
    });

    it("is case-insensitive about the .pdf extension", function () {
      assert.strictEqual(mdNameForPdf("Paper.PDF"), "Paper.md");
    });

    it("appends .md when the PDF has no extension", function () {
      assert.strictEqual(mdNameForPdf("fulltext"), "fulltext.md");
    });

    it("only strips the final .pdf", function () {
      assert.strictEqual(mdNameForPdf("a.pdf.pdf"), "a.pdf.md");
    });
  });

  describe("with real Zotero items", function () {
    afterEach(async function () {
      await cleanupTestItems();
    });

    it("never treats an extensionless PDF as its own markdown sibling", async function () {
      const parent = await makeParentItem();
      await makeFileAttachment(parent, "fulltext", "application/pdf");

      assert.isNull(findMatchingMdChild(parent.id, "fulltext"));
      assert.isFalse(await hasMarkdownChild(parent.id, "fulltext"));
    });

    it("finds <stem>.md for an extensionless PDF", async function () {
      const parent = await makeParentItem();
      await makeFileAttachment(parent, "fulltext", "application/pdf");
      const md = await makeFileAttachment(
        parent,
        "fulltext.md",
        "text/markdown",
      );

      assert.strictEqual(findMatchingMdChild(parent.id, "fulltext")?.id, md.id);
    });

    it("still matches paper.md for paper.pdf", async function () {
      const parent = await makeParentItem();
      await makeFileAttachment(parent, "paper.pdf", "application/pdf");
      const md = await makeFileAttachment(parent, "paper.md", "text/markdown");

      assert.strictEqual(
        findMatchingMdChild(parent.id, "paper.pdf")?.id,
        md.id,
      );
      assert.isTrue(await hasMarkdownChild(parent.id, "paper.pdf"));
    });

    it("matches nothing for an empty PDF filename", async function () {
      const parent = await makeParentItem();
      await makeFileAttachment(parent, "paper.md", "text/markdown");

      assert.isNull(findMatchingMdChild(parent.id, ""));
    });
  });
});
