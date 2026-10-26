"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { UploadIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { formatMiB, IMPORT_EXTENSIONS, MAX_IMPORT_FILE_BYTES, validNotesPath } from "@/lib/notes-import-limits";
import { EXTRACTION_CONCURRENCY_DEFAULT, resolveSettings, type UserSettings } from "@/src/core";

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

/** The resolved "Parallel subagents" setting (agent.extractionConcurrency),
 *  read fresh per import. Any failure falls back to the default: the
 *  server-side pool enforces the real cap either way. */
export async function loadImportConcurrency(): Promise<number> {
	try {
		const response = await fetch("/api/settings");
		if (!response.ok) return EXTRACTION_CONCURRENCY_DEFAULT;
		const body = await response.json() as { settings?: UserSettings | null };
		return resolveSettings(body?.settings ?? null).agent.extractionConcurrency;
	} catch {
		return EXTRACTION_CONCURRENCY_DEFAULT;
	}
}

function failureMessage(r: NotesImportResult): string {
	const details = [r.provider, r.missing?.join(", "), r.slots?.join(", ")].filter(Boolean);
	return `${r.filePath}: ${r.error}${r.code ? `\n${[r.code, ...details].join(" — ")}` : ""}`;
}

/** Only error text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: {
	onStart?: () => void;
	onFinish?: () => void;
	/** Test seam; production reads the user's Parallel subagents setting. */
	loadConcurrency?: () => Promise<number>;
} = {}) {
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
			const queue: { file: File; index: number }[] = [];
			for (const [index, file] of files.entries()) {
				const path = notesPath(file);
				if (file.webkitRelativePath && file.name === ".DS_Store") continue;
				if (!IMPORT_EXTENSIONS.test(path) || !validNotesPath(path, file.name)) {
					failures.set(index, `${path}: Unsupported format or unsafe relative path.`);
					continue;
				}
				if (file.size > MAX_IMPORT_FILE_BYTES) {
					failures.set(index, `${path}: File exceeds ${formatMiB(MAX_IMPORT_FILE_BYTES)} import limit.`);
					continue;
				}
				queue.push({ file, index });
			}
			// CONTINUOUS QUEUE (owner, 2026-10-26): one file per request, N in
			// flight — the next file starts the moment any file finishes, so a
			// slow file never idles the other workers. A lost response is
			// ambiguous for only its own file and is never retried.
			const width = Math.max(1, await (callbacks.loadConcurrency ?? loadImportConcurrency)());
			const worker = async () => {
				for (let next = queue.shift(); next; next = queue.shift()) {
					const { file, index } = next;
					try {
						// The parser guarantees exactly one row for one file.
						const [result] = await postNotesImport([file]);
						if (!result!.ok) failures.set(index, failureMessage(result!));
					} catch (error) {
						// Never auto-retry: an invalid/lost response may follow a committed merge.
						failures.set(index, `${notesPath(file)}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
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

/** Shared picker for graph and minimal home: one button, a Files / Folder
 *  menu, two native pickers. */
export function NotesImportControl({ importing, onImportFiles }: {
	importing: boolean;
	onImportFiles: (files: FileList | null) => void;
}) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = ""; // allow re-picking the same selection
	};
	const choices = [["Files", filesRef], ["Folder", folderRef]] as const;
	return (
		<div
			className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
		>
			<input ref={filesRef} type="file" multiple accept=".md,.markdown,.txt" className="hidden" onChange={onChange} />
			{/* webkitdirectory is not in React's input typings; accept does not
			    filter folder contents, so the hook skips unsupported files. */}
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label="Import notes into the graph" side="bottom">
				<button
					type="button"
					disabled={importing}
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					aria-haspopup="menu"
					data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
					<UploadIcon className="size-3" />
					{importing ? "Importing…" : "Import notes…"}
				</button>
			</Hint>
			{open && !importing && (
				<div role="menu" aria-label="Import notes" className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-lg border bg-card p-1 shadow-lg">
					{choices.map(([label, input]) => (
						<button
							key={label}
							type="button"
							role="menuitem"
							className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
							onClick={() => { setOpen(false); input.current?.click(); }}
						>
							{label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
	))}</>;
}
