// Shared upload contract. Leave room for multipart headers/relative paths inside
// the server's hard 8 MiB request limit.
export const MAX_IMPORT_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 7 * 1024 * 1024;
export const MAX_IMPORT_BATCH_FILES = 3;
export const IMPORT_EXTENSIONS = /\.(?:md|markdown|txt|html|htm)$/i;

/** Folder-relative paths are graph source identity, never filesystem paths. */
export function validNotesPath(path: string, filename: string): boolean {
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
		&& path.split("/").at(-1) === filename;
}
