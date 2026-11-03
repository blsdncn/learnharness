/**
 * Listening controller: one audio element, one
 * queue, no React. The provider (listen.tsx) subscribes through
 * useSyncExternalStore; everything async here is fenced by a SESSION
 * number, so a fetch that lands after a stop/restart can never play.
 *
 * Two queue shapes:
 * - "from": read from a block onward through its root. The next block is
 *   found in the live DOM at each advance, so newly streamed blocks count.
 *   With readQuestion on, a read from the transcript continues into the
 *   dock (speech-dom adjacentAcross) — the dock is never opened for it.
 *   FOLLOW MODE while a turn is live (setLive): only finished transcript
 *   blocks are read — one is finished once a block follows it, or the
 *   turn ends — and reading that catches up waits ("waiting") instead of
 *   stopping — as does starting on a block still being written, until
 *   it's finished, and crossing into the dock, until the turn has ended
 *   (prose the reply appends meanwhile comes first);
 * - "list": exactly these blocks (Compare: your answer, then the correct
 *   answer).
 *
 * AUTOPLAY (Settings → TTS): armAutoplay, called in the gesture that
 * starts a turn, unlocks the audio and marks the transcript; the reply's
 * first finished block starts a "from" read — unless something is already
 * reading or dictation is live. The reply is what the transcript gained
 * since: new rows, and new sources (a teacher text part, a tool call, the
 * learner's answer — speech-dom LISTEN_SOURCE_ATTR) inside an existing
 * message group, which the reply to a dock answer continues. An
 * autoplayed read passes over what autoplayAllowed excludes (the
 * learner's own rows going forward, answer records but an opted-in model
 * answer, the transcript copy of the docked problem), and reads a docked
 * problem only with the reply that posed it. Stop cancels an armed autoplay too.
 * Automatic advancement passes over briefs (LISTEN_ASIDE_ATTR) except the
 * one the read started in. Previous and Next can select any readable block.
 *
 * Each block is one POST /api/tts/openai; the next block's audio is fetched while
 * the current one plays, so only the first block waits.
 */

