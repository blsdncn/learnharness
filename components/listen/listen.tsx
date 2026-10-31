"use client";

/**
 * Listening: text-to-speech over the session page.
 *
 * Hover a paragraph-level block to reveal one shared speaker in its
 * gutter without shifting layout; click to read from there through
 * the rest of that root (and on into the dock's question with "Read the
 * question" on). The player stays visible for a non-idle read and while
 * focused for keyboard control. "Autoplay replies" starts the same read
 * on the reply to a turn you start
 * (listen-controller armAutoplay; the chat arms it on each send). Touch
 * input taps a block to reveal its speaker instead — decided PER POINTER
 * EVENT (pointerType), so a desktop browser over remote access keeps the
 * hover behavior and only real touch gets the tap behavior.
 *
 * Listening preferences are seeded by the server and refreshed through
 * GET /api/tts/openai when settings change.
 *
 * KEYBOARD: Cmd/Ctrl+Shift+L (registry
 * "focus-listening") focuses the player as a keyboard surface — shown even
 * while idle, never starting audio by itself. It selects a block (the one
 * reading or waiting, else the first on screen) apart from playback; while
 * focus is inside it, ↑/↓ select, Enter reads from the selection, Space
 * pauses, ←/→ are the player's Previous/Next, S changes speed. Esc reaches
 * it through the chat's layered-Esc gate (after overlays and dictation):
 * stop, leave, and give focus back. Focus moving elsewhere just leaves.
 *
 * Positioning runs in a rAF loop writing styles to the portaled speaker,
 * playback highlight and selection outline — hovering never re-renders React.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTypingSurface, kbdEventForAction, type SpeechSettings } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useSettingsSaved } from "@/components/settings-signal";
import { LISTEN_RATES, ListenController, type ListenSnapshot } from "./listen-controller";
import { LISTEN_ROOT_ATTR, adjacentAcross, adjacentBlock, blockFor, blockLabel, blocksIn, dockRoot, isCollapsed, rootOf, anchorFor, connectedRoot, resolveAnchor, type ListenAnchor } from "./speech-dom";

/** The keyboard surface while focused: the selected block (apart from
 *  playback), the root browsing started in, and a focus request count. */
interface Surface {
	selected: Element | null;
	/** Selection survives a passage's client-to-server DOM replacement. */
	anchor: ListenAnchor | null;
	root: Element | null;
	opened: number;
}

interface ListenApi {
	controller: ListenController | null;
	configured: boolean;
	/** The keyboard surface (Cmd/Ctrl+Shift+L) holds focus. */
	keyboard: boolean;
	/** Esc on listening: stop reading and an armed autoplay, and leave the
	 *  keyboard surface, giving focus back. */
	dismiss: () => void;
}

const ListenContext = createContext<ListenApi>({ controller: null, configured: false, keyboard: false, dismiss: () => {} });
/** What the player needs to be the keyboard surface (listen.tsx only). */
const SurfaceContext = createContext<{
	surface: Surface | null;
	element: RefObject<HTMLDivElement | null>;
	select: (block: Element | null) => void;
	leave: (restore: boolean) => void;
} | null>(null);

export function useListen(): ListenApi {
	return useContext(ListenContext);
}

const IDLE: ListenSnapshot = { status: "idle", block: null, label: "", position: null, rate: 1, error: null };

export function useListenSnapshot(): ListenSnapshot {
	const { controller } = useListen();
	return useSyncExternalStore(
		controller?.subscribe ?? (() => () => {}),
		controller?.getSnapshot ?? (() => IDLE),
		() => IDLE,
	);
}

interface SpeechPrefs {
	configured: boolean;
	readQuestion: boolean;
	autoplay: boolean;
	readModelAnswers: boolean;
}

/** Unset or malformed preferences are off. */
function speechPrefs(configured: unknown, s: Partial<Record<"readQuestion" | "autoplay" | "readModelAnswers", unknown>> | null | undefined): SpeechPrefs {
	return { configured: configured === true, readQuestion: s?.readQuestion === true, autoplay: s?.autoplay === true, readModelAnswers: s?.readModelAnswers === true };
}

function applyPrefs(reader: ListenController, prefs: SpeechPrefs) {
	reader.readQuestion = prefs.readQuestion;
	reader.autoplay = prefs.configured && prefs.autoplay;
	reader.readModelAnswers = prefs.readModelAnswers;
}

/** Is speech configured, does reading continue into the question, and
 *  are replies autoplayed? Re-read whenever keys or the speech section save. */
