// Shared upload contract. The per-file cap leaves room for multipart headers
// and relative paths inside the server's hard per-request cap.
const MiB = 1024 * 1024;
export const MAX_IMPORT_REQUEST_BYTES = 8 * MiB;
export const MAX_IMPORT_FILE_BYTES = 7 * MiB;
export const MAX_IMPORT_FILES = 64;
export const formatMiB = (bytes: number) => `${bytes / MiB} MiB`;
export const IMPORT_EXTENSIONS = /\.(?:md|markdown|txt)$/i;

/** Folder-relative paths are graph source identity, never filesystem paths. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		// Chromium submits folder-selected Files with the full relative path as
		// multipart filename; other clients send only the basename.
		&& (parts.at(-1) === filename || path === filename);
}