import { isDictationActive } from "@/components/dictation-state";
import {
	LISTEN_ASIDE_ATTR,
	LISTEN_ANSWER_CARD_ATTR,
	LISTEN_AUTOPLAY_SKIP_ATTR,
	LISTEN_MODEL_ANSWER_ATTR,
	LISTEN_PROBLEM_ATTR,
	LISTEN_ROOT_ATTR,
	LISTEN_YOURS_ATTR,
	adjacentAcross,
	adjacentBlock,
	anchorFor,
	connectedRoot,
	resolveAnchor,
	type ListenAnchor,
	blockLabel,
	blocksIn,
	dockRoot,
	isDockedProblem,
	rootOf,
	sourceOf,
	sourcesIn,
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

/** What the transcript held when autoplay was armed. Opening or closing
 *  something inside it (thinking, a brief, a card's Why) changes neither. */
interface AutoplayTurn {
	root: Element;
	/** Its rows (top-level containers). */
	history: ReadonlySet<Element>;
	/** The sources rendered inside them. */
	sources: ReadonlySet<string>;
}

/** `aside`: the brief the read started in, the only one it reads (see
 *  LISTEN_ASIDE_ATTR); every other is passed over. `autoplay`: the turn
 *  whose reply started this automatic read. */
type Queue = { kind: "from"; root: Element; aside: Element | null; autoplay?: AutoplayTurn } | { kind: "list"; blocks: Element[] };

const asideOf = (block: Element) => block.closest(`[${LISTEN_ASIDE_ATTR}]`);

/** After the turn ends, how long the dock gets to show its question. */
const SETTLE_MS = 600;
/** An armed autoplay whose turn never started goes stale. */
const ARM_TTL_MS = 60_000;

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

/** A turn the learner starts (a send, an answer): arm autoplay inside the
 *  gesture, then disarm if the session did not accept it — false may hide
 *  a delivered input (see SessionModel.send), and then its reply is not
 *  autoplayed. */
export function startAutoplayTurn(controller: ListenController | null, start: () => Promise<boolean>): Promise<boolean> {
	controller?.armAutoplay();
	return start().then((accepted) => {
		if (!accepted) controller?.disarmAutoplay();
		return accepted;
	});
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
	/** Include model answers in autoplay; explicit reads ignore this flag. */
	readModelAnswers = false;
	/** A turn is generating (follow mode), kept current by the chat. */
	private live = false;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private anchor: ListenAnchor | null = null;
	/** Read from here on a block still being written: read it once it's
	 *  finished (found again by its source and position — its text is growing). */
	private waitFor: ListenAnchor | null = null;
	/** Autoplay waiting for the reply: new rows or sources, not a mutable block count. */
	private armed: { turn: AutoplayTurn; sawLive: boolean; at: number } | null = null;
	private observer: MutationObserver | null = null;
	private pokeTimer: ReturnType<typeof setTimeout> | undefined;

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
		const again = resolveAnchor(this.anchor);
		if (again) this.set({ block: again });
		return again;
	}

	/** The block a read waits to start on (selected while still being
	 *  written), found again if a re-render replaced it; null otherwise. */
	pendingBlock(): Element | null {
		return resolveAnchor(this.waitFor, true);
	}

	/** The live element, for progress readers (the pill's bar). */
	get element(): HTMLAudioElement | null {
		return this.audio;
	}

	/** Esc can cancel a reply before any audio or player is visible. */
	get pendingAutoplay(): boolean {
		return this.armed !== null;
	}

	// ── commands ────────────────────────────────────────────────────────────
	/** Read `block`, then keep going through its root. Call from the click. */
	playFrom(block: Element) {
		const root = rootOf(block);
		if (root) this.start({ kind: "from", root, aside: asideOf(block) }, block);
	}

	/** Read exactly these blocks, in order. Call from the click. */
	playList(blocks: Element[]) {
		const first = blocks[0];
		if (first) this.start({ kind: "list", blocks }, first);
	}

	/** Stop reading and forget an armed autoplay: nothing on this page
	 *  starts reading later (Stop, Esc, leaving the session). */
	stop() {
		this.armed = null;
		clearTimeout(this.settleTimer);
		this.halt();
	}

	/** The queue ran out: an armed autoplay still waits for its reply. */
	private halt() {
		this.session++;
		this.queue = null;
		this.dropClips();
		if (this.audio) {
			this.audio.pause();
			this.audio.removeAttribute("src");
		}
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
		this.navigate(1);
	}

	prev() {
		this.navigate(-1);
	}

	/** The player's buttons are manual selections; subsequent automatic
	 * advancement keeps the queue's existing exclusions. */
	private navigate(dir: 1 | -1) {
		const block = this.neighbor(dir, true);
		if (block && (this.queue?.kind === "list" || this.ready(block))) this.goTo(block);
		else if (block) this.wait(block);
		else if (dir === 1 && this.following()) this.wait();
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
		const turn = { root: transcript, history: new Set(transcript.children), sources: sourcesIn(transcript) };
		this.armed = { turn, sawLive: this.live, at: Date.now() };
		this.watch();
	}

	/** The turn armAutoplay expected didn't start (a refused send or answer). */
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
				else this.halt();
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
			this.wait(first);
			return;
		}
		this.goTo(first);
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
	 *  (markdown streams in order) or the turn has ended. A read crossing
	 *  from the transcript into the dock waits for the turn's end. */
	private ready(block: Element): boolean {
		if (!this.live || this.queue?.kind === "list") return true;
		const root = rootOf(block);
		if (root?.getAttribute(LISTEN_ROOT_ATTR) === "transcript") return adjacentBlock(block, root, 1) !== null;
		const q = this.queue;
		const at = this.activeBlock();
		return q?.kind !== "from" || q.root === root || (at !== null && rootOf(at) === root);
	}

	private wait(block?: Element) {
		if (block) {
			this.waitFor = anchorFor(block);
			this.set({ block: null });
		}
		this.session++;
		this.audio?.pause();
		this.set({ status: "waiting", label: "Waiting…", position: null, error: null });
		this.watch();
	}

	/** Watch the page while waiting or armed: new blocks may be ready. */
	private watch() {
		if (this.observer || typeof MutationObserver === "undefined") return;
		this.observer = new MutationObserver(() => {
			this.pokeTimer ??= setTimeout(() => {
				this.pokeTimer = undefined;
				this.poke();
			}, 50);
		});
		this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	}

	private unwatch() {
		this.observer?.disconnect();
		this.observer = null;
		clearTimeout(this.pokeTimer);
		this.pokeTimer = undefined;
	}

	/** Re-check a caught-up read and an armed autoplay. `settled`: the turn
	 *  ended a moment ago — whatever isn't here now isn't coming. */
	private poke(settled = false) {
		if (this.snapshot.status === "waiting") {
			const pending = this.waitFor;
			const next = pending ? resolveAnchor(pending, true) : this.neighbor(1);
			if (next && this.ready(next)) this.goTo(next);
			else if (settled && !this.live) this.halt();
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
		const reply = this.replyBlocks(armed.turn).find((b) => !asideOf(b) && this.autoplayAllowed(b));
		let first: Element | null = reply && this.ready(reply) ? reply : null;
		const over = settled && armed.sawLive && !this.live;
		// A reply that is only a question: read the question.
		if (!first && over && this.readQuestion) {
			const dock = dockRoot(document);
			const question = dock ? (blocksIn(dock)[0] ?? null) : null;
			first = question && this.dockAllowed(question, armed.turn) ? question : null;
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
		this.queue = { kind: "from", root, aside: null, autoplay: armed.turn };
		this.goTo(first);
	}

	/** The reply: blocks in rows added since arming, or from a source
	 * added since inside an existing row. Expanding or collapsing anything
	 * in history cannot move this boundary. */
	private replyBlocks({ root, history, sources }: AutoplayTurn): Element[] {
		if (!root.isConnected) return [];
		return blocksIn(root).filter((block) => {
			let container = block;
			while (container.parentElement && container.parentElement !== root) container = container.parentElement;
			if (!history.has(container)) return true;
			const source = sourceOf(block);
			return source !== null && !sources.has(source);
		});
	}

	/** A practice problem stays in the dock across attempts. Autoplay
	 * reads it only with the reply that posed its ID;
	 * teaching questions carry no ID. */
	private dockAllowed(block: Element, turn: AutoplayTurn): boolean {
		const id = block.getAttribute(LISTEN_PROBLEM_ATTR);
		if (!id) return true;
		return this.replyBlocks(turn).some((b) => b.getAttribute(LISTEN_PROBLEM_ATTR) === id);
	}

	/** Where autoplay starts and what it automatically advances onto. It
	 * passes the learner's own rows; the player's buttons bypass these rules,
	 * and a read the learner starts never applies them.
	 * A model answer inside a card is the one opt-in exception, not a
	 * reason to read the rest of the card. With Read the question on,
	 * the docked problem is read from the dock alone. */
	private autoplayAllowed(block: Element): boolean {
		if (block.closest(`[${LISTEN_AUTOPLAY_SKIP_ATTR}]`)) return false;
		if (block.closest(`[${LISTEN_MODEL_ANSWER_ATTR}]`)) return this.readModelAnswers;
		if (block.closest(`[${LISTEN_ANSWER_CARD_ATTR}]`)) return false;
		if (block.closest(`[${LISTEN_YOURS_ATTR}]`)) return false;
		return !(this.readQuestion && isDockedProblem(block));
	}

	private neighbor(dir: 1 | -1, manual = false): Element | null {
		const q = this.queue;
		// Waiting on a selected block still being written: step from it.
		const at = this.activeBlock() ?? (this.waitFor ? this.pendingBlock() : this.snapshot.block);
		if (!q || !at) return null;
		if (q.kind === "list") return q.blocks[q.blocks.indexOf(at) + dir] ?? null;
		const root = connectedRoot(q.root);
		if (!root) return null;
		const step = (b: Element) => (this.readQuestion ? adjacentAcross(b, root, dir) : adjacentBlock(b, root, dir));
		const turn = q.autoplay;
		let next = step(at);
		if (manual) return next;
		while (next && ((asideOf(next) && asideOf(next) !== q.aside) || (turn !== undefined && !this.autoplayAllowed(next)))) next = step(next);
		if (next && turn !== undefined && rootOf(next) === dockRoot(document) && !this.dockAllowed(next, turn)) return null;
		return next;
	}

	private position(block: Element): ListenSnapshot["position"] {
		const q = this.queue;
		return q?.kind === "list" ? { index: q.blocks.indexOf(block), total: q.blocks.length } : null;
	}

	private goTo(block: Element) {
		this.waitFor = null;
		this.anchor = anchorFor(block);
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
