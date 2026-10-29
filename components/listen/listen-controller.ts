/**
 * THE LISTEN PLAYER (listen wave, 2026-10-26): one audio element, one
 * queue, no React. The provider (listen.tsx) subscribes through
 * useSyncExternalStore; everything async here is fenced by a SESSION
 * number, so a fetch that lands after a stop/restart can never play.
 *
 * Two queue shapes:
 * - "from": read from a block onward through its root (owner ruling:
 *   read-from-here, the Speechify model) — the next block is found in the
 *   live DOM at each advance, so blocks that streamed in meanwhile count.
 *   With readQuestion on, a read from the transcript continues into the
 *   dock (speech-dom adjacentAcross). FOLLOW MODE while a turn is live
 *   (setLive): only finished transcript blocks are read — one is finished
 *   once a block follows it, or the turn ends — and reading that catches
 *   up waits ("waiting") instead of stopping — as does starting on a block
 *   still being written, until it's finished;
 * - "list": exactly these blocks (Compare: your answer, then the correct
 *   answer).
 *
 * AUTOPLAY (Settings → TTS): armAutoplay, called in the gesture that
 * starts a turn, unlocks the audio and marks the transcript; the reply's
 * first finished block that isn't the learner's own row starts a "from"
 * read — unless something is already reading or dictation is live.
 * Every "from" read passes over briefs (LISTEN_ASIDE_ATTR) except the one
 * it started in.
 *
 * Each block is one POST /api/tts/openai; the next block's audio is fetched while
 * the current one plays, so only the first block waits.
 */

import { isDictationActive } from "@/components/dictation-state";
import {
	LISTEN_ASIDE_ATTR,
	LISTEN_ENTER_DOCK_EVENT,
	LISTEN_ROOT_ATTR,
	LISTEN_YOURS_ATTR,
	adjacentAcross,
	adjacentBlock,
	blockLabel,
	blocksIn,
	dockRoot,
	rootOf,
	speechParts,
} from "./speech-dom";

/** "waiting": follow mode caught up with a live turn. */
export type ListenStatus = "idle" | "loading" | "playing" | "paused" | "waiting" | "error";

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

/** `aside`: the brief the read started in, the only one it reads (see
 *  LISTEN_ASIDE_ATTR); every other is passed over. */
type Queue = { kind: "from"; root: Element; aside: Element | null } | { kind: "list"; blocks: Element[] };

const asideOf = (block: Element) => block.closest(`[${LISTEN_ASIDE_ATTR}]`);

/** Where a block sat, to find it again after a re-render replaced it. */
interface Anchor {
	root: string | null;
	index: number;
	text: string;
}

/** After the turn ends, how long the dock gets to show its question. */
const SETTLE_MS = 600;
/** An armed autoplay whose turn never started goes stale. */
const ARM_TTL_MS = 60_000;

