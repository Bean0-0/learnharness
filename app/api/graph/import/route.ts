/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", optional matching "paths" for folder-relative identity;
 * accepts Markdown and plain text); the pipeline mints a
 * deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The client sends one file per request; model calls across all
 * requests are bounded by the shared background-LLM pool. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { extraction, NotesImportError } from "@/src/server";
import {
	formatMiB,
	IMPORT_EXTENSIONS,
	MAX_IMPORT_FILE_BYTES,
	MAX_IMPORT_FILES,
	MAX_IMPORT_REQUEST_BYTES,
	validNotesPath,
} from "@/lib/notes-import-limits";
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
	const tooLarge = () => Response.json({ error: `Import request exceeds ${formatMiB(MAX_IMPORT_REQUEST_BYTES)} limit` }, { status: 413 });
	if (Number(request.headers.get("content-length")) > MAX_IMPORT_REQUEST_BYTES) return tooLarge();
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_IMPORT_REQUEST_BYTES) { await reader.cancel(); return tooLarge(); }
		chunks.push(value);
	}
	let form: FormData;
	try {
		form = await new Request(request.url, {
			method: "POST",
			headers: { "content-type": request.headers.get("content-type") ?? "" },
			body: new Blob(chunks),
		}).formData();
	} catch {
		return Response.json({ error: "Invalid multipart import request" }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}
	if (files.length > MAX_IMPORT_FILES) {
		return Response.json({ error: `Import request exceeds ${MAX_IMPORT_FILES} files` }, { status: 400 });
	}
	// Optional "paths" carry folder-relative identity, one per file.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? (suppliedPaths as string[]) : files.map((file) => file.name);
	if (files.some((file, i) => file.size > MAX_IMPORT_FILE_BYTES || !validNotesPath(paths[i]!, file.name) || !IMPORT_EXTENSIONS.test(paths[i]!))) {
		return Response.json({ error: "Import contains an oversized file, unsupported format or unsafe path" }, { status: 400 });
	}

	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, filePath: paths[requestIndex]!, requestIndex }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, filePath, requestIndex } = next;
			try {
				const text = await file.text();
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