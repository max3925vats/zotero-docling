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
 * Escape a string as a single-line, double-quoted YAML scalar. Besides `\`
 * and `"`, newlines/tabs and other control characters must be escaped too:
 * a raw newline followed by `---` in a title used to end the frontmatter
 * block early, and stray control characters made the YAML invalid.
 */
// Characters YAML can't carry literally in a quoted scalar: C0/C1 controls
// (C1 shows up in PDF metadata decoded with the wrong charset; NEL U+0085
// is silently folded to a space), DEL, line/paragraph separators (line
// breaks to YAML 1.1 parsers), BOM / non-characters, and lone surrogates.
const YAML_UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufeff\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function yamlString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(YAML_UNSAFE, (c) => {
      const code = c.charCodeAt(0);
      return code <= 0xff
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : `\\u${code.toString(16).padStart(4, "0")}`;
    });
  return `"${escaped}"`;
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

type Creator = {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorTypeID?: number;
};

/** Creators of the item type's primary role, or all of them if none match. */
function primaryCreators(parent: Zotero.Item, creators: Creator[]): Creator[] {
  let primaryID: number | false | undefined;
  try {
    primaryID = Zotero.CreatorTypes.getPrimaryIDForType(parent.itemTypeID);
  } catch {
    primaryID = undefined;
  }
  if (!primaryID) return creators;
  const primary = creators.filter((c) => c.creatorTypeID === primaryID);
  return primary.length > 0 ? primary : creators;
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
  // Only the item type's primary creators (authors for most types), so
  // editors and translators aren't listed as authors. If none qualify, fall
  // back to everyone rather than emitting nothing.
  const primary = primaryCreators(parent, creators);
  const authors = primary.map(creatorToString).filter((s) => s.length > 0);
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
    // [ \t]* rather than \s*: \s also matches a newline, which picked up a
    // word from the next line when the key itself was empty.
    const m = extra.match(/^Citation Key:[ \t]*(\S+)/m);
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
  // The closing fence is a line that is exactly "---" (trailing spaces/CR
  // allowed). Matching any "\n---" also stopped at "----" or "---x".
  const close = /\r?\n---[ \t]*\r?(?:\n|$)/g;
  close.lastIndex = 3;
  const m = close.exec(md);
  if (!m) return md;
  return md.slice(m.index + m[0].length);
}
