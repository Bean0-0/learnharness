/**
 * CATEGORY NAMES FOR IMPORTED NOTES (owner, 2026-10-26): a notes file's
 * graph cluster is labeled with a tidied FILENAME, not its raw import
 * path ("markdown/notes/09_chapter3normal.md" → "Chapter 3 normal"). The
 * stored filePath stays the source's identity (re-import matching,
 * provenance); this is display only. Pure and browser-safe.
 *
 * Rules: last path segment; drop the extension; drop a leading order
 * number ("09_"); underscores/dashes → spaces; split camelCase,
 * acronym→word ("XMLParser" → "XML Parser"), word→number ("chapter3")
 * and number→word ("3normal"); capitalize the first letter. Abbreviations
 * and casing are otherwise kept. Never empty: falls back to the filename.
 */
export function tidySourceLabel(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const stem = base.replace(/\.[^.]*$/, "");
	const label = stem
		.replace(/^\d+[\s._-]+(?=\S)/, "")
		.replace(/[_-]+/g, " ")
		.replace(/(?<=[a-z])(?=[A-Z])/g, " ")
		.replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, " ")
		.replace(/(?<=[a-zA-Z]{2})(?=\d)/g, " ")
		.replace(/(?<=\d)(?=[a-zA-Z])/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!label) return base;
	return label[0]!.toUpperCase() + label.slice(1);
}
