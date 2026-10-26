/**
 * Parallel subagents (agent.extractionConcurrency): the user-facing cap on
 * the shared background-LLM pool. Covers read-side sanitize (clamp),
 * resolution (default 3), strict write-side parse, and the semaphore
 * honoring a live permit count.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EXTRACTION_CONCURRENCY_DEFAULT,
	EXTRACTION_CONCURRENCY_MAX,
	EXTRACTION_CONCURRENCY_MIN,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { bgLlmSlots, withBgLlmSlot } from "../src/agent/subagents/bg-llm-semaphore.ts";

describe("extractionConcurrency setting", () => {
	it("defaults to 3 within a 1–8 range", () => {
		assert.deepEqual([EXTRACTION_CONCURRENCY_MIN, EXTRACTION_CONCURRENCY_DEFAULT, EXTRACTION_CONCURRENCY_MAX], [1, 3, 8]);
		assert.equal(resolveSettings(null).agent.extractionConcurrency, 3);
		assert.equal(resolveSettings({ version: 1, agent: { extractionConcurrency: 6 } }).agent.extractionConcurrency, 6);
	});

	it("read side clamps finite numbers and drops junk", () => {
		const read = (v: unknown) => sanitizeUserSettings({ version: 1, agent: { extractionConcurrency: v } })?.agent?.extractionConcurrency;
		assert.equal(read(20), 8);
		assert.equal(read(0), 1);
		assert.equal(read(-4), 1);
		assert.equal(read(2.7), 2);
		assert.equal(read(5), 5);
		assert.equal(read("5"), undefined);
		assert.equal(read(Number.NaN), undefined);
	});

	it("write side accepts integers 1–8 and rejects everything else", () => {
		const ok = parseAgentSettingsBody({ extractionConcurrency: 4 });
		assert.ok(ok.ok);
		assert.equal(ok.ok && ok.settings.extractionConcurrency, 4);
		for (const bad of [0, 9, 2.5, "3", null]) {
			const r = parseAgentSettingsBody({ extractionConcurrency: bad });
			assert.equal(r.ok, false, String(bad));
			assert.match(!r.ok ? r.error : "", /extractionConcurrency must be an integer from 1 to 8/);
		}
		const absent = parseAgentSettingsBody({});
		assert.ok(absent.ok && absent.settings.extractionConcurrency === undefined);
	});
});

describe("shared background-LLM semaphore with a live permit count", () => {
	const gate = () => {
		let open!: () => void;
		const p = new Promise<void>((r) => { open = r; });
		return { p, open };
	};
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("runs at most `permits()` jobs and admits queued jobs when the count rises", async () => {
		let permits = 1;
		let active = 0, peak = 0;
		const gates = Array.from({ length: 4 }, gate);
		const jobs = gates.map((g) => withBgLlmSlot(undefined, async () => {
			active++; peak = Math.max(peak, active);
			await g.p; active--;
		}, () => permits));
		await tick();
		assert.equal(active, 1, "one permit");
		permits = 3;
		// Any later acquire attempt (or release) re-pumps the queue.
		const probe = withBgLlmSlot(undefined, async () => {}, () => permits);
		await tick();
		assert.equal(active, 3, "raised count admits queued jobs FIFO");
		for (const g of gates) g.open();
		await Promise.all([...jobs, probe]);
		assert.equal(peak, 3);
		assert.equal(bgLlmSlots().active, 0);
		assert.equal(bgLlmSlots().queue.length, 0);
	});

	it("lowering the count never interrupts running jobs; new ones wait until below it", async () => {
		let permits = 3;
		let active = 0;
		const gates = Array.from({ length: 4 }, gate);
		const started: number[] = [];
		const jobs = gates.map((g, i) => withBgLlmSlot(undefined, async () => {
			active++; started.push(i);
			await g.p; active--;
		}, () => permits));
		await tick();
		assert.deepEqual(started, [0, 1, 2]);
		permits = 1;
		gates[0]!.open(); await tick();
		assert.deepEqual(started, [0, 1, 2], "2 still running ≥ 1 permit: job 3 waits");
		gates[1]!.open(); await tick();
		assert.deepEqual(started, [0, 1, 2]);
		gates[2]!.open(); await tick();
		assert.deepEqual(started, [0, 1, 2, 3], "admitted once active < permits");
		gates[3]!.open();
		await Promise.all(jobs);
		assert.equal(bgLlmSlots().active, 0);
	});

	it("aborted queued tickets are skipped and never leak a permit", async () => {
		const g = gate();
		const running = withBgLlmSlot(undefined, async () => { await g.p; }, () => 1);
		const controller = new AbortController();
		const queued = withBgLlmSlot(controller.signal, async () => { throw new Error("must not run"); }, () => 1);
		controller.abort();
		await assert.rejects(queued, { name: "AbortError" });
		g.open(); await running;
		assert.equal(bgLlmSlots().active, 0);
		await withBgLlmSlot(undefined, async () => {}, () => 1);
		assert.equal(bgLlmSlots().active, 0);
	});
});
