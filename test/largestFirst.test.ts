import { expect } from "chai";
import { sortLargestFirst } from "../src/utils/zotero";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// With parallel conversions a large PDF started last runs on alone at the
// end of the batch, so batches start the largest files first.

describe("sortLargestFirst", function () {
  this.timeout(20000);

  afterEach(async function () {
    await cleanupTestItems();
  });

  describe("ordering", function () {
    it("When attachments differ in size, then the largest comes first", async function () {
      // Arrange
      const parent = await makeParentItem();
      const small = await makeFileAttachment(
        parent,
        "small.pdf",
        "application/pdf",
        "x".repeat(10),
      );
      const large = await makeFileAttachment(
        parent,
        "large.pdf",
        "application/pdf",
        "x".repeat(50_000),
      );
      const medium = await makeFileAttachment(
        parent,
        "medium.pdf",
        "application/pdf",
        "x".repeat(5_000),
      );
      // Act
      const sorted = await sortLargestFirst([small, large, medium]);
      // Assert
      expect(sorted.map((i) => i.id)).to.deep.equal([
        large.id,
        medium.id,
        small.id,
      ]);
    });

    it("When files are the same size or missing, then their original order is kept", async function () {
      // Arrange
      const parent = await makeParentItem();
      const first = await makeFileAttachment(
        parent,
        "one.pdf",
        "application/pdf",
        "same",
      );
      const second = await makeFileAttachment(
        parent,
        "two.pdf",
        "application/pdf",
        "same",
      );
      const missing = await makeFileAttachment(
        parent,
        "gone.pdf",
        "application/pdf",
        "x".repeat(1000),
      );
      await IOUtils.remove(missing.getFilePath() as string);
      // Act
      const sorted = await sortLargestFirst([missing, first, second]);
      // Assert
      expect(sorted.map((i) => i.id)).to.deep.equal([
        first.id,
        second.id,
        missing.id,
      ]);
    });
  });
});
