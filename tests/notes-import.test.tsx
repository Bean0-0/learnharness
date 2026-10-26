import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NotesImportControl, NotesImportErrors, parseNotesImportResults, postNotesImport, useNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

// Real hook/React state, isolated DOM and wholly stubbed import transport.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useNotesImport>;
let starts = 0;
let finishes = 0;
async function mount() {
	starts = 0;
	finishes = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		current = useNotesImport({ onStart: () => { starts++; }, onFinish: () => { finishes++; } });
		return <NotesImportErrors errors={current.errors} />;
	}
	await act(async () => { root!.render(<Harness />); });
}
async function submit(selected: File[] | null = [...files]) {
	await act(async () => { current.onImportFiles(selected as unknown as FileList | null); });
}
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	host = undefined;
	globalThis.fetch = originalFetch;
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

it("mixed out-of-order results show only failed files in selection order, including duplicate basenames", async () => {
	const selected = [new File(["success"], "success.md"), ...files];
	const results: NotesImportResult[] = [
		{ requestIndex: 2, filePath: "same.md", ok: false, outcome: "partial", error: "second duplicate" },
		{ ...completed(), filePath: "success.md" },
		{ requestIndex: 1, filePath: "same.md", ok: false, outcome: "failed", error: "first duplicate" },
	];
	globalThis.fetch = async () => Response.json({ results });
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
	const nested = ["Folder/a/same.html", "Folder/b/same.html"].map((path) => {
		const file = new File(["<p>raw</p>"], "same.html");
		Object.defineProperty(file, "webkitRelativePath", { value: path });
		return file;
	});
	globalThis.fetch = async (_url, init) => {
		const form = init?.body as FormData;
		assert.deepEqual(form.getAll("paths"), ["Folder/a/same.html", "Folder/b/same.html"]);
		assert.deepEqual((form.getAll("files") as File[]).map((file) => file.name), ["same.html", "same.html"]);
		return Response.json({ results: nested.map((_, requestIndex) => ({
			requestIndex, filePath: ["Folder/a/same.html", "Folder/b/same.html"][requestIndex],
			outcome: "completed", ok: true, stats: { nodes: 0 },
		})) });
	};
	assert.equal((await postNotesImport(nested)).length, 2);
	assert.throws(() => parseNotesImportResults({ results: [
		{ requestIndex: 0, filePath: "Folder/b/same.html", outcome: "completed", ok: true, stats: { nodes: 0 } },
		{ requestIndex: 1, filePath: "Folder/a/same.html", outcome: "completed", ok: true, stats: { nodes: 0 } },
	] }, nested), /Invalid import response/);
});

it("seven files send sequential three-file batches; failed batch does not retry or hide later successes", async () => {
	const selected = Array.from({ length: 7 }, (_, i) => new File(["text"], `note-${i}.md`));
	const batches: string[][] = [];
	let active = 0, peak = 0;
	globalThis.fetch = async (_url, init) => {
		active++; peak = Math.max(peak, active);
		try {
			const names = ((init?.body as FormData).getAll("files") as File[]).map((file) => file.name);
			batches.push(names);
			if (batches.length === 2) return new Response("invalid response");
			return Response.json({ results: names.map((filePath, requestIndex) => ({
				requestIndex, filePath, ok: true, outcome: "completed", stats: { nodes: 0 },
			})) });
		} finally { active--; }
	};
	await mount(); await submit(selected);
	assert.equal(peak, 1);
	assert.deepEqual(batches, [["note-0.md", "note-1.md", "note-2.md"], ["note-3.md", "note-4.md", "note-5.md"], ["note-6.md"]]);
	assert.deepEqual(current.errors, [3, 4, 5].map((i) => `note-${i}.md: Invalid import response. Check the graph before retrying.`));
	assert.equal(starts, 1); assert.equal(finishes, 1);
});

