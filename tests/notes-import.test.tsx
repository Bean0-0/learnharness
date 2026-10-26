import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { loadImportConcurrency, NotesImportControl, NotesImportErrors, parseNotesImportResults, postNotesImport, useNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

// Real hook/React state, isolated DOM and wholly stubbed import transport.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useNotesImport>;
let starts = 0;
let finishes = 0;
let concurrency = 3;
async function mount() {
	starts = 0;
	finishes = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		current = useNotesImport({ onStart: () => { starts++; }, onFinish: () => { finishes++; }, loadConcurrency: async () => concurrency });
		return <NotesImportErrors errors={current.errors} />;
	}
	await act(async () => { root!.render(<Harness />); });
}
async function submit(selected: File[] | null = [...files]) {
	await act(async () => { current.onImportFiles(selected as unknown as FileList | null); });
	await settle();
}
/** Wait out timer-driven stub transports until the import settles. */
async function settle() {
	for (let i = 0; i < 200 && current.importing; i++) {
		await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
	}
}
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	host = undefined;
	globalThis.fetch = originalFetch;
	concurrency = 3;
});
const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
const completed = (requestIndex = 0): NotesImportResult => ({ requestIndex, filePath: "same.md", ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

it("maps out-of-order responses by index, not duplicate basenames", () => {
	const results = [completed(1), { ...completed(0), stats: { nodes: 7 } }];
	assert.deepEqual(parseNotesImportResults({ results }, files), results);
});
for (const [name, results] of [
	["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
	["duplicate index", [completed(), completed()]],
	["missing row", [completed()]],
	["out-of-range index", [completed(), completed(2)]],
	["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
	["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
	["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
	["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
	["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
	["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
	["invalid provider", [{ ...completed(), provider: 42 }, completed(1)]],
	["invalid code", [{ ...completed(), code: 42 }, completed(1)]],
	["invalid missing", [{ ...completed(), missing: [42] }, completed(1)]],
	["invalid error", [{ ...completed(), error: 42 }, completed(1)]],
	["missing failure error", [{ ...completed(), ok: false, outcome: "failed" }, completed(1)]],
] as const) it(`malformed response (${name}) is rejected for retry`, () => {
	assert.throws(() => parseNotesImportResults({ results }, files), /Check the graph before retrying/);
});

it("POST sends only captured files, and retains config/provider details", async () => {
	const refused: NotesImportResult = { requestIndex: 0, filePath: files[1]!.name, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/graph/import"); assert.equal(init?.method, "POST");
		const sent = (init?.body as FormData).getAll("files") as File[];
		assert.equal(sent.length, 1); assert.equal(await sent[0]!.text(), "two");
		return Response.json({ results: [refused] });
	};
	assert.deepEqual(await postNotesImport([files[1]!]), [refused]);
});
for (const kind of ["network", "non-JSON", "non-2xx", "malformed"] as const) it(`${kind} response rejects rather than false success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: [] });
	};
	await assert.rejects(postNotesImport([files[0]!]));
});

for (const outcome of ["completed", "failed", "partial", "aborted", "busy"] as const) it(`${outcome} leaves only escaped raw failure text, without results or controls`, async () => {
	const file = new File(["notes"], "<script>notes.md");
	const result: NotesImportResult = { ...completed(), filePath: file.name, outcome, ok: outcome === "completed", error: "<img>synthetic failure", code: "provider_key_missing", provider: "openai", missing: ["OPENAI_API_KEY"], slots: ["cheap", "strong"] };
	globalThis.fetch = async () => Response.json({ results: [result] });
	await mount();
	await submit([file]);
	assert.equal(current.importing, false);
	assert.equal(starts, 1);
	assert.equal(finishes, 1);
	const html = host!.innerHTML;
	assert.doesNotMatch(html, /<button|<section|<ul|border|bg-card|rounded|shadow|Retry|Dismiss|Import complete|new propositions|Saved changes|Import stopped|already being imported/);
	assert.deepEqual(Object.keys(current).sort(), ["errors", "importing", "onImportFiles"], "no retained rows, Files, retry or dismiss API");
	if (outcome === "completed") {
		assert.equal(html, "");
		assert.deepEqual(current.errors, []);
	} else {
		assert.deepEqual(current.errors, [`${file.name}: ${result.error}\nprovider_key_missing — openai — OPENAI_API_KEY — cheap, strong`]);
		assert.match(html, /&lt;script&gt;notes.md: &lt;img&gt;synthetic failure/);
		assert.match(html, /provider_key_missing — openai — OPENAI_API_KEY — cheap, strong/);
		assert.match(html, /role="alert"/);
		assert.match(html, /text-xs text-red-400/);
		assert.match(html, /whitespace-pre-wrap break-words/);
		assert.doesNotMatch(html, /<script>|<img>/);
	}
});

for (const details of [
	{ code: "models_not_configured", missing: ["cheap", "strong", "vision"] },
	{ code: "provider_key_missing", provider: "openai", slots: ["cheap"] },
	{ code: "provider_key_missing" },
	{},
]) it(`keeps existing configuration detail strings (${JSON.stringify(details)})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [{ requestIndex: 0, filePath: "same.md", ok: false, outcome: "failed", error: "Existing raw error", ...details }] });
	await mount();
	await submit([files[0]!]);
	const suffix = details.code === "models_not_configured" ? "\nmodels_not_configured — cheap, strong, vision" : details.provider ? "\nprovider_key_missing — openai — cheap" : details.code ? "\nprovider_key_missing" : "";
	assert.deepEqual(current.errors, [`same.md: Existing raw error${suffix}`]);
});

it("empty error text renders nothing; multiple errors are plain independent alerts", () => {
	assert.equal(renderToStaticMarkup(<NotesImportErrors errors={[]} />), "");
	const html = renderToStaticMarkup(<NotesImportErrors errors={["one.md: failure", "two.md: failure"]} />);
	assert.equal((html.match(/role="alert"/g) ?? []).length, 2);
	assert.doesNotMatch(html, /<section|<button|border|bg-/);
});

it("mixed results show only failed files in selection order, including duplicate basenames", async () => {
	const selected = [new File(["success"], "success.md"), ...files];
	// Contents identify the duplicate basenames; the slower first duplicate
	// settles last, so ordering must come from the selection, not completion.
	const byContent: Record<string, { delay: number; result: NotesImportResult }> = {
		success: { delay: 1, result: { ...completed(), filePath: "success.md" } },
		one: { delay: 8, result: { requestIndex: 0, filePath: "same.md", ok: false, outcome: "failed", error: "first duplicate" } },
		two: { delay: 1, result: { requestIndex: 0, filePath: "same.md", ok: false, outcome: "partial", error: "second duplicate" } },
	};
	globalThis.fetch = async (_url, init) => {
		const sent = (init?.body as FormData).getAll("files") as File[];
		assert.equal(sent.length, 1);
		const row = byContent[await sent[0]!.text()]!;
		await new Promise((r) => setTimeout(r, row.delay));
		return Response.json({ results: [row.result] });
	};
	await mount();
	await submit(selected);
	assert.deepEqual(current.errors, ["same.md: first duplicate", "same.md: second duplicate"]);
	assert.doesNotMatch(host!.innerHTML, /success.md|completed|propositions/);
});

for (const kind of ["network", "non-JSON", "non-2xx", "malformed", "duplicate index"] as const) it(`${kind} hook failure is visible for every selected file, never success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: kind === "duplicate index" ? [completed(), completed()] : [] });
	};
	await mount();
	await submit();
	const message = kind === "network" ? "synthetic offline" : kind === "non-2xx" ? "Import request failed (HTTP 503): synthetic refused. Check the graph before retrying." : "Invalid import response. Check the graph before retrying.";
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: ${message}`));
	assert.equal(host!.querySelectorAll('[role="alert"]').length, 2);
	assert.equal(finishes, 1);
	assert.equal(current.importing, false);
});

it("directory picks preserve relative paths and reject attribution to the wrong same-named file", async () => {
	const nested = ["Folder/a/same.md", "Folder/b/same.md"].map((path) => {
		const file = new File(["raw"], "same.md");
		Object.defineProperty(file, "webkitRelativePath", { value: path });
		return file;
	});
	globalThis.fetch = async (_url, init) => {
		const form = init?.body as FormData;
		assert.deepEqual(form.getAll("paths"), ["Folder/a/same.md", "Folder/b/same.md"]);
		assert.deepEqual((form.getAll("files") as File[]).map((file) => file.name), ["same.md", "same.md"]);
		return Response.json({ results: nested.map((_, requestIndex) => ({
			requestIndex, filePath: ["Folder/a/same.md", "Folder/b/same.md"][requestIndex],
			outcome: "completed", ok: true, stats: { nodes: 0 },
		})) });
	};
	assert.equal((await postNotesImport(nested)).length, 2);
	assert.throws(() => parseNotesImportResults({ results: [
		{ requestIndex: 0, filePath: "Folder/b/same.md", outcome: "completed", ok: true, stats: { nodes: 0 } },
		{ requestIndex: 1, filePath: "Folder/a/same.md", outcome: "completed", ok: true, stats: { nodes: 0 } },
	] }, nested), /Invalid import response/);
});

/** One-file request → its own completed row (the per-file transport). */
const echo = (init?: RequestInit) => {
	const sent = (init?.body as FormData).getAll("files") as File[];
	assert.equal(sent.length, 1, "exactly one file per request");
	const paths = (init?.body as FormData).getAll("paths") as string[];
	return { file: sent[0]!, path: paths[0] ?? sent[0]!.name };
};
const done = (filePath: string): Response => Response.json({ results: [{ requestIndex: 0, filePath, ok: true, outcome: "completed", stats: { nodes: 0 } }] });

it("a slow file never blocks later files: N single-file requests stay in flight", async () => {
	concurrency = 2;
	const selected = Array.from({ length: 5 }, (_, i) => new File(["text"], `note-${i}.md`));
	const order: string[] = [];
	let active = 0, peak = 0;
	let releaseSlow!: () => void;
	const slow = new Promise<void>((r) => { releaseSlow = r; });
	globalThis.fetch = async (_url, init) => {
		const { path } = echo(init);
		order.push(path);
		active++; peak = Math.max(peak, active);
		try {
			if (path === "note-0.md") await slow;
			else await new Promise((r) => setTimeout(r, 1));
			return done(path);
		} finally { active--; }
	};
	await mount();
	await act(async () => { current.onImportFiles(selected as unknown as FileList); });
	for (let i = 0; i < 50 && order.length < 5; i++) {
		await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
	}
	assert.deepEqual(order, ["note-0.md", "note-1.md", "note-2.md", "note-3.md", "note-4.md"], "files 1–4 all started while file 0 was still running");
	assert.equal(current.importing, true, "import still waits on the slow file");
	releaseSlow();
	await settle();
	assert.equal(current.importing, false);
	assert.equal(peak, 2, "never more than the configured parallel subagents");
	assert.deepEqual(current.errors, []);
	assert.equal(starts, 1); assert.equal(finishes, 1);
});

it("a failed or lost response affects only its own file, is never retried, and errors keep selection order", async () => {
	const selected = Array.from({ length: 4 }, (_, i) => new File(["text"], `note-${i}.md`));
	const calls: string[] = [];
	globalThis.fetch = async (_url, init) => {
		const { path } = echo(init);
		calls.push(path);
		// Finish out of order so error order must come from selection order.
		await new Promise((r) => setTimeout(r, path === "note-1.md" ? 6 : 1));
		if (path === "note-1.md") return new Response("invalid response");
		if (path === "note-3.md") throw new Error("synthetic offline");
		return done(path);
	};
	await mount(); await submit(selected);
	assert.deepEqual([...calls].sort(), ["note-0.md", "note-1.md", "note-2.md", "note-3.md"], "each file sent exactly once");
	assert.deepEqual(current.errors, [
		"note-1.md: Invalid import response. Check the graph before retrying.",
		"note-3.md: synthetic offline",
	]);
});

it("concurrency of 1 imports strictly one file at a time", async () => {
	concurrency = 1;
	let active = 0, peak = 0;
	globalThis.fetch = async (_url, init) => {
		const { path } = echo(init);
		active++; peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 1));
		active--;
		return done(path);
	};
	await mount(); await submit(Array.from({ length: 3 }, (_, i) => new File(["t"], `n${i}.md`)));
	assert.equal(peak, 1);
	assert.deepEqual(current.errors, []);
});

it("loadImportConcurrency reads the resolved setting and falls back to 3", async () => {
	globalThis.fetch = async (url) => {
		assert.equal(url, "/api/settings");
		return Response.json({ settings: { version: 1, agent: { extractionConcurrency: 5 } } });
	};
	assert.equal(await loadImportConcurrency(), 5);
	globalThis.fetch = async () => Response.json({ settings: null });
	assert.equal(await loadImportConcurrency(), 3);
	globalThis.fetch = async () => { throw new Error("offline"); };
	assert.equal(await loadImportConcurrency(), 3);
	globalThis.fetch = async () => Response.json({ error: "nope" }, { status: 500 });
	assert.equal(await loadImportConcurrency(), 3);
});

it("skips oversized and unsupported files while importing eligible siblings", async () => {
	const selected = [new File([new Uint8Array(7 * 1024 * 1024 + 1)], "huge.md"), new File(["binary"], "photo.png"), new File(["text"], "ok.txt")];
	let requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		assert.deepEqual((init?.body as FormData).getAll("paths"), ["ok.txt"]);
		return Response.json({ results: [{ requestIndex: 0, filePath: "ok.txt", ok: true, outcome: "completed", stats: { nodes: 0 } }] });
	};
	await mount(); await submit(selected);
	assert.equal(requests, 1);
	assert.match(current.errors[0]!, /huge.md: File exceeds 7 MiB import limit/);
	assert.match(current.errors[1]!, /photo.png: Unsupported format/);
});

