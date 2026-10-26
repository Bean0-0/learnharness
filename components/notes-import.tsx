"use client";

import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BATCH_BYTES, MAX_IMPORT_BATCH_FILES, validNotesPath } from "@/lib/notes-import-limits";

export function notesPath(file: File): string {
	return file.webkitRelativePath || file.name;
}

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}. Check the graph before retrying.`);
	}
	return parseNotesImportResults(body, files);
}

/** Only error text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [errors, setErrors] = useState<string[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (files: File[]) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		setErrors([]);
		try {
			callbacks.onStart?.();
			const failures = new Map<number, string>();
			let batch: { file: File; index: number }[] = [];
			let bytes = 0;
			const flush = async () => {
				if (!batch.length) return;
				const pending = batch;
				batch = []; bytes = 0;
				try {
					const results = await postNotesImport(pending.map(({ file }) => file));
					for (const result of results) {
						if (result.ok) continue;
						const index = pending[result.requestIndex]!.index;
						failures.set(index, `${result.filePath}: ${result.error}${result.code ? `\n${result.code}${result.provider ? ` — ${result.provider}` : ""}${result.missing?.length ? ` — ${result.missing.join(", ")}` : ""}${result.slots?.length ? ` — ${result.slots.join(", ")}` : ""}` : ""}`);
					}
				} catch (error) {
					// Never auto-retry: an invalid/lost response may follow a committed merge.
					const message = error instanceof Error ? error.message : String(error);
					for (const { file, index } of pending) failures.set(index, `${notesPath(file)}: ${message}`);
				}
			};
			for (const [index, file] of files.entries()) {
				const path = notesPath(file);
				if (file.webkitRelativePath && file.name === ".DS_Store") continue;
				if (!IMPORT_EXTENSIONS.test(path) || !validNotesPath(path, file.name)) {
					failures.set(index, `${path}: Unsupported format or unsafe relative path.`);
					continue;
				}
				if (file.size > MAX_IMPORT_BATCH_BYTES) {
					failures.set(index, `${path}: File exceeds 7 MiB import limit.`);
					continue;
				}
				if (batch.length >= MAX_IMPORT_BATCH_FILES || bytes + file.size > MAX_IMPORT_BATCH_BYTES) await flush();
				batch.push({ file, index }); bytes += file.size;
			}
			await flush();
			setErrors([...failures].sort(([a], [b]) => a - b).map(([, message]) => message));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		errors, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
	};
}

/** Shared picker for graph and minimal home: one entry point, two native selectors. */
export function NotesImportControl({ importing, onImportFiles }: {
	importing: boolean;
	onImportFiles: (files: FileList | null) => void;
}) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	return (
		<div className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept=".md,.markdown,.txt,.html,.htm" className="hidden"
				onChange={(event) => { onImportFiles(event.target.files); event.target.value = ""; }} />
			<input ref={folderRef} type="file" multiple accept=".md,.markdown,.txt,.html,.htm"
				{...{ webkitdirectory: "", directory: "" }} className="hidden"
				onChange={(event) => { onImportFiles(event.target.files); event.target.value = ""; }} />
			<Hint label="Import notes into the graph" side="bottom">
				<button type="button" disabled={importing} onClick={() => setOpen(!open)}
					aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50">
					<UploadIcon className="size-3" />
					{importing ? "Importing…" : "Import notes…"}
				</button>
			</Hint>
			{open && !importing && <div role="menu" aria-label="Import notes" className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-lg border bg-card p-1 shadow-lg">
				{([ ["Files", filesRef], ["Folder", folderRef] ] as const).map(([label, input]) =>
					<button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
			</div>}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
	))}</>;
}