it("splits uploads by bytes as well as count", async () => {
	const selected = Array.from({ length: 3 }, (_, i) => new File([new Uint8Array(3 * 1024 * 1024)], `large-${i}.md`));
	const batches: number[] = [];
	globalThis.fetch = async (_url, init) => {
		const sent = (init?.body as FormData).getAll("files") as File[];
		batches.push(sent.length);
		return Response.json({ results: sent.map((file, requestIndex) => ({
			requestIndex, filePath: file.name, ok: true, outcome: "completed", stats: { nodes: 0 },
		})) });
	};
	await mount(); await submit(selected);
	assert.deepEqual(batches, [2, 1]);
	assert.deepEqual(current.errors, []);
});

it("skips oversized and unsupported files while importing eligible siblings", async () => {
	const selected = [new File([new Uint8Array(7 * 1024 * 1024 + 1)], "huge.md"), new File(["binary"], "photo.png"), new File(["text"], "ok.htm")];
	let requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		assert.deepEqual((init?.body as FormData).getAll("paths"), ["ok.htm"]);
		return Response.json({ results: [{ requestIndex: 0, filePath: "ok.htm", ok: true, outcome: "completed", stats: { nodes: 0 } }] });
	};
	await mount(); await submit(selected);
	assert.equal(requests, 1);
	assert.match(current.errors[0]!, /huge.md: File exceeds 7 MiB import limit/);
	assert.match(current.errors[1]!, /photo.png: Unsupported format/);
});

it("folder selection silently ignores .DS_Store while importing valid notes", async () => {
	const metadata = new File(["metadata"], ".DS_Store");
	Object.defineProperty(metadata, "webkitRelativePath", { value: "STAT 211 notes/.DS_Store" });
	const note = new File(["<p>fixture</p>"], "index.html");
	Object.defineProperty(note, "webkitRelativePath", { value: "STAT 211 notes/index.html" });
	let requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		assert.deepEqual((init?.body as FormData).getAll("paths"), ["STAT 211 notes/index.html"]);
		return Response.json({ results: [{ requestIndex: 0, filePath: "STAT 211 notes/index.html", ok: true, outcome: "completed", stats: { nodes: 0 } }] });
	};
	await mount(); await submit([metadata, note]);
	assert.equal(requests, 1);
	assert.deepEqual(current.errors, []);
});

it("one import button exposes Files and Folder native selectors", () => {
	const html = renderToStaticMarkup(<NotesImportControl importing={false} onImportFiles={() => {}} />);
	assert.equal((html.match(/type="file"/g) ?? []).length, 2);
	assert.match(html, /webkitdirectory=""/);
	assert.match(html, /\.html,\.htm/);
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
	let requests = 0;
	let resolve!: (response: Response) => void;
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	await submit();
	assert.equal(current.errors.length, 2);
	await submit(null);
	await submit([]);
	assert.equal(current.errors.length, 2, "cancel/empty selection is not an attempt");
	assert.equal(requests, 1);
	globalThis.fetch = async () => { requests++; return new Promise<Response>((done) => { resolve = done; }); };
	await act(async () => {
		const staleHandler = current.onImportFiles;
		staleHandler(files as unknown as FileList);
		staleHandler(files as unknown as FileList);
	});
	assert.equal(requests, 2, "ref guard rejects even same-tick reentry before React rerenders");
	assert.equal(current.importing, true);
	assert.deepEqual(current.errors, []);
	assert.equal(host!.innerHTML, "");
	assert.equal(starts, 2);
	assert.equal(finishes, 1, "finish waits for the POST");
	await submit();
	assert.equal(requests, 2, "pending attempts do not submit");
	await act(async () => { resolve(Response.json({ results: [completed(1), completed()] })); });
	assert.equal(current.importing, false);
	assert.deepEqual(current.errors, []);
	assert.equal(finishes, 2);
	globalThis.fetch = async () => { requests++; return Response.json({ results: [completed(), completed(1)] }); };
	await submit();
	assert.equal(requests, 3, "same File objects can be submitted again after settlement");
	assert.equal(starts, 3);
	assert.equal(finishes, 3);
	assert.equal(host!.innerHTML, "");
});
