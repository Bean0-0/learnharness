/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", optional matching "paths" for folder-relative identity;
 * accepts Markdown, plain text and raw HTML); the pipeline mints a
 * deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool per request keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { extraction, NotesImportError } from "@/src/server";
import { htmlToNotesText } from "@/lib/html-to-text";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BATCH_BYTES, MAX_IMPORT_REQUEST_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import {
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
}

export async function POST(request: Request) {
	// Cap actual bytes even without a trustworthy Content-Length. formData()
	// alone buffers the entire multipart request before any worker starts.
	const tooLarge = () => Response.json({ error: "Import request exceeds 8 MiB limit" }, { status: 413 });
	if (Number(request.headers.get("content-length")) > MAX_IMPORT_REQUEST_BYTES) return tooLarge();
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_IMPORT_REQUEST_BYTES) { await reader.cancel(); return tooLarge(); }
		chunks.push(value);
	}
	const payload = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
	let form: FormData;
	try {
		form = await new Request(request.url, {
			method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" },
			body: new Blob([payload.buffer]),
		}).formData();
	} catch {
		return Response.json({ error: "Invalid multipart import request" }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}
	if (files.length > 64) return Response.json({ error: "Import request exceeds 64 files" }, { status: 400 });
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length && suppliedPaths.length !== files.length) return Response.json({ error: "Invalid import paths" }, { status: 400 });
	const paths = files.map((file, index) => suppliedPaths.length ? suppliedPaths[index] : file.name);
	if (files.some((file, index) => file.size > MAX_IMPORT_BATCH_BYTES || typeof paths[index] !== "string"
		|| !validNotesPath(paths[index] as string, file.name) || !IMPORT_EXTENSIONS.test(paths[index] as string))) {
		return Response.json({ error: "Import contains an oversized file, unsupported format or unsafe path" }, { status: 400 });
	}

	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, filePath: paths[requestIndex] as string, requestIndex }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, filePath, requestIndex } = next;
			try {
				const raw = await file.text();
				// HTML is mostly images/SVG; extract readable text + math (#190).
				const text = /\.html?$/i.test(filePath) ? htmlToNotesText(raw) : raw;
				const stats = await extraction.importNotes({ filePath, text });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({
						filePath,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: "models_not_configured",
						missing: err.envelope.missing,
					});
					continue;
				}
				if (err instanceof ProviderKeyMissingError) {
					results.push({
						filePath,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE,
						provider: err.envelope.provider,
						slots: err.envelope.slots,
					});
					continue;
				}
				results.push({
					filePath, requestIndex, ok: false,
					outcome: err instanceof NotesImportError ? err.outcome : "failed",
					...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}