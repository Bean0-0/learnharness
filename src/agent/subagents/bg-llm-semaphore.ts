/**
 * THE SHARED BACKGROUND-LLM SEMAPHORE (owner ruling, 2026-09-29): ONE
 * process-wide permit pool for ALL background LLM jobs — extraction
 * chunks are the only holders. No subsystem gets a private lane past the
 * provider-facing stance.
 *
 * PERMIT COUNT (owner, 2026-10-26): the user's "Parallel subagents"
 * setting (agent.extractionConcurrency, 1–8, default 3 — the historical
 * constant), read LIVE by the caller-supplied getter.
 *
 * FIFO; abort-aware (a queued caller that aborts marks its ticket dead —
 * admission skips it and admits the next waiter).
 *
 * ONE-SIDED COUNTING (the double-count deadlock lesson, extraction
 * 2026-09-28): fresh takers increment `active` themselves; a queued
 * ticket is counted by its ADMITTER, never by itself — counting both
 * sides is how a semaphore slowly deadlocks with an empty queue.
 *
 * The audit side needs no slot: audits serialize behind their own global
 * lock, so by the time a job releases its permit the audit queue is the
 * only remaining throttle.
 */

/** The historical constant — now only the fallback when a caller passes no
 *  live count (the user setting agent.extractionConcurrency, 2026-10-26). */
const DEFAULT_PERMIT_COUNT = 3;

export interface LlmSlots {
	active: number;
	queue: { resolve: () => void; dead: boolean }[];
}

interface LhLlmSemaphoreGlobal {
	__lhLlmSlots?: LlmSlots;
}

/** The process's single permit pool (globalThis — Next dev compiles each
 *  route entry as its own module instance; a module-level object would
 *  split the pool per route. One process, one truth). */
export function bgLlmSlots(): LlmSlots {
	const g = globalThis as typeof globalThis & LhLlmSemaphoreGlobal;
	return (g.__lhLlmSlots ??= { active: 0, queue: [] });
}

/** Admit live queued tickets FIFO while the pool is under `limit`. The
 *  ADMITTER increments `active` on the inheritor's behalf (the inheritor
 *  never counts itself) — one side counts, so the pool cannot drift. */
function admit(slots: LlmSlots, limit: number): void {
	while (slots.active < limit) {
		const next = slots.queue.shift();
		if (!next) return;
		if (next.dead) continue; // its job already left through the abort path
		slots.active++;
		next.resolve();
	}
}

/** Run `critical` under one permit of the shared pool. `permits` is read
 *  LIVE at acquire and release (the user's parallel-subagents setting):
 *  raising it admits waiters on the next acquire/release; lowering it never
 *  interrupts running jobs — new ones simply wait until active < permits.
 *  `signal` kills a queued ticket: it marks itself dead and rejects
 *  AbortError — admission skips it. */
export async function withBgLlmSlot<T>(
	signal: AbortSignal | undefined,
	critical: () => Promise<T>,
	permits: () => number = () => DEFAULT_PERMIT_COUNT,
): Promise<T> {
	const slots = bgLlmSlots();
	const limit = () => Math.max(1, Math.floor(permits()) || DEFAULT_PERMIT_COUNT);
	// Earlier waiters first (FIFO), then a fresh take if room remains.
	admit(slots, limit());
	if (slots.active < limit() && slots.queue.length === 0) {
		slots.active++;
	} else {
		await new Promise<void>((resolve, reject) => {
			const ticket: { resolve: () => void; dead: boolean } = { resolve, dead: false };
			slots.queue.push(ticket);
			if (!signal) return;
			const die = () => {
				ticket.dead = true; // admission must skip us
				const err = new Error("background LLM job aborted while queued for a permit");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) die();
			else signal.addEventListener("abort", die, { once: true });
		});
	}
	try {
		return await critical();
	} finally {
		slots.active--;
		admit(slots, limit());
	}
}
