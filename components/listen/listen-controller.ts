/**
 * THE LISTEN PLAYER (listen wave, 2026-10-26): one audio element, one
 * queue, no React. The provider (listen.tsx) subscribes through
 * useSyncExternalStore; everything async here is fenced by a SESSION
 * number, so a fetch that lands after a stop/restart can never play.
 *
 * Two queue shapes:
 * - "from": read from a block onward through its root (owner ruling:
 *   read-from-here, the Speechify model) — the next block is found in the
 *   live DOM at each advance, so blocks that streamed in meanwhile count;
 * - "list": exactly these blocks (Compare: your answer, then the correct
 *   answer).
 *
 * Each block is one POST /api/tts/openai; the next block's audio is fetched while
 * the current one plays, so only the first block waits.
 */

import { adjacentBlock, blockLabel, rootOf, speechParts } from "./speech-dom";

export type ListenStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface ListenSnapshot {
	status: ListenStatus;
	/** The block being read (null when idle). */
	block: Element | null;
	/** The player's name for the block ("Reading", "Correct answer", …). */
	label: string;
	/** Position in a "list" queue — null while reading through a root. */
	position: { index: number; total: number } | null;
	rate: number;
	error: string | null;
}

export const LISTEN_RATES = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;
const RATE_KEY = "lh:listen-rate";

type Queue = { kind: "from"; root: Element } | { kind: "list"; blocks: Element[] };

/** A few milliseconds of silence: played inside the click that starts
 *  listening, so the element is unlocked for autoplay-restricted browsers
 *  (iOS) before the first real clip arrives asynchronously. */
function silentWav(): string {
	const samples = 400;
	const buf = new ArrayBuffer(44 + samples * 2);
	const v = new DataView(buf);
	const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
	str(0, "RIFF");
	v.setUint32(4, 36 + samples * 2, true);
	str(8, "WAVEfmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, 8000, true);
	v.setUint32(28, 16000, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	str(36, "data");
	v.setUint32(40, samples * 2, true);
	return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export class ListenController {
	private snapshot: ListenSnapshot;
	private listeners = new Set<() => void>();
	private audio: HTMLAudioElement | null = null;
	private silence: string | null = null;
	private session = 0;
	private queue: Queue | null = null;
	private clips = new Map<Element, { abort: AbortController; url: Promise<string> }>();

	constructor() {
		const stored = typeof localStorage === "undefined" ? null : Number(localStorage.getItem(RATE_KEY));
		const rate = LISTEN_RATES.find((r) => r === stored) ?? 1;
		this.snapshot = { status: "idle", block: null, label: "", position: null, rate, error: null };
	}

	// ── store protocol ──────────────────────────────────────────────────────
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = () => this.snapshot;
	private set(patch: Partial<ListenSnapshot>) {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const l of this.listeners) l();
	}

	/** The live element, for progress readers (the pill's bar). */
	get element(): HTMLAudioElement | null {
		return this.audio;
	}

	// ── commands ────────────────────────────────────────────────────────────
	/** Read `block`, then keep going through its root. Call from the click. */
	playFrom(block: Element) {
		const root = rootOf(block);
		if (!root) return;
		this.start({ kind: "from", root }, block);
	}

	/** Read exactly these blocks, in order. Call from the click. */
	playList(blocks: Element[]) {
		const first = blocks[0];
		if (first) this.start({ kind: "list", blocks }, first);
	}

	stop() {
		this.session++;
		this.queue = null;
		this.dropClips();
		if (this.audio) {
			this.audio.pause();
			this.audio.removeAttribute("src");
		}
		this.set({ status: "idle", block: null, label: "", position: null, error: null });
	}

	togglePause() {
		const a = this.audio;
		if (!a || !this.snapshot.block) return;
		if (this.snapshot.status === "paused") {
			void a.play();
			this.set({ status: "playing" });
		} else if (this.snapshot.status === "playing") {
			a.pause();
			this.set({ status: "paused" });
		}
	}

	next() {
		const next = this.neighbor(1);
		if (next) this.goTo(next);
	}

	prev() {
		const prev = this.neighbor(-1);
		if (prev) this.goTo(prev);
	}

	setRate(rate: number) {
		if (this.audio) this.audio.playbackRate = rate;
		localStorage.setItem(RATE_KEY, String(rate));
		this.set({ rate });
	}

	// ── internals ───────────────────────────────────────────────────────────
	private ensureAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio();
			this.audio.preservesPitch = true;
			this.audio.addEventListener("ended", () => {
				if (this.snapshot.status !== "playing") return;
				const next = this.neighbor(1);
				if (next) this.goTo(next);
				else this.stop();
			});
		}
		return this.audio;
	}

	private start(queue: Queue, first: Element) {
		const a = this.ensureAudio();
		// Unlock inside the gesture (see silentWav).
		this.silence ??= silentWav();
		a.src = this.silence;
		void a.play().catch(() => {});
		this.dropClips();
		this.queue = queue;
		this.goTo(first);
	}

	private neighbor(dir: 1 | -1): Element | null {
		const q = this.queue;
		const at = this.snapshot.block;
		if (!q || !at) return null;
		if (q.kind === "list") return q.blocks[q.blocks.indexOf(at) + dir] ?? null;
		return adjacentBlock(at, q.root, dir);
	}

	private position(block: Element): ListenSnapshot["position"] {
		const q = this.queue;
		return q?.kind === "list" ? { index: q.blocks.indexOf(block), total: q.blocks.length } : null;
	}

	private goTo(block: Element) {
		const session = ++this.session;
		const a = this.ensureAudio();
		a.pause();
		this.set({ status: "loading", block, label: blockLabel(block), position: this.position(block), error: null });
		// Keep only this block's clip and the one after it.
		const keep = new Set([block]);
		void this.clip(block)
			.then(async (url) => {
				if (session !== this.session) return;
				a.src = url;
				a.playbackRate = this.snapshot.rate;
				await a.play();
				if (session !== this.session) return;
				this.set({ status: "playing" });
				const next = this.neighbor(1);
				if (next) {
					keep.add(next);
					void this.clip(next).catch(() => {}); // prefetch; a failure resurfaces when reached
				}
				this.dropClips(keep);
			})
			.catch((error: unknown) => {
				if (session !== this.session) return;
				this.set({ status: "error", error: (error as Error).message || "Speech failed" });
			});
	}

	/** The object URL for a block's audio, fetched once per queue. */
	private clip(block: Element): Promise<string> {
		const cached = this.clips.get(block);
		if (cached) return cached.url;
		const abort = new AbortController();
		const url = (async () => {
			const parts = speechParts(block);
			if (parts.length === 0) throw new Error("Nothing to read here");
			const res = await fetch("/api/tts/openai", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ parts }),
				signal: abort.signal,
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(detail?.message ?? `Speech failed (${res.status})`);
			}
			return URL.createObjectURL(await res.blob());
		})();
		this.clips.set(block, { abort, url });
		return url;
	}

	private dropClips(keep: Set<Element> = new Set()) {
		for (const [block, clip] of this.clips) {
			if (keep.has(block)) continue;
			clip.abort.abort();
			void clip.url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
			this.clips.delete(block);
		}
	}
}
