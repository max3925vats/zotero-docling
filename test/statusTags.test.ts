import { expect } from "chai";
import { config } from "../package.json";
import {
  applyStatusTagsToParents,
  type ConvertResult,
} from "../src/modules/convert";
import {
  cleanupTestItems,
  makeFileAttachment,
  makeParentItem,
} from "./_zoteroItems";

// Status tags used to be saved with one transaction per parent, one after
// another, after the whole batch. They're now saved in chunks.

const ok: ConvertResult = { status: "ok", attachmentID: 1 };
const error: ConvertResult = { status: "error", message: "HTTP 500" };
const skipped: ConvertResult = { status: "skipped", reason: "exists" };

function statusTags(item: Zotero.Item): string[] {
  return item
    .getTags()
    .map((t) => t.tag)
    .filter((t) => t.startsWith("docling/"))
    .sort();
}

describe("applyStatusTagsToParents", function () {
  this.timeout(60000);

  before(function () {
    (globalThis as any).addon = (Zotero as any)[config.addonInstance];
  });

  afterEach(async function () {
    await cleanupTestItems();
  });

  describe("tag choice", function () {
    it("When results are all OK, some OK, all errors or all skipped, then each parent gets done, incomplete, error or no change", async function () {
      // Arrange
      const done = await makeParentItem("All OK");
      const partial = await makeParentItem("Some failed");
      const failed = await makeParentItem("All failed");
      const untouched = await makeParentItem("All skipped");
      untouched.addTag("docling/done", 0);
      await untouched.saveTx();
      const pdf = (p: Zotero.Item, n: string) =>
        makeFileAttachment(p, n, "application/pdf");
      const results = [
        { item: await pdf(done, "a.pdf"), result: ok },
        { item: await pdf(partial, "b1.pdf"), result: ok },
        { item: await pdf(partial, "b2.pdf"), result: error },
        { item: await pdf(failed, "c.pdf"), result: error },
        { item: await pdf(untouched, "d.pdf"), result: skipped },
      ];
      // Act
      await applyStatusTagsToParents(results);
      // Assert
      expect([done, partial, failed, untouched].map(statusTags)).to.deep.equal([
        ["docling/done"],
        ["docling/incomplete"],
        ["docling/error"],
        ["docling/done"],
      ]);
    });

    it("When a parent had an earlier status tag, then it is replaced", async function () {
      // Arrange
      const parent = await makeParentItem("Retried");
      parent.addTag("docling/error", 0);
      await parent.saveTx();
      const pdf = await makeFileAttachment(parent, "e.pdf", "application/pdf");
      // Act
      await applyStatusTagsToParents([{ item: pdf, result: ok }]);
      // Assert
      expect(statusTags(parent)).to.deep.equal(["docling/done"]);
    });
  });

  describe("large batches", function () {
    it("When more parents than one chunk are tagged, then every parent gets its tag", async function () {
      // Arrange: 60 parents, more than one 50-parent transaction.
      const results: Array<{ item: Zotero.Item; result: ConvertResult }> = [];
      const parents: Zotero.Item[] = [];
      for (let i = 0; i < 60; i++) {
        const parent = await makeParentItem(`Paper ${i}`);
        parents.push(parent);
        results.push({
          item: await makeFileAttachment(
            parent,
            `p${i}.pdf`,
            "application/pdf",
          ),
          result: ok,
        });
      }
      // Act
      await applyStatusTagsToParents(results);
      // Assert
      expect(parents.every((p) => p.hasTag("docling/done"))).to.equal(true);
    });
  });
});