const textOf = (el: Element) => (el.textContent ?? "").trim();
const transcriptRoot = () => document.querySelector(`[${LISTEN_ROOT_ATTR}="transcript"]`);

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
	/** "Read the question" (Settings → TTS), kept current by the provider. */
	readQuestion = false;
	/** "Autoplay replies" (Settings → TTS), kept current by the provider. */
	autoplay = false;
	/** A turn is generating (follow mode), kept current by the chat. */
	private live = false;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The block being read is in the dock (the crossing event). */
	private inDock = false;
	private anchor: Anchor | null = null;
	/** Read from here on a block still being written: read it once it's
	 *  finished (found again by its root and index — its text is growing). */
	private waitFor: { block: Element; root: string | null; index: number } | null = null;
	/** Autoplay waiting for its reply: blocks past `mark` are the reply's. */
	private armed: { mark: number; sawLive: boolean; at: number } | null = null;
	private observer: MutationObserver | null = null;
	private pokeQueued = false;

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

	/** The block being read, live. A block a re-render replaced (the turn's
	 *  settle re-keying the reply; the folded practice bar's hidden Problem
	 *  swapped for the open dock's) is found again by position and text. */
	activeBlock(): Element | null {
		const block = this.snapshot.block;
		if (!block || block.isConnected) return block;
		const again = this.refind();
		if (again) this.set({ block: again });
		return again;
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
		this.start({ kind: "from", root, aside: asideOf(block) }, block);
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
		this.inDock = false;
		this.anchor = null;
		this.waitFor = null;
		if (!this.armed) this.unwatch();
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
		if (next && this.ready(next)) this.goTo(next);
		else if (this.following()) this.wait();
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

	/** Is a turn generating? The chat calls this as its status changes. */
	setLive(live: boolean) {
		if (live === this.live) return;
		this.live = live;
		clearTimeout(this.settleTimer);
		if (live) {
			if (this.armed) this.armed.sawLive = true;
			return;
		}
		// The turn ended: its last block is finished now. Give the dock a
		// moment to show the question before a caught-up read gives up.
		this.poke();
		this.settleTimer = setTimeout(() => this.poke(true), SETTLE_MS);
	}

	/** Call from the gesture that starts a turn (a send, an answer). With
	 *  autoplay on, the reply that follows is read as it arrives. */
	armAutoplay() {
		if (!this.autoplay) return;
		const transcript = transcriptRoot();
		if (!transcript) return;
		if (!this.busy()) this.unlock();
		this.armed = { mark: blocksIn(transcript).length, sawLive: this.live, at: Date.now() };
		this.watch();
	}

	/** The turn armAutoplay expected didn't start (a refused send). */
	disarmAutoplay() {
		this.armed = null;
		if (this.snapshot.status !== "waiting") this.unwatch();
	}

	// ── internals ───────────────────────────────────────────────────────────
	private ensureAudio(): HTMLAudioElement {
		if (!this.audio) {
			this.audio = new Audio();
			this.audio.preservesPitch = true;
			this.audio.addEventListener("ended", () => {
				if (this.snapshot.status !== "playing") return;
				const next = this.neighbor(1);
				if (next && this.ready(next)) this.goTo(next);
				else if (this.following()) this.wait();
				else this.stop();
			});
		}
		return this.audio;
	}

	/** Play silence on the element — inside a gesture, this unlocks it for
	 *  autoplay-restricted browsers (iOS) before the real clip arrives. */
	private unlock() {
		const a = this.ensureAudio();
		this.silence ??= silentWav();
		a.src = this.silence;
		void a.play().catch(() => {});
	}

	private start(queue: Queue, first: Element) {
		this.unlock();
		this.dropClips();
		this.queue = queue;
		if (queue.kind === "from" && !this.ready(first)) {
			const root = rootOf(first);
			this.waitFor = { block: first, root: root?.getAttribute(LISTEN_ROOT_ATTR) ?? null, index: root ? blocksIn(root).indexOf(first) : -1 };
			this.set({ block: null });
			this.wait();
			return;
		}
		this.goTo(first, true);
	}

	private busy(): boolean {
		const s = this.snapshot.status;
		return s === "loading" || s === "playing" || s === "paused" || s === "waiting";
	}

	/** Reading through a root while a turn is live: catching up waits. */
	private following(): boolean {
		return this.live && this.queue?.kind === "from";
	}

	/** Follow mode: a transcript block is finished once another follows it
	 *  (markdown streams in order) or the turn has ended. */
	private ready(block: Element): boolean {
		if (!this.live) return true;
		const root = rootOf(block);
		if (root?.getAttribute(LISTEN_ROOT_ATTR) !== "transcript") return true;
		return adjacentBlock(block, root, 1) !== null;
	}

	private wait() {
		this.session++;
		this.audio?.pause();
		this.set({ status: "waiting", label: "Waiting…", position: null, error: null });
		this.watch();
	}

	/** Watch the page while waiting or armed: new blocks may be ready. */
	private watch() {
		if (this.observer || typeof MutationObserver === "undefined") return;
		this.observer = new MutationObserver(() => {
			if (this.pokeQueued) return;
			this.pokeQueued = true;
			setTimeout(() => {
				this.pokeQueued = false;
				this.poke();
			}, 50);
		});
		this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	}

	private unwatch() {
		this.observer?.disconnect();
		this.observer = null;
	}

	/** Re-check a caught-up read and an armed autoplay. `settled`: the turn
	 *  ended a moment ago — whatever isn't here now isn't coming. */
	private poke(settled = false) {
		if (this.snapshot.status === "waiting") {
			const pending = this.waitFor;
			const next = pending ? this.waitedFor(pending) : this.neighbor(1);
			if (next && this.ready(next)) this.goTo(next, pending !== null);
			else if (settled && !this.live) this.stop();
		}
		this.tryAutoplay(settled);
		if (this.snapshot.status !== "waiting" && !this.armed) this.unwatch();
	}

	private tryAutoplay(settled: boolean) {
		const armed = this.armed;
		if (!armed) return;
		if (!this.autoplay || (!armed.sawLive && Date.now() - armed.at > ARM_TTL_MS)) {
			this.armed = null;
			return;
		}
		const transcript = transcriptRoot();
		const reply = transcript
			? blocksIn(transcript).slice(armed.mark).find((b) => !b.closest(`[${LISTEN_YOURS_ATTR}], [${LISTEN_ASIDE_ATTR}]`))
			: undefined;
		let first: Element | null = reply && this.ready(reply) ? reply : null;
		const over = settled && armed.sawLive && !this.live;
		// A reply that is only a question: read the question.
		if (!first && over && this.readQuestion) {
			const dock = dockRoot(document);
			first = dock ? (blocksIn(dock)[0] ?? null) : null;
		}
		if (!first) {
			if (over) this.armed = null;
			return;
		}
		this.armed = null;
		// Never interrupt: something reading, or dictation, skips this reply.
		if (this.busy() || isDictationActive()) return;
		const root = rootOf(first);
		if (!root) return;
		this.dropClips();
		this.queue = { kind: "from", root, aside: null };
		this.goTo(first, true);
	}

	private neighbor(dir: 1 | -1): Element | null {
		const q = this.queue;
		const at = this.activeBlock() ?? this.snapshot.block;
		if (!q || !at) return null;
		if (q.kind === "list") return q.blocks[q.blocks.indexOf(at) + dir] ?? null;
		const step = (b: Element) => (this.readQuestion ? adjacentAcross(b, q.root, dir) : adjacentBlock(b, q.root, dir));
		let next = step(at);
		while (next && asideOf(next) && asideOf(next) !== q.aside) next = step(next);
		return next;
	}

	private waitedFor(pending: NonNullable<ListenController["waitFor"]>): Element | null {
		if (pending.block.isConnected) return pending.block;
		const root = document.querySelector(`[${LISTEN_ROOT_ATTR}="${pending.root}"]`);
		return root ? (blocksIn(root)[pending.index] ?? null) : null;
	}

	private refind(): Element | null {
		const anchor = this.anchor;
		if (!anchor) return null;
		const root = document.querySelector(`[${LISTEN_ROOT_ATTR}="${anchor.root}"]`);
		if (!root) return null;
		const blocks = blocksIn(root);
		const same = blocks[anchor.index];
		if (same && textOf(same) === anchor.text) return same;
		return blocks.find((b) => textOf(b) === anchor.text) ?? null;
	}

	private position(block: Element): ListenSnapshot["position"] {
		const q = this.queue;
		return q?.kind === "list" ? { index: q.blocks.indexOf(block), total: q.blocks.length } : null;
	}

	/** `first`: the queue's first block — nothing was read before it. */
	private goTo(block: Element, first = false) {
		this.waitFor = null;
		const root = rootOf(block);
		this.anchor = { root: root?.getAttribute(LISTEN_ROOT_ATTR) ?? null, index: root ? blocksIn(root).indexOf(block) : -1, text: textOf(block) };
		const wasInDock = this.inDock;
		this.inDock = dockRoot(document)?.contains(block) ?? false;
		if (this.inDock && !wasInDock && !first) {
			// Crossing into the dock: the chat may open it (activeBlock
			// follows a section the opening re-renders).
			document.dispatchEvent(new Event(LISTEN_ENTER_DOCK_EVENT));
		}
		if (!this.armed) this.unwatch();
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
				if (next && this.ready(next)) {
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
