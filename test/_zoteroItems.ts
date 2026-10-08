// Helpers that create REAL Zotero items for integration tests (they only run
// inside Zotero via `npm test`). Mocks hide schema mistakes — e.g. a filename
// rule that matches the wrong attachment — so tests that touch attachment
// lookup use real items instead.
//
// Every helper registers what it creates; call `cleanupTestItems()` in
// afterEach so the test profile doesn't accumulate junk between cases.

const created: Zotero.Item[] = [];

/** Create and save a parent journal article. */
export async function makeParentItem(
  title = "Test parent",
): Promise<Zotero.Item> {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", title);
  await item.saveTx();
  created.push(item);
  return item;
}

/**
 * Import a file attachment under `parent` with exactly `filename` (which may
 * have no extension — that's the point of some tests) and `contentType`.
 */
export async function makeFileAttachment(
  parent: Zotero.Item,
  filename: string,
  contentType: string,
  contents = "test",
): Promise<Zotero.Item> {
  const dir = PathUtils.join(
    PathUtils.tempDir,
    `zd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const path = PathUtils.join(dir, filename);
  await IOUtils.writeUTF8(path, contents);
  const att = await Zotero.Attachments.importFromFile({
    file: path,
    parentItemID: parent.id,
    contentType,
  });
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  created.push(att);
  return att;
}

/** Permanently erase everything the helpers created (test profile only). */
export async function cleanupTestItems(): Promise<void> {
  // Children before parents so erasing a parent doesn't race its children.
  for (const item of created.reverse()) {
    try {
      await item.eraseTx();
    } catch {
      /* already gone */
    }
  }
  created.length = 0;
}