it("folder selection silently ignores .DS_Store while importing valid notes", async () => {
	const metadata = new File(["metadata"], ".DS_Store");
	Object.defineProperty(metadata, "webkitRelativePath", { value: "STAT 211 notes/.DS_Store" });
	const note = new File(["fixture"], "index.md");
	Object.defineProperty(note, "webkitRelativePath", { value: "STAT 211 notes/index.md" });
	let requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		assert.deepEqual((init?.body as FormData).getAll("paths"), ["STAT 211 notes/index.md"]);
		return Response.json({ results: [{ requestIndex: 0, filePath: "STAT 211 notes/index.md", ok: true, outcome: "completed", stats: { nodes: 0 } }] });
	};
	await mount(); await submit([metadata, note]);
	assert.equal(requests, 1);
	assert.deepEqual(current.errors, []);
});

it("one import button exposes Files and Folder native selectors", () => {
	const html = renderToStaticMarkup(<NotesImportControl importing={false} onImportFiles={() => {}} />);
	assert.equal((html.match(/type="file"/g) ?? []).length, 2);
	assert.match(html, /webkitdirectory=""/);
	assert.match(html, /accept="\.md,\.markdown,\.txt"/);
	assert.equal((html.match(/data-testid="import-notes"/g) ?? []).length, 1);
});

