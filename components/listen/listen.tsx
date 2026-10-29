"use client";

/**
 * LISTEN (listen wave, 2026-10-26): text-to-speech over the session page.
 *
 * Owner rulings: hover any paragraph-level block → ONE shared speaker in
 * its gutter (the md-blocks "one affordance" stance: nothing shows until
 * you're over it, nothing shifts layout); click → read from there through
 * the rest of that root (and on into the dock's question with "Read the
 * question" on); a pill player only while something plays. "Autoplay
 * replies" starts the same read on the reply to a turn you start
 * (listen-controller armAutoplay; the chat arms it on each send). Touch
 * input taps a block to reveal its speaker instead — decided PER POINTER
 * EVENT (pointerType), so a desktop browser over remote access keeps the
 * hover behavior and only real touch gets the tap behavior.
 *
 * Everything is gated on the listening status from GET /api/tts/openai.
 *
 * Positioning runs in a rAF loop writing styles straight to two portaled
 * fixed elements (the speaker, the reading highlight) — hovering never
 * re-renders React.
 */

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useSettingsSaved } from "@/components/settings-signal";
import { LISTEN_RATES, ListenController, type ListenSnapshot } from "./listen-controller";
import { LISTEN_ROOT_ATTR, blockFor, isCollapsed } from "./speech-dom";

interface ListenApi {
	controller: ListenController | null;
	configured: boolean;
}

const ListenContext = createContext<ListenApi>({ controller: null, configured: false });

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
}

const OFF: SpeechPrefs = { configured: false, readQuestion: false, autoplay: false };

/** Is speech configured, does reading continue into the question, and
 *  are replies autoplayed? Re-read whenever keys or the speech section save. */
function useSpeechPrefs(): SpeechPrefs {
	const [prefs, setPrefs] = useState<SpeechPrefs>(OFF);
	const [tick, setTick] = useState(0);
	useSettingsSaved((section) => {
		if (section === "keys" || section === "speech") setTick((t) => t + 1);
	});
	useEffect(() => {
		let live = true;
		fetch("/api/tts/openai")
			.then((r) => (r.ok ? (r.json() as Promise<Partial<SpeechPrefs>>) : null))
			.then((s) => live && setPrefs({ configured: s?.configured === true, readQuestion: s?.readQuestion === true, autoplay: s?.autoplay === true }))
			.catch(() => live && setPrefs(OFF));
		return () => {
			live = false;
		};
	}, [tick]);
	return prefs;
}

const INTERACTIVE = "a, button, input, textarea, select, label, summary, [contenteditable], [role='button']";

export function ListenProvider({ children }: { children: ReactNode }) {
	const [controller] = useState(() => (typeof window === "undefined" ? null : new ListenController()));
	const { configured, readQuestion, autoplay } = useSpeechPrefs();
	useEffect(() => {
		if (!controller) return;
		controller.readQuestion = readQuestion;
		controller.autoplay = configured && autoplay;
	}, [controller, readQuestion, autoplay, configured]);
	useEffect(() => () => controller?.stop(), [controller]);
	useEffect(() => { if (!configured) controller?.stop(); }, [configured, controller]);
	return (
		<ListenContext.Provider value={{ controller, configured }}>
			{children}
			{controller && configured && <ListenOverlay controller={controller} />}
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

/** The shared speaker + the reading highlight. */
function ListenOverlay({ controller }: { controller: ListenController }) {
	const speakerRef = useRef<HTMLButtonElement>(null);
	const highlightRef = useRef<HTMLDivElement>(null);
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

	// Follow the blocks: write positions every frame (cheap: two rects).
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
				const root = block.closest(`[${LISTEN_ROOT_ATTR}]`)?.getBoundingClientRect();
				const size = 24;
				// The left gutter when there is one; otherwise just past the
				// block's right edge; otherwise inside its top-right corner.
				const left =
					!root || r.left - root.left >= size + 4
						? r.left - size - 4
						: r.right + size + 4 <= root.right
							? r.right + 4
							: r.right - size;
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
			if (active?.isConnected && !waiting && !isCollapsed(active) && getComputedStyle(active).visibility !== "hidden") {
				const r = visibleRect(active);
				highlight.style.transform = `translate(${Math.round(r.left - 6)}px, ${Math.round(r.top - 2)}px)`;
				highlight.style.width = `${Math.round(r.width + 12)}px`;
				highlight.style.height = `${Math.round(r.height + 4)}px`;
				highlight.style.opacity = "1";
			} else {
				highlight.style.opacity = "0";
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

/** The player — rendered only while something is reading. Placement is
 *  the caller's (className): the chat anchors it to the dock's top edge. */
export function ListenPill({ className }: { className?: string }) {
	const { controller } = useListen();
	const s = useListenSnapshot();
	if (!controller || s.status === "idle") return null;
	const nextRate = LISTEN_RATES[(LISTEN_RATES.indexOf(s.rate as (typeof LISTEN_RATES)[number]) + 1) % LISTEN_RATES.length]!;
	return (
		<div
			data-testid="listen-pill"
			role="group"
			aria-label="Listening"
			className={cn(
				"pointer-events-auto flex max-w-full items-center gap-1 rounded-full border bg-card py-1 pl-3 pr-1 font-ui text-xs shadow-lg",
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
						aria-label={`Speed ${s.rate}×, change to ${nextRate}×`}
						data-testid="listen-rate"
						className={cn(pillButton, "w-auto px-1.5 tabular-nums")}
						onClick={() => controller.setRate(nextRate)}
					>
						{s.rate.toFixed(1)}×
					</button>
				</>
			)}
			<button type="button" aria-label="Stop listening (Esc)" data-testid="listen-stop" className={pillButton} onClick={() => controller.stop()}>
				<XIcon className="size-3.5" />
			</button>
		</div>
	);
}