function useSpeechPrefs(initialSpeech?: SpeechSettings): SpeechPrefs {
	const [prefs, setPrefs] = useState<SpeechPrefs>(() => speechPrefs(initialSpeech?.enabled, initialSpeech));
	const [tick, setTick] = useState(0);
	useSettingsSaved((section) => {
		if (section === "keys" || section === "speech") setTick((t) => t + 1);
	});
	useEffect(() => {
		let live = true;
		fetch("/api/tts/openai")
			.then((r) => (r.ok ? (r.json() as Promise<Partial<SpeechPrefs>>) : null))
			.then((s) => live && setPrefs(speechPrefs(s?.configured, s)))
			.catch(() => live && setPrefs(speechPrefs(false, null)));
		return () => {
			live = false;
		};
	}, [tick]);
	return prefs;
}

const INTERACTIVE = "a, button, input, textarea, select, label, summary, [contenteditable], [role='button']";

/** The next speed on the player's ladder, wrapping. */
function nextRate(rate: number): number {
	return LISTEN_RATES[(LISTEN_RATES.indexOf(rate as (typeof LISTEN_RATES)[number]) + 1) % LISTEN_RATES.length]!;
}

/** A surfaced menu, dialog, or the cheat sheet owns the keyboard — the
 *  layers session Find yields to (sessionFindHasForegroundLayer). A hover
 *  tooltip takes no keys, so it never blocks the player's. */
function layerOwnsKeys(doc: Document): boolean {
	return Array.from(doc.querySelectorAll(
		'[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [data-testid="cheat-sheet"]',
	)).some((element) => {
		if (element.querySelector('[role="tooltip"]')) return false;
		if (element.getAttribute("data-state") === "closed" || element.hasAttribute("hidden")) return false;
		const view = doc.defaultView;
		if (typeof view?.getComputedStyle !== "function") return true;
		const style = view.getComputedStyle(element);
		// A mounted overlay owns keys while fading in, even at zero opacity.
		return style.display !== "none" && style.visibility !== "hidden";
	});
}

/** The transcript's band on screen: its scroller clipped to the viewport,
 *  above the dock floating over the scroller's bottom. */
function transcriptView(transcript: Element): { top: number; bottom: number } {
	let top = 0;
	let bottom = typeof window.innerHeight === "number" ? window.innerHeight : Infinity;
	const view = transcript.ownerDocument.defaultView;
	for (let el = transcript.parentElement; el && typeof view?.getComputedStyle === "function"; el = el.parentElement) {
		const overflow = view.getComputedStyle(el).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const r = el.getBoundingClientRect();
		top = Math.max(top, r.top);
		bottom = Math.min(bottom, r.bottom);
		break;
	}
	const dockTop = dockRoot(transcript.ownerDocument)?.getBoundingClientRect().top;
	if (dockTop !== undefined && dockTop > top && dockTop < bottom) bottom = dockTop;
	return { top, bottom };
}

/** Where the keyboard surface starts: the block reading or waiting to be
 *  read; else the transcript's first block on screen, or its first; else
 *  the dock's first. */
function initialSelection(controller: ListenController): Element | null {
	const current = controller.activeBlock() ?? controller.pendingBlock();
	if (current?.isConnected) return current;
	const transcript = document.querySelector(`[${LISTEN_ROOT_ATTR}="transcript"]`);
	const blocks = transcript ? blocksIn(transcript) : [];
	if (transcript && blocks.length > 0) {
		const view = transcriptView(transcript);
		const onScreen = blocks.find((b) => {
			const r = b.getBoundingClientRect();
			return r.height > 0 && r.bottom > view.top && r.top < view.bottom;
		});
		return onScreen ?? blocks[0]!;
	}
	const dock = dockRoot(document);
	return dock ? (blocksIn(dock)[0] ?? null) : null;
}

/** Browse one block from `at`: through the root browsing started in, and
 *  with "Read the question" on across into the dock the way a read
 *  crosses (speech-dom adjacentAcross). Null at either end. */
function browseFrom(at: Element, start: Element | null, dir: 1 | -1, readQuestion: boolean): Element | null {
	if (readQuestion && start?.isConnected) return adjacentAcross(at, start, dir);
	const root = rootOf(at);
	return root ? adjacentBlock(at, root, dir) : null;
}