it("single import button opens Files / Folder choices and opens folder picker", async () => {
	await mount();
	await act(async () => { root!.render(<NotesImportControl importing={false} onImportFiles={() => {}} />); });
	const inputs = host!.querySelectorAll<HTMLInputElement>('input[type="file"]');
	assert.equal(inputs.length, 2);
	let picked = "";
	inputs[0]!.click = () => { picked = "files"; };
	inputs[1]!.click = () => { picked = "folder"; };
	await act(async () => { host!.querySelector<HTMLButtonElement>('[data-testid="import-notes"]')!.click(); });
	const choices = host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
	assert.deepEqual(Array.from(choices, (button) => button.textContent), ["Files", "Folder"]);
	await act(async () => { choices[1]!.click(); });
	assert.equal(picked, "folder");
	assert.equal(host!.querySelector('[role="menu"]'), null);
});

it("actual attempts clear errors immediately, guard synchronous reentry, preserve callbacks and allow same-file reimport", async () => {
	// Two selected files → two single-file requests per attempt.
	let requests = 0;
	const pending: ((response: Response) => void)[] = [];
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	await submit();
	assert.equal(current.errors.length, 2);
	await submit(null);
	await submit([]);
	assert.equal(current.errors.length, 2, "cancel/empty selection is not an attempt");
	assert.equal(requests, 2);
	globalThis.fetch = async () => { requests++; return new Promise<Response>((done) => { pending.push(done); }); };
	await act(async () => {
		const staleHandler = current.onImportFiles;
		staleHandler(files as unknown as FileList);
		staleHandler(files as unknown as FileList);
	});
	assert.equal(requests, 4, "ref guard rejects even same-tick reentry before React rerenders");
	assert.equal(current.importing, true);
	assert.deepEqual(current.errors, []);
	assert.equal(host!.innerHTML, "");
	assert.equal(starts, 2);
	assert.equal(finishes, 1, "finish waits for every POST");
	await submit();
	assert.equal(requests, 4, "pending attempts do not submit");
	await act(async () => { for (const done of pending) done(Response.json({ results: [completed()] })); });
	assert.equal(current.importing, false);
	assert.deepEqual(current.errors, []);
	assert.equal(finishes, 2);
	globalThis.fetch = async () => { requests++; return Response.json({ results: [completed()] }); };
	await submit();
	assert.equal(requests, 6, "same File objects can be submitted again after settlement");
	assert.equal(starts, 3);
	assert.equal(finishes, 3);
	assert.equal(host!.innerHTML, "");
});
