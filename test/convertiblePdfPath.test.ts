import { expect } from "chai";
import { convertiblePdfPath } from "../src/utils/zotero";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// convertAttachment used to check that the PDF exists twice (and the menu
// batch a third time for its progress label). convertiblePdfPath does the
// guard checks and returns the path from a single existence check.

describe("convertiblePdfPath", function () {
  this.timeout(20000);

  afterEach(async function () {
    await cleanupTestItems();
  });

  describe("convertible items", function () {
    it("When a PDF with a parent is on disk, then its file path is returned", async function () {
      // Arrange
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(
        parent,
        "attention.pdf",
        "application/pdf",
      );
      // Act
      const path = await convertiblePdfPath(pdf);
      // Assert
      expect(path).to.equal(pdf.getFilePath());
    });
  });

  describe("items that can't be converted", function () {
    it("When the PDF's file is missing, then null is returned", async function () {
      // Arrange
      const parent = await makeParentItem();
      const pdf = await makeFileAttachment(
        parent,
        "gone.pdf",
        "application/pdf",
      );
      await IOUtils.remove(pdf.getFilePath() as string);
      // Act
      const path = await convertiblePdfPath(pdf);
      // Assert
      expect(path).to.equal(null);
    });

    it("When the attachment isn't a PDF, then null is returned", async function () {
      // Arrange
      const parent = await makeParentItem();
      const md = await makeFileAttachment(parent, "notes.md", "text/markdown");
      // Act
      const path = await convertiblePdfPath(md);
      // Assert
      expect(path).to.equal(null);
    });
  });
});
