// Build a YAML frontmatter block from a Zotero parent item's metadata.
// Prepended to the .md output when the `addFrontmatter` pref is on.
//
// Field set (intentionally lean):
//   title, authors, year, doi, url, zotero_key, citation_key
//
// Tools that consume .md (Obsidian, RAG indexers, scripts) all understand
// the YAML --- header pattern; this gives them enough metadata to link the
// markdown back to the Zotero item it came from.

/**
 * Escape a string for a single-line YAML scalar value. We always wrap the
 * value in double quotes and escape backslashes + quotes inside, which is
 * robust enough for the small set of fields we emit.
 */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render an authors array as a YAML inline list of double-quoted strings.
 * Returns `[]` if there are no authors.
 */
function yamlAuthorList(authors: string[]): string {
  if (authors.length === 0) return "[]";
  return `[${authors.map(yamlString).join(", ")}]`;
}

/**
 * Pull "Last, First" or "First Last" out of a Zotero creator record into
 * a single display string. Falls back to whatever's present.
 */
function creatorToString(c: {
  firstName?: string;
  lastName?: string;
  name?: string;
}): string {
  if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
  if (c.lastName) return c.lastName;
  if (c.firstName) return c.firstName;
  if (c.name) return c.name;
  return "";
}

/**
 * Build the YAML frontmatter block (no trailing newline). Returns empty
 * string if there's no useful metadata to emit (parent missing or null).
 */
export function buildFrontmatter(parent: Zotero.Item | null): string {
  if (!parent) return "";

  const fields: string[] = [];

  // title
  const title = (parent.getField?.("title") as string | undefined) ?? "";
  if (title) fields.push(`title: ${yamlString(title)}`);

  // authors — Zotero exposes creators as an array on the item
  const creators = (parent.getCreators?.() ?? []) as Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
    creatorTypeID?: number;
  }>;
  const authors = creators.map(creatorToString).filter((s) => s.length > 0);
  if (authors.length > 0) fields.push(`authors: ${yamlAuthorList(authors)}`);

  // year — parsed from the `date` field, which is free-form
  const date = (parent.getField?.("date") as string | undefined) ?? "";
  const yearMatch = date.match(/\b(\d{4})\b/);
  if (yearMatch) fields.push(`year: ${yearMatch[1]}`);

  // doi
  const doi = (parent.getField?.("DOI") as string | undefined) ?? "";
  if (doi) fields.push(`doi: ${yamlString(doi)}`);

  // url
  const url = (parent.getField?.("url") as string | undefined) ?? "";
  if (url) fields.push(`url: ${yamlString(url)}`);

  // zotero_key — stable identifier within the user's library
  if (parent.key) fields.push(`zotero_key: ${yamlString(parent.key)}`);

  // citation_key — Better BibTeX populates "Citation Key" on items it has
  // assigned one to. Try the standard field name first; fall back to
  // extra-field parsing.
  let citationKey = (
    (parent.getField?.("citationKey") as string | undefined) ?? ""
  ).trim();
  if (!citationKey) {
    const extra = (parent.getField?.("extra") as string | undefined) ?? "";
    const m = extra.match(/^Citation Key:\s*(\S+)/m);
    if (m) citationKey = m[1];
  }
  if (citationKey) fields.push(`citation_key: ${yamlString(citationKey)}`);

  if (fields.length === 0) return "";
  return ["---", ...fields, "---", ""].join("\n");
}

/**
 * Strip an existing YAML frontmatter block from the beginning of a markdown
 * string, if present. Used so we can safely re-apply our own frontmatter on
 * a re-convert without stacking blocks.
 */
export function stripExistingFrontmatter(md: string): string {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return md;
  const closeIdx = md.indexOf("\n---", 4);
  if (closeIdx === -1) return md;
  // Skip the closing "---" and any single newline after it.
  let end = closeIdx + 4;
  if (md[end] === "\n") end++;
  return md.slice(end);
}