/** Bring a browsed transcript block on screen — never the dock's. */
function reveal(block: Element) {
	if (rootOf(block)?.getAttribute(LISTEN_ROOT_ATTR) !== "transcript") return;
	const transcript = rootOf(block)!;
	const r = block.getBoundingClientRect();
	const view = transcriptView(transcript);
	if (r.top < view.top || r.bottom > view.bottom) block.scrollIntoView?.({ block: "center" });
}

/** The selection, announced: its player label and the start of its text. */
function selectionContent(block: Element): string {
	return (block.textContent ?? "").replace(/\s+/g, " ").trim();
}

function selectionText(block: Element | null): string {
	if (!block) return "Nothing to read";
	const text = selectionContent(block);
	return `${blockLabel(block)}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}

export function ListenProvider({ children, initialSpeech }: { children: ReactNode; initialSpeech?: SpeechSettings }) {
	const prefs = useSpeechPrefs(initialSpeech);
	const { configured } = prefs;
	// Chat sends the opening prompt in a child mount effect. Initialize the
	// controller before that effect, without waiting for the settings GET.
	const [controller] = useState(() => {
		if (typeof window === "undefined") return null;
		const reader = new ListenController();
		applyPrefs(reader, prefs);
		return reader;
	});
	const lifetime = useRef(0);
	useEffect(() => {
		if (controller) applyPrefs(controller, prefs);
	}, [controller, prefs]);
	useEffect(() => {
		const generation = ++lifetime.current;
		return () => {
			// StrictMode replays mount effects without another opening send.
			// Cancel that simulated teardown; a real unmount stops audio and
			// forgets an armed autoplay, so nothing reads after leaving.
			queueMicrotask(() => {
				if (lifetime.current === generation) controller?.stop();
			});
		};
	}, [controller]);
	useEffect(() => { if (!configured) controller?.stop(); }, [configured, controller]);

	// The keyboard surface: session-local, nothing saved.
	const [surface, setSurface] = useState<Surface | null>(null);
	const surfaceRef = useRef<Surface | null>(null);
	surfaceRef.current = surface;
	const element = useRef<HTMLDivElement | null>(null);
	const priorFocus = useRef<Element | null>(null);
	const select = useCallback((selected: Element | null) => {
		const s = surfaceRef.current;
		if (!s || s.selected === selected) return;
		surfaceRef.current = { ...s, selected, anchor: anchorFor(selected) };
		setSurface(surfaceRef.current);
	}, []);
	/** Leave the surface; `restore` gives focus back to where it was (or
	 *  the composer), as Esc does. Focus moving away only leaves. */
	const leave = useCallback((restore: boolean) => {
		if (!surfaceRef.current) return;
		surfaceRef.current = null;
		setSurface(null);
		const prior = priorFocus.current;
		priorFocus.current = null;
		if (!restore) return;
		const target = prior?.isConnected && prior !== document.body && prior !== document.documentElement
			? prior
			: document.querySelector('[data-testid="composer"] [data-file-path-input]');
		if (target instanceof HTMLElement && target !== document.body) target.focus({ preventScroll: true });
		else if (element.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
	}, []);
	const dismiss = useCallback(() => {
		controller?.stop();
		leave(true);
	}, [controller, leave]);
	useEffect(() => {
		if (!controller || !configured) {
			leave(false);
			return;
		}
		const onFocus = () => {
			if (layerOwnsKeys(document)) return;
			const s = surfaceRef.current;
			if (!s) {
				const active = document.activeElement;
				priorFocus.current = active && !element.current?.contains(active) ? active : null;
			}
			const selected = (s && resolveAnchor(s.anchor)) ?? initialSelection(controller);
			surfaceRef.current = { selected, anchor: anchorFor(selected), root: connectedRoot(s?.root ?? null) ?? (selected && rootOf(selected)), opened: (s?.opened ?? 0) + 1 };
			setSurface(surfaceRef.current);
		};
		window.addEventListener(kbdEventForAction("focus-listening"), onFocus);
		return () => window.removeEventListener(kbdEventForAction("focus-listening"), onFocus);
	}, [controller, configured, leave]);

	const keyboard = surface !== null;
	const api = useMemo(() => ({ controller, configured, keyboard, dismiss }), [controller, configured, keyboard, dismiss]);
	const surfaceApi = useMemo(() => ({ surface, element, select, leave }), [surface, select, leave]);
	return (
		<ListenContext.Provider value={api}>
			<SurfaceContext.Provider value={surfaceApi}>
				{children}
				{controller && configured && <ListenOverlay controller={controller} selection={surface?.selected ?? null} />}
			</SurfaceContext.Provider>
		</ListenContext.Provider>
	);
}

/** A block's on-screen box: a table row is clipped to its table's
 *  scroller, so a wide table on a phone never puts the speaker or the
 *  highlight past the screen edge. */
function visibleRect(block: Element): { left: number; top: number; right: number; width: number; height: number } {
	const r = block.getBoundingClientRect();
	const scroller = block.matches("tr") ? block.closest("table")?.parentElement?.getBoundingClientRect() : undefined;
	const left = scroller ? Math.max(r.left, scroller.left) : r.left;
	const right = scroller ? Math.min(r.right, scroller.right) : r.right;
	return { left, top: r.top, right, width: Math.max(0, right - left), height: r.height };
}

/** Is `block` on screen to outline (connected, not folded or collapsed away)? */
function shown(block: Element | null): block is Element {
	return !!block?.isConnected && !isCollapsed(block) && getComputedStyle(block).visibility !== "hidden";
}

/** The shared speaker, the reading highlight, and the keyboard surface's
 *  selection outline (muted — apart from the highlight). */
function ListenOverlay({ controller, selection }: { controller: ListenController; selection: Element | null }) {
	const speakerRef = useRef<HTMLButtonElement>(null);
	const highlightRef = useRef<HTMLDivElement>(null);
	const selectionRef = useRef<HTMLDivElement>(null);
	const selected = useRef(selection);
	selected.current = selection;
	const hovered = useRef<Element | null>(null);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	// Where the pointer is: hover for mouse/pen, tap-to-reveal for touch.
	useEffect(() => {
		let hideTimer: ReturnType<typeof setTimeout> | undefined;
		let touchStart: { x: number; y: number } | null = null;
		const show = (block: Element | null) => {
			clearTimeout(hideTimer);
			hovered.current = block;
		};
		const hideSoon = () => {
			clearTimeout(hideTimer);
			hideTimer = setTimeout(() => (hovered.current = null), 250);
		};
		const blockAt = (target: EventTarget | null): Element | null => {
			if (!(target instanceof Element)) return null;
			const root = target.closest(`[${LISTEN_ROOT_ATTR}]`);
			return root ? blockFor(target, root) : null;
		};
		const onOver = (e: PointerEvent) => {
			if (e.pointerType === "touch") return;
			if (speakerRef.current?.contains(e.target as Node)) return show(hovered.current);
			const block = blockAt(e.target);
			if (block) show(block);
			else hideSoon();
		};
		const onDown = (e: PointerEvent) => {
			touchStart = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null;
		};
		const onUp = (e: PointerEvent) => {
			if (e.pointerType !== "touch" || !touchStart) return;
			const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 10;
			touchStart = null;
			if (moved || speakerRef.current?.contains(e.target as Node)) return;
			if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
			show(blockAt(e.target));
		};
		const onLeaveWindow = (e: PointerEvent) => {
			// Non-hovering pointers leave when the finger lifts. Keep the
			// tapped block available instead of starting the mouse's timer.
			if (e.pointerType !== "touch") hideSoon();
		};
		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("pointerup", onUp);
		document.documentElement.addEventListener("pointerleave", onLeaveWindow);
		return () => {
			clearTimeout(hideTimer);
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("pointerup", onUp);
			document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
		};
	}, []);

	// Follow the blocks: write positions every frame.
	useEffect(() => {
		if (!mounted) return;
		let frame = 0;
		const place = () => {
			frame = requestAnimationFrame(place);
			const speaker = speakerRef.current;
			const highlight = highlightRef.current;
			if (!speaker || !highlight) return;
			const block = hovered.current?.isConnected ? hovered.current : null;
			const active = controller.activeBlock();
			if (block && block !== active) {
				const r = visibleRect(block);
				const size = 24;
				// The portal floats outside the block without changing layout.
				// Stay on its left, clamped to the viewport on narrow screens.
				const left = Math.max(0, r.left - size - 4);
				const top = r.top + Math.max(0, Math.min(r.height, 26) / 2 - size / 2);
				speaker.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
				speaker.style.opacity = "1";
				speaker.style.pointerEvents = "auto";
			} else {
				speaker.style.opacity = "0";
				speaker.style.pointerEvents = "none";
			}
			// A folded dock's section is read while hidden: no highlight until
			// the dock opens. Nor on a section collapsed mid-read.
			const waiting = controller.getSnapshot().status === "waiting";
			if (!waiting && shown(active)) {
				const r = visibleRect(active);
				highlight.style.transform = `translate(${Math.round(r.left - 6)}px, ${Math.round(r.top - 2)}px)`;
				highlight.style.width = `${Math.round(r.width + 12)}px`;
				highlight.style.height = `${Math.round(r.height + 4)}px`;
				highlight.style.opacity = "1";
			} else {
				highlight.style.opacity = "0";
			}
			const outline = selectionRef.current;
			const choice = selected.current;
			if (outline && shown(choice)) {
				const r = visibleRect(choice);
				outline.style.transform = `translate(${Math.round(r.left - 8)}px, ${Math.round(r.top - 4)}px)`;
				outline.style.width = `${Math.round(r.width + 16)}px`;
				outline.style.height = `${Math.round(r.height + 8)}px`;
				outline.style.opacity = "1";
			} else if (outline) {
				outline.style.opacity = "0";
			}
		};
		frame = requestAnimationFrame(place);
		return () => cancelAnimationFrame(frame);
	}, [controller, mounted]);

	if (!mounted) return null;
	return createPortal(
		<>
			<div
				ref={highlightRef}
				aria-hidden
				data-testid="listen-highlight"
				className="pointer-events-none fixed left-0 top-0 z-30 rounded-md border-l-2 border-primary/60 bg-primary/8 opacity-0 transition-opacity"
			/>
			<div
				ref={selectionRef}
				aria-hidden
				data-testid="listen-selection"
				className="pointer-events-none fixed left-0 top-0 z-30 rounded-lg border border-dashed border-muted-foreground/50 opacity-0"
			/>
			<button
				ref={speakerRef}
				type="button"
				aria-label="Listen from here"
				title="Listen from here"
				data-testid="listen-speaker"
				onClick={(e) => {
					const block = hovered.current;
					if (!block) return;
					controller.playFrom(block);
					hovered.current = null;
					e.currentTarget.blur();
				}}
				className="fixed left-0 top-0 z-40 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground"
			>
				<Volume2Icon className="size-4" />
			</button>
		</>,
		document.body,
	);
}

/** The audio progress, read per frame from the element (no re-renders). */
function ListenProgress({ controller }: { controller: ListenController }) {
	const barRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		let frame = 0;
		const tick = () => {
			frame = requestAnimationFrame(tick);
			const a = controller.element;
			if (barRef.current && a) {
				const p = a.duration > 0 && Number.isFinite(a.duration) ? a.currentTime / a.duration : 0;
				barRef.current.style.width = `${Math.min(100, p * 100)}%`;
			}
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [controller]);
	return (
		<span className="h-0.5 w-14 overflow-hidden rounded-full bg-border" aria-hidden>
			<span ref={barRef} className="block h-full w-0 bg-foreground/70" />
		</span>
	);
}

const pillButton = "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground";

/** The key hint shown while the player is the keyboard surface. */
const SURFACE_HINT = "↑↓ select · Enter read · Space pause · ←→ step · S speed · Esc stop";

/** The player — rendered while something is reading, and while it is the
 *  keyboard surface (then also idle). Placement is the caller's
 *  (className): the chat anchors it to the dock's top edge. */
export function ListenPill({ className }: { className?: string }) {
	const { controller } = useListen();
	const keyboard = useContext(SurfaceContext);
	const s = useListenSnapshot();
	const surface = keyboard?.surface ?? null;
	const element = keyboard?.element;

	// Opening (or reopening) the surface focuses the player.
	const opened = surface?.opened ?? 0;
	useEffect(() => {
		if (opened > 0) element?.current?.focus({ preventScroll: true });
	}, [opened, element]);

	// The surface's own keys, only while focus is inside it. Esc is not
	// here: it rides the chat's layered-Esc gate, after overlays and
	// dictation. Claimed keys stop at the player — the question rows, the
	// Enter-opens-check and Enter-submits listeners never also act.
	const active = surface !== null;
	const stateRef = useRef({ surface, controller, keyboard });
	stateRef.current = { surface, controller, keyboard };
	useEffect(() => {
		const el = element?.current;
		if (!active || !el) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const { surface: at, controller: reader, keyboard: api } = stateRef.current;
			if (!at || !reader || !api) return;
			if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || isTypingSurface(e)) return;
			if (layerOwnsKeys(document)) return;
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
			if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "s"].includes(key)) return;
			e.preventDefault();
			e.stopPropagation();
			const selected = resolveAnchor(at.anchor);
			if (selected !== at.selected) api.select(selected);
			if (key === "ArrowUp" || key === "ArrowDown") {
				if (!selected) return api.select(initialSelection(reader));
				const next = browseFrom(selected, connectedRoot(at.root), key === "ArrowDown" ? 1 : -1, reader.readQuestion);
				if (!next) return;
				api.select(next);
				reveal(next);
			} else if (key === "Enter") {
				if (selected) reader.playFrom(selected);
			} else if (key === " ") {
				reader.togglePause();
			} else if (key === "ArrowLeft" || key === "ArrowRight") {
				if (key === "ArrowLeft") reader.prev();
				else reader.next();
				const now = reader.activeBlock() ?? reader.pendingBlock();
				if (now) api.select(now);
			} else {
				reader.setRate(nextRate(reader.getSnapshot().rate));
			}
		};
		// Focus elsewhere leaves the surface; reading carries on. A window
		// switch is not leaving — focus comes back to the player.
		const onFocusOut = (e: FocusEvent) => {
			if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
			if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
			stateRef.current.keyboard?.leave(false);
		};
		el.addEventListener("keydown", onKeyDown);
		el.addEventListener("focusout", onFocusOut);
		return () => {
			el.removeEventListener("keydown", onKeyDown);
			el.removeEventListener("focusout", onFocusOut);
		};
	}, [active, element]);

	if (!controller || (s.status === "idle" && !active)) return null;
	return (
		<div
			ref={element}
			tabIndex={-1}
			role="group"
			aria-label="Listening"
			data-testid="listen-surface"
			className="pointer-events-auto flex max-w-full flex-col items-end gap-1 outline-none"
			// While it is the keyboard surface, clicking its buttons keeps
			// focus on the player (a pressed button can turn disabled).
			onMouseDown={active ? (e) => e.preventDefault() : undefined}
		>
			{active && (
				<>
					<p data-testid="listen-hint" className="max-w-full rounded-md bg-background/85 px-1.5 text-right font-ui text-[11px] leading-snug text-muted-foreground">
						{SURFACE_HINT}
					</p>
					<span role="status" aria-live="polite" className="sr-only" data-testid="listen-selection-status">
						{selectionText(surface.selected)}
					</span>
				</>
			)}
			<div
				data-testid="listen-pill"
				className={cn(
					"flex max-w-full items-center gap-1 rounded-full border bg-card py-1 pl-3 pr-1 font-ui text-xs shadow-lg",
					className,
				)}
			>
				{s.status === "error" ? (
					<span role="alert" className="min-w-0 max-w-72 truncate text-destructive" data-testid="listen-error" title={s.error ?? ""}>
						{s.error}
					</span>
				) : (
					<>
						<span className="min-w-0 max-w-40 truncate uppercase tracking-wide text-muted-foreground" data-testid="listen-label">
							{s.label}
							{s.position && ` · ${s.position.index + 1}/${s.position.total}`}
						</span>
						<span className="mx-1 flex w-14 shrink-0 items-center">
							{s.status === "loading" || s.status === "waiting" ? (
								<BrailleSpinner className="h-3" label={s.status === "waiting" ? "Waiting for the reply" : "Loading speech"} />
							) : (
								<ListenProgress controller={controller} />
							)}
						</span>
						<button type="button" aria-label="Previous block" className={pillButton} onClick={() => controller.prev()}>
							<SkipBackIcon className="size-3.5" />
						</button>
						<button
							type="button"
							aria-label={s.status === "paused" ? "Resume" : "Pause"}
							data-testid="listen-toggle"
							className={pillButton}
							disabled={s.status === "loading" || s.status === "waiting"}
							onClick={() => controller.togglePause()}
						>
							{s.status === "paused" ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
						</button>
						<button type="button" aria-label="Next block" className={pillButton} onClick={() => controller.next()}>
							<SkipForwardIcon className="size-3.5" />
						</button>
						<button
							type="button"
							aria-label={`Speed ${s.rate}×, change to ${nextRate(s.rate)}×`}
							data-testid="listen-rate"
							className={cn(pillButton, "w-auto px-1.5 tabular-nums")}
							onClick={() => controller.setRate(nextRate(s.rate))}
						>
							{s.rate.toFixed(1)}×
						</button>
					</>
				)}
				<button type="button" aria-label="Stop listening (Esc)" data-testid="listen-stop" className={pillButton} onClick={() => controller.stop()}>
					<XIcon className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
