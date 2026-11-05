import React, { act, useEffect, useRef, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts";
import { ListenPill, ListenProvider, useListen } from "../components/listen/listen";
import type { ListenController } from "../components/listen/listen-controller";
import { QuestionDock } from "../components/question-dock";
import { PracticeDock } from "../components/practice-dock";
import { AnsweredCard } from "../components/answered-card";
import { escAbortTarget, listenDockOpen, type EscAbortTarget } from "../components/chat";
import { setDictationActive } from "../components/dictation-state";
import { LISTEN_DOCK_CLOSED_ATTR, LISTEN_OPEN_DOCK_EVENT, listenSourceProps } from "../components/listen/speech-dom";
import { buildAnswer, type QuestionAnswerData, type QuizToolInput } from "../src/core/question-core";
import type { SpeechSettings } from "../src/core";
import { FakeAudio, replaceProperties } from "./helpers/browser";

/**
 * Listening keyboard controls, mounted with real components:
 * the app's KeyboardShortcuts dispatcher, the ListenProvider and its
 * player, the real question dock and answer card, and Chat's layered-Esc gate (its
 * window listener, reproduced here around the real escAbortTarget — Chat
 * itself has no render harness). Keys go to whatever holds focus, the
 * way a browser routes them. No real audio, provider, or network: speech
 * requests are counted and answered in memory.
 */
describe("the listening keyboard surface", () => {
	const dom = parseHTML("<html><body></body></html>");
	let restore: (() => void)[] = [];
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let controller: ListenController | null;
	let listenApi: ReturnType<typeof useListen>;
	let prefs: Record<string, unknown>;
	let spoken: string[];
	let stored: Map<string, string>;
	let escTargets: EscAbortTarget[];
	let gate: { pending: boolean; busy: boolean };
	let scrolled: Element[];
	/** Requests the player made to open a folded dock. */
	let openRequests: number;
	let focused: Element | null;
	let rects: Map<string, { top: number; height: number }>;

	before(async () => {
		restore = [replaceProperties(globalThis, {
			React, window: dom.window, document: dom.document,
			Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
			Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
			MutationObserver: dom.window.MutationObserver,
			IS_REACT_ACT_ENVIRONMENT: true,
			localStorage: {
				getItem: (k: string) => stored.get(k) ?? null,
				setItem: (k: string, v: string) => { stored.set(k, v); },
				removeItem: (k: string) => { stored.delete(k); },
			},
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				frames.set(++frameId, callback);
				return frameId;
			},
			cancelAnimationFrame: (id: number) => frames.delete(id),
			getComputedStyle: (element: HTMLElement) => ({ visibility: "visible", display: "block", opacity: element.style.opacity || "1" }),
			Audio: FakeAudio,
			fetch: async (_url: unknown, init?: RequestInit) => {
				if (init?.method === "POST") {
					const { parts } = JSON.parse(String(init.body)) as { parts: { text?: string }[] };
					spoken.push(parts.map((p) => p.text ?? "").join("").trim());
					return new Response(new Blob(["mp3"]));
				}
				return Response.json(prefs);
			},
		}), replaceProperties(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => {} })];
		// React's input-event detection (a browser has document.oninput).
		Object.assign(dom.document, { oninput: null });
		// Focus, as a browser moves it: focusout carries where it went.
		Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused ?? dom.document.body });
		const proto = dom.window.HTMLElement.prototype as HTMLElement;
		proto.focus = function (this: HTMLElement) {
			if (focused === this) return;
			const was = focused;
			focused = this;
			if (was) was.dispatchEvent(Object.assign(new dom.window.Event("focusout", { bubbles: true }), { relatedTarget: this }));
		};
		proto.blur = function (this: HTMLElement) {
			if (focused !== this) return;
			focused = null;
			this.dispatchEvent(Object.assign(new dom.window.Event("focusout", { bubbles: true }), { relatedTarget: null }));
		};
		const elementProto = dom.window.Element.prototype as Element;
		elementProto.scrollIntoView = function (this: Element) { scrolled.push(this); };
		elementProto.getBoundingClientRect = function (this: Element) {
			const r = rects.get(this.id) ?? { top: 0, height: 0 };
			return { left: 40, right: 440, width: 400, top: r.top, bottom: r.top + r.height, height: r.height, x: 40, y: r.top } as DOMRect;
		};
		({ createRoot } = await import("react-dom/client"));
	});
	after(() => {
		for (const undo of restore) undo();
	});

	const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

	/** Chat's lh:kbd-abort-turn listener around the real escAbortTarget:
	 *  the question and turn stand in as flags; their actions are recorded. */
	function EscGate() {
		const listen = useListen();
		const ref = useRef(listen);
		ref.current = listen;
		useEffect(() => {
			const onAbort = () => {
				const api = ref.current;
				const target = escAbortTarget({
					abortAsk: false, mermaidFocus: false, planOpen: false, setupOpen: false,
					listening: api.claimsEscape(),
					pending: gate.pending, problem: false, busy: gate.busy,
				});
				escTargets.push(target);
				if (target === "listen") api.dismiss();
			};
			window.addEventListener("lh:kbd-abort-turn", onAbort);
			return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
		}, []);
		return null;
	}

	/** A surfaced popup that claims its own Esc at the document, as the
	 *  plan popup and session overlays do. */
	function Popup({ onClose }: { onClose: () => void }) {
		useEffect(() => {
			const onKey = (e: KeyboardEvent) => {
				if (e.key !== "Escape") return;
				e.stopPropagation();
				onClose();
			};
			document.addEventListener("keydown", onKey);
			return () => document.removeEventListener("keydown", onKey);
		}, [onClose]);
		return <div role="dialog" aria-modal="true" data-testid="popup">Plan</div>;
	}

	const QUIZ = { question: "Which is right?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "Yes." } as unknown as QuizToolInput;

	interface Scene { paragraphs?: { id: string; text: string; key?: string; source?: string; part?: string }[]; answer?: QuestionAnswerData; question?: boolean; onAnswer?: () => void; practice?: { expanded: boolean }; folded?: { kind: "question" | "practice"; reveal?: boolean }; collapsed?: boolean; popup?: () => void; transcriptKey?: string }
	const PARAGRAPHS = [
		{ id: "t1", text: "First paragraph." },
		{ id: "t2", text: "Second paragraph." },
		{ id: "t3", text: "Third paragraph." },
	];
	let submitted: number;

	function Session({ paragraphs = PARAGRAPHS, answer, question = false, onAnswer, practice, folded, collapsed = true, popup, transcriptKey = "transcript" }: Scene) {
		listenApi = useListen();
		controller = listenApi.controller;
		// A folded dock, wired the way Chat's DockOverlay wires it around the
		// real listenDockOpen: the closed marker on the dock root, and the
		// player's open request handled as the bar's click.
		const [open, setOpen] = useState(false);
		const dockOpen = folded ? listenDockOpen({ expanded: open, question: folded.kind === "question", practice: folded.kind === "practice" }) : null;
		const dockOpenRef = useRef(dockOpen);
		dockOpenRef.current = dockOpen;
		useEffect(() => {
			const onOpen = () => {
				openRequests++;
				if (dockOpenRef.current) setOpen(true);
			};
			window.addEventListener(LISTEN_OPEN_DOCK_EVENT, onOpen);
			return () => window.removeEventListener(LISTEN_OPEN_DOCK_EVENT, onOpen);
		}, []);
		const paragraph = (p: NonNullable<Scene["paragraphs"]>[number]) => p.source
			? <div key={p.key ?? p.id} data-source-message-id={p.source} {...listenSourceProps("text", p.part)}><p id={p.id}>{p.text}</p></div>
			: <p key={p.key ?? p.id} id={p.id}>{p.text}</p>;
		return (
			<>
				<div key={transcriptKey} data-listen-root="transcript">
					{paragraphs.slice(0, 2).map(paragraph)}
					{collapsed && <details><summary>Tool call</summary><p id="hidden">Collapsed detail.</p></details>}
					{paragraphs.slice(2).map(paragraph)}
					{answer && <AnsweredCard answer={answer} />}
				</div>
				<div data-listen-root="dock" id="dock" {...(dockOpen ? { [LISTEN_DOCK_CLOSED_ATTR]: "" } : {})}>
					{folded?.kind === "question" ? (
						<QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded={open} reveal={!!folded.reveal && !open} onExpand={() => setOpen(true)} onSubmit={() => { submitted++; }} dictationClaim={false} />
					) : folded?.kind === "practice" ? (
						<PracticeDock problemCallId="p1" input={{ statement: "Practice statement." }} expanded={open} onExpand={() => setOpen(true)} onSubmit={() => { submitted++; }} />
					) : practice ? (
						<PracticeDock problemCallId="p1" input={{ statement: "Practice statement." }} expanded={practice.expanded} onExpand={() => {}} onSubmit={() => { submitted++; }} />
					) : question ? (
						<QuestionDock toolName="quiz" toolCallId="q1" input={QUIZ} expanded onExpand={() => {}} onSubmit={() => { submitted++; onAnswer?.(); }} dictationClaim={false} />
					) : (
						<form data-testid="composer"><textarea data-file-path-input="" id="composer" /></form>
					)}
				</div>
				<ListenPill />
				<EscGate />
				{popup && <Popup onClose={popup} />}
			</>
		);
	}

	async function mount(scene: Scene = {}) {
		await act(async () => root.render(
			<AppRouterContext.Provider value={router as never}>
				<KeyboardShortcuts />
				<ListenProvider initialSpeech={{ enabled: prefs.configured === true } as SpeechSettings}>
					<Session {...scene} />
				</ListenProvider>
			</AppRouterContext.Provider>,
		));
		await settle();
	}

	async function settle() {
		for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	}

	/** A keydown where focus is, bubbling to the document and window. */
	async function press(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
		const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
			key, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, metaKey: false, altKey: false,
		});
		await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
		await settle();
		return event as unknown as KeyboardEvent;
	}
	const focusListening = () => press("L", { ctrl: true, shift: true });
	/** Focus moved by the learner (a click into a field or a row). */
	const focusOn = (selector: string) => act(async () => { ($(selector) as HTMLElement).focus(); });

	const $ = (selector: string) => document.querySelector(selector);
	const surface = () => $('[data-testid="listen-surface"]') as HTMLElement | null;
	const status = () => $('[data-testid="listen-selection-status"]')?.textContent ?? null;
	const reading = () => controller!.getSnapshot();
	const element = () => controller!.element as unknown as FakeAudio;
	function frame() {
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(0);
	}

	beforeEach(() => {
		prefs = { configured: true };
		spoken = [];
		stored = new Map();
		escTargets = [];
		gate = { pending: false, busy: false };
		scrolled = [];
		openRequests = 0;
		focused = null;
		rects = new Map();
		submitted = 0;
		controller = null;
		setDictationActive(false);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		await settle();
		host.remove();
		frames.clear();
		setDictationActive(false);
	});

	it("one bubbling Enter submits a dock answer once and keeps its reply armed", async () => {
		await mount({ question: true, onAnswer: () => {
			void listenApi.startTurn(() => Promise.resolve(submitted === 1));
		} });
		controller!.autoplay = true;
		await press("ArrowDown");
		await press(" ");
		await press("Enter");
		assert.equal(submitted, 1, "the document and window must not both submit");
		assert.equal(controller!.pendingAutoplay, true, "no refused duplicate cancels the accepted reply");
	});

	it("defaults to no Escape claim without a provider", async () => {
		function Probe() { listenApi = useListen(); return null; }
		await act(async () => root.render(<Probe />));
		assert.equal(listenApi.claimsEscape(), false);
		assert.equal(await listenApi.startTurn(() => Promise.resolve(true)), true);
	});

	it("claims live arms and idle surfaces, and disarms refused turns", async () => {
		await mount();
		controller!.autoplay = true;
		controller!.armAutoplay();
		assert.equal(listenApi.claimsEscape(), true);
		controller!.disarmAutoplay();
		assert.equal(await listenApi.startTurn(() => {
			assert.equal(controller!.pendingAutoplay, true);
			return Promise.resolve(false);
		}), false);
		assert.equal(controller!.pendingAutoplay, false);
		await focusListening();
		assert.equal(reading().status, "idle");
		assert.equal(listenApi.claimsEscape(), true);
		listenApi.dismiss();
		await act(async () => controller!.playFrom($("#t1")!));
		assert.notEqual(reading().status, "idle");
		assert.equal(listenApi.claimsEscape(), true);
	});

	it("Cmd/Ctrl+Shift+L from the composer focuses the idle player without speaking", async () => {
		await mount();
		assert.equal(surface(), null, "idle, the player is hidden");
		await focusOn("#composer");
		const shortcut = await focusListening();
		assert.equal(shortcut.defaultPrevented, true, "the shortcut also claims the browser default");
		assert.equal(document.activeElement, surface(), "the player holds focus");
		assert.equal(surface()?.getAttribute("aria-label"), "Listening");
		assert.equal($('[data-testid="listen-hint"]')?.textContent, "↑↓ select · Enter read · Space pause · ←→ step · S speed · Esc stop");
		assert.equal(status(), "Reading: First paragraph.", "the first transcript block, announced");
		assert.equal(reading().status, "idle");
		assert.deepEqual(spoken, [], "entry synthesizes nothing");
		frame();
		assert.equal(($('[data-testid="listen-selection"]') as HTMLElement).style.opacity, "1", "the selection is outlined");
		assert.equal(($('[data-testid="listen-highlight"]') as HTMLElement).style.opacity, "0", "apart from the (idle) playback highlight");
	});

	it("is a registry action: listed in the cheat sheet, rebindable through the key map", async () => {
		stored.set("lh:keymap", JSON.stringify({ "focus-listening": "mod+shift+y" }));
		await mount();
		await press("?");
		const sheet = $('[data-testid="cheat-sheet"]')!;
		assert.match(sheet.textContent!, /Focus listening/);
		assert.match(sheet.textContent!, /Listening · read from selection/, "the surface's keys are listed too");
		await press("Escape");
		await focusListening();
		assert.equal(surface(), null, "the default chord no longer fires once rebound");
		await press("Y", { ctrl: true, shift: true });
		assert.equal(document.activeElement, surface());
	});

	const EXPLAIN = buildAnswer({
		id: "e1", kind: "explain", question: "Explain the bandwidth-delay product.", mode: "text", options: [],
		committedAnswer: "Bandwidth times round-trip time.", createdAt: "fixture",
	}, { text: "My attempt." }, "explain");

	it("does nothing while Listening is off", async () => {
		prefs = { configured: false };
		await mount({ answer: EXPLAIN });
		assert.equal($('[data-testid="listen-compare"]'), null, "nor offers to compare answers");
		await focusOn("#composer");
		await focusListening();
		assert.equal(surface(), null);
		assert.equal(document.activeElement, $("#composer"), "focus stays put");
		assert.deepEqual(spoken, []);
	});

	for (const live of [false, true]) it(`Compare answers reads both answers in order (turn live: ${live})`, async () => {
		await mount({ answer: EXPLAIN });
		await act(async () => controller!.setLive(live));
		await act(async () => ($('[data-testid="listen-compare"]') as HTMLButtonElement).click());
		await settle();
		assert.deepEqual(spoken, ["“My attempt.”", "The answer: Bandwidth times round-trip time."], "the committed answer prefetches");
		assert.equal(reading().label, "Your answer");
		assert.deepEqual(reading().position, { index: 0, total: 2 });
		await act(async () => element().end());
		await settle();
		assert.equal(reading().label, "The answer");
		assert.deepEqual(reading().position, { index: 1, total: 2 });
		await act(async () => element().end());
		await settle();
		assert.equal(reading().status, "idle");
		assert.equal(spoken.length, 2, "each answer is synthesized once");
	});

	it("browses readable blocks with ↑/↓, clamped, skipping collapsed content, without audio", async () => {
		await mount();
		await focusListening();
		await press("ArrowUp");
		assert.equal(status(), "Reading: First paragraph.", "clamped at the start");
		await press("ArrowDown");
		assert.equal(status(), "Reading: Second paragraph.");
		await press("ArrowDown");
		assert.equal(status(), "Reading: Third paragraph.", "the collapsed detail is never selected");
		await press("ArrowDown");
		assert.equal(status(), "Reading: Third paragraph.", "clamped at the end: a composer dock has nothing to read");
		assert.equal(openRequests, 0, "no folded dock: nothing is asked to open");
		assert.equal(reading().status, "idle");
		assert.deepEqual(spoken, [], "browsing synthesizes nothing");
	});

	it("starts on the first transcript block on screen, scrolling only the transcript when browsing", async () => {
		dom.window.innerHeight = 800;
		rects.set("t1", { top: -120, height: 24 });
		rects.set("t2", { top: 100, height: 24 });
		rects.set("t3", { top: 900, height: 24 });
		rects.set("dock", { top: 600, height: 120 });
		prefs = { configured: true, readQuestion: true };
		await mount({ question: true });
		await focusListening();
		assert.equal(status(), "Reading: Second paragraph.", "the first block on screen, not the first in the transcript");
		assert.equal(scrolled.length, 0, "entry scrolls nothing");
		await press("ArrowDown");
		assert.equal(status(), "Reading: Third paragraph.");
		assert.deepEqual(scrolled.map((el) => el.id), ["t3"], "an off-screen transcript block is brought into view");
		await press("ArrowDown");
		assert.match(status()!, /^Question: Which is right\?/, "Read the question on: browsing crosses into the dock");
		await press("ArrowDown");
		assert.match(status()!, /^Options:/);
		await press("ArrowDown");
		assert.match(status()!, /^Options:/, "clamped at the dock's end");
		assert.deepEqual(scrolled.map((el) => el.id), ["t3"], "the dock is never scrolled");
		await press("ArrowUp");
		await press("ArrowUp");
		assert.equal(status(), "Reading: Third paragraph.", "back up into the transcript, as Previous crosses");
		assert.deepEqual(spoken, []);
	});

	for (const reveal of [false, true]) {
		it(`↓ past the last block opens a folded question${reveal ? " behind its teach reveal" : ""} and selects its first block, Read the question off`, async () => {
			await mount({ folded: { kind: "question", reveal } });
			assert.ok($(reveal ? '[data-testid="teach-check-reveal"]' : '[data-testid="question-dock-bar"]'), "starts folded into its bar");
			assert.equal($("#dock")!.hasAttribute(LISTEN_DOCK_CLOSED_ATTR), true);
			await focusListening();
			await press("ArrowDown");
			await press("ArrowDown");
			assert.equal(status(), "Reading: Third paragraph.");
			assert.equal(openRequests, 0, "browsing the transcript opens nothing");
			await press("ArrowDown");
			assert.match(status()!, /^Question: Which is right\?/, "the dock's first readable block");
			assert.equal(openRequests, 1, "asked to open exactly once");
			assert.equal($('[data-testid="question-dock-bar"]') ?? $('[data-testid="teach-check-reveal"]'), null, "opened, as a click on its bar does");
			assert.equal($("#dock")!.hasAttribute(LISTEN_DOCK_CLOSED_ATTR), false);
			assert.ok(surface()!.contains(document.activeElement), "focus stays on the player");
			await press("ArrowDown");
			assert.match(status()!, /^Options:/);
			assert.equal(openRequests, 1, "moving within the dock asks nothing more");
			await press("ArrowUp");
			await press("ArrowUp");
			assert.equal(status(), "Reading: Third paragraph.", "↑ from the dock's first block returns to the transcript's last");
			assert.deepEqual(spoken, [], "browsing synthesizes nothing");
		});
	}

	it("↓ past the last block opens a folded practice problem; Enter reads the opened statement", async () => {
		await mount({ folded: { kind: "practice" } });
		assert.ok($('[data-testid="practice-dock-bar"]'));
		await focusListening();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("ArrowDown");
		assert.equal(status(), "Problem: Practice statement.");
		assert.equal(openRequests, 1);
		assert.equal($('[data-testid="practice-dock-bar"]'), null, "the practice problem opened");
		assert.ok($('[data-testid="practice-dock"]'));
		await press("Enter");
		assert.equal(spoken[0], "Practice statement.", "the selection followed the statement into the opened form");
		assert.equal(submitted, 0);
	});

	it("an open dock is entered without an open request, Read the question off; ↑ returns from a dock read", async () => {
		await mount({ question: true });
		await focusListening();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("ArrowDown");
		assert.match(status()!, /^Question: Which is right\?/);
		assert.equal(openRequests, 0, "nothing to open");
		await press("Escape");
		await act(async () => controller!.playFrom($('[data-listen-block="Question"]')!));
		await settle();
		await focusListening();
		assert.match(status()!, /^Question:/, "the selection starts on what is reading, in the dock");
		await press("ArrowUp");
		assert.equal(status(), "Reading: Third paragraph.", "↑ crosses back even when browsing started in the dock");
	});

	it("an initial dock selection stays in the dock", async () => {
		prefs = { configured: true, readQuestion: true };
		await mount({ paragraphs: [], collapsed: false, question: true });
		await focusListening();
		assert.match(status()!, /^Question:/, "no transcript blocks: the dock's first");
		await press("ArrowUp");
		assert.match(status()!, /^Question:/);
		await press("ArrowDown");
		await press("ArrowDown");
		assert.match(status()!, /^Options:/);
	});

	it("Enter reads from the selection; the selection starts on what is reading", async () => {
		await mount();
		await focusListening();
		await press("ArrowDown");
		await press("Enter");
		assert.equal(spoken[0], "Second paragraph.", "Read from here at the selection (the next block prefetches)");
		assert.equal(reading().status, "playing");
		await press("Escape");
		assert.equal(reading().status, "idle");
		await act(async () => controller!.playFrom($("#t3")!));
		await settle();
		const requests = spoken.length;
		await focusListening();
		assert.equal(status(), "Reading: Third paragraph.", "the block reading");
		assert.equal(spoken.length, requests, "entering does not restart it");
	});

	it("Enter resolves an independently browsed selection after settlement replaces its node", async () => {
		await mount();
		await focusListening();
		await press("ArrowDown");
		const old = $("#t2")!;
		await mount({ paragraphs: [PARAGRAPHS[0]!, { ...PARAGRAPHS[1]!, key: "server-t2" }, PARAGRAPHS[2]!] });
		assert.equal(old.isConnected, false);
		assert.deepEqual(spoken, [], "the selection has not started playback");
		await press("Enter");
		assert.equal(spoken[0], "Second paragraph.");
	});

	it("browsing resolves a replaced growing selection before stepping from it", async () => {
		await mount();
		await focusListening();
		await press("ArrowDown");
		await mount({ paragraphs: [PARAGRAPHS[0]!, { id: "t2", key: "server-t2", text: "Second paragraph. More text." }, PARAGRAPHS[2]!] });
		await press("ArrowDown");
		assert.equal(status(), "Reading: Third paragraph.", "step from the replacement, not from the first visible block");
		await press("ArrowUp");
		await press("Enter");
		assert.equal(spoken[0], "Second paragraph. More text.");
	});

	for (const disclose of [false, true]) {
		it(`growing replacement stays in its source despite identical history (disclosure ${disclose})`, async () => {
			const paragraphs = [
				{ id: "t1", text: "Repeated paragraph.", source: "history" },
				{ ...PARAGRAPHS[1]!, source: "middle" },
				{ id: "t3", text: "Repeated paragraph.", source: "client-reply" },
			];
			await mount({ paragraphs });
			await focusListening();
			await press("ArrowDown");
			await press("ArrowDown");
			await mount({ paragraphs: [...paragraphs.slice(0, 2), { id: "t3", key: "settled-reply", source: "server-reply", text: "Repeated paragraph. New reply text." }] });
			if (disclose) $("details")!.setAttribute("open", "");
			await press("Enter");
			assert.equal(spoken[0], "Repeated paragraph. New reply text.", "never restart from the identical historical paragraph");
		});
	}

	it("browsing a growing replacement starts from its source after history disclosure", async () => {
		const paragraphs = [
			{ id: "t1", text: "Repeated paragraph.", source: "history" },
			{ ...PARAGRAPHS[1]!, source: "middle" },
			{ id: "t3", text: "Repeated paragraph.", source: "client-reply" },
		];
		await mount({ paragraphs });
		await focusListening();
		await press("ArrowDown");
		await press("ArrowDown");
		await mount({ paragraphs: [...paragraphs.slice(0, 2), { id: "t3", key: "settled-reply", source: "server-reply", text: "Repeated paragraph. New reply text." }] });
		$("details")!.setAttribute("open", "");
		await press("ArrowUp");
		assert.equal(status(), "Reading: Collapsed detail.", "browse backward from the reply, not identical history");
		await press("ArrowDown");
		await press("Enter");
		assert.equal(spoken[0], "Repeated paragraph. New reply text.");
	});

	for (const parts of [false, true]) {
		for (const replaceRoot of [false, true]) {
			it(`shared-message passages retain the second selection (part ids ${parts}, root replacement ${replaceRoot})`, async () => {
				const paragraphs = [
					{ id: "t1", text: "Repeated paragraph. Earlier continuation.", source: "message", part: parts ? "message-t0" : undefined },
					{ id: "t2", text: "Repeated paragraph.", source: "message", part: parts ? "message-t1" : undefined },
					PARAGRAPHS[2]!,
				];
				await mount({ paragraphs });
				await focusListening();
				await press("ArrowDown");
				await mount({ paragraphs: [paragraphs[0]!, { ...paragraphs[1]!, key: "settled-t2", text: "Repeated paragraph. Current continuation." }, paragraphs[2]!], transcriptKey: replaceRoot ? "settled-transcript" : undefined });
				await press("Enter");
				assert.equal(spoken[0], "Repeated paragraph. Current continuation.");
			});
		}
	}

	it("distinct text parts in a replaced root remain readable at the selected part", async () => {
		const paragraphs = [
			{ ...PARAGRAPHS[0]!, source: "message", part: "message-t0" },
			{ ...PARAGRAPHS[1]!, source: "message", part: "message-t1" },
			PARAGRAPHS[2]!,
		];
		await mount({ paragraphs });
		await focusListening();
		await press("ArrowDown");
		await mount({ paragraphs, transcriptKey: "settled-root" });
		await press("ArrowUp");
		assert.equal(status(), "Reading: First paragraph.");
		await press("ArrowDown");
		await press("Enter");
		assert.equal(spoken[0], "Second paragraph.");
	});

	it("a selection that becomes unspoken cannot be started with Enter", async () => {
		await mount();
		await focusListening();
		await press("ArrowDown");
		$("#t2")!.setAttribute("data-listen-skip", "");
		await press("Enter");
		assert.deepEqual(spoken, []);
	});

	it("Enter on a block still streaming waits, and entry selects the waited-for block", async () => {
		await mount();
		await act(async () => controller!.setLive(true));
		await focusListening();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("Enter");
		assert.equal(reading().status, "waiting", "the last block is unfinished while the turn is live");
		assert.deepEqual(spoken, []);
		await press("Escape");
		assert.equal(reading().status, "idle");
		// Waiting again, entered fresh: the pending block is the selection.
		await act(async () => controller!.playFrom($("#t3")!));
		await settle();
		await focusListening();
		assert.equal(status(), "Reading: Third paragraph.");
		await act(async () => controller!.setLive(false));
		await settle();
		assert.deepEqual(spoken, ["Third paragraph."], "read once the turn ends");
	});

	it("← from a waiting selection the re-render replaced selects and reads the block before it", async () => {
		await mount();
		await act(async () => controller!.setLive(true));
		await focusListening();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("Enter");
		assert.equal(reading().status, "waiting");
		await mount({ paragraphs: [PARAGRAPHS[0]!, PARAGRAPHS[1]!, { id: "t3", key: "t3-again", text: "Third paragraph, still streaming." }] });
		await press("ArrowLeft");
		assert.deepEqual(spoken, ["Second paragraph."], "Previous from the waited-for block");
		assert.equal(status(), "Reading: Second paragraph.", "the selection follows the player");
		await press("ArrowRight");
		assert.equal(reading().status, "waiting", "Next onto the unfinished block waits again");
		assert.equal(status(), "Reading: Third paragraph, still streaming.");
		assert.deepEqual(spoken, ["Second paragraph."]);
	});

	for (const previous of [false, true]) {
		it(`waiting retains the text part through replacement and earlier disclosure (Previous ${previous})`, async () => {
			const paragraphs = [
				{ ...PARAGRAPHS[0]!, source: "history", part: "history-t0" },
				{ ...PARAGRAPHS[1]!, source: "history", part: "history-t1" },
				{ ...PARAGRAPHS[2]!, source: "client-reply", part: "client-reply-t0" },
			];
			await mount({ paragraphs });
			await act(async () => controller!.setLive(true));
			await focusListening();
			await press("ArrowDown");
			await press("ArrowDown");
			await press("Enter");
			assert.equal(reading().status, "waiting");
			await mount({ paragraphs: [...paragraphs.slice(0, 2), { id: "t3", key: "settled-reply", source: "server-reply", part: "server-reply-t0", text: "Third paragraph. More reply." }] });
			$("details")!.setAttribute("open", "");
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
			assert.equal(controller!.pendingBlock()?.id, "t3", "the historical brief cannot become the pending selection");
			assert.deepEqual(spoken, [], "the intended last block is still unfinished");
			if (previous) {
				await press("ArrowLeft");
				assert.equal(spoken[0], "Collapsed detail.", "Previous steps from the intended reply");
			} else {
				await act(async () => controller!.setLive(false));
				await settle();
				assert.equal(spoken[0], "Third paragraph. More reply.", "automatic waiting recovery resumes the intended reply");
			}
		});
	}

	for (const expanded of [false, true]) {
		it(`practice playback survives ${expanded ? "folding" : "expanding"} and Previous returns to the transcript`, async () => {
			prefs.readQuestion = true;
			await mount({ practice: { expanded } });
			await act(async () => controller!.playFrom($("#t3")!));
			await settle();
			await act(async () => controller!.next());
			await settle();
			assert.equal(reading().block?.getAttribute("data-listen-problem"), "p1");
			await mount({ practice: { expanded: !expanded } });
			await act(async () => { controller!.activeBlock(); });
			assert.equal(reading().block?.isConnected, true);
			assert.equal(reading().block?.getAttribute("data-listen-problem"), "p1");
			if (!expanded) {
				frame();
				assert.equal(($('[data-testid="listen-highlight"]') as HTMLElement).style.opacity, "1", "opening locates the current statement highlight");
			}
			await act(async () => controller!.prev());
			await settle();
			assert.equal(reading().block?.id, "t3");
		});

		it(`a selected practice statement survives ${expanded ? "folding" : "expanding"} before Enter`, async () => {
			prefs.readQuestion = true;
			await mount({ practice: { expanded } });
			await focusListening();
			await press("ArrowDown");
			await press("ArrowDown");
			await press("ArrowDown");
			assert.equal(status(), "Problem: Practice statement.");
			await mount({ practice: { expanded: !expanded } });
			await press("Enter");
			assert.equal(spoken[0], "Practice statement.");
			assert.equal(submitted, 0, "the player's Enter never submits the practice field");
		});
	}

	it("←/→ do nothing with no queue; Space pauses and resumes; S steps the speed ladder and persists", async () => {
		await mount();
		await focusListening();
		await press("ArrowRight");
		await press("ArrowLeft");
		assert.equal(reading().status, "idle");
		assert.equal(status(), "Reading: First paragraph.");
		await press(" ");
		assert.equal(reading().status, "idle", "Space is a no-op while idle");
		await press("Enter");
		assert.equal(reading().status, "playing");
		await press(" ");
		assert.equal(reading().status, "paused");
		assert.equal(element().paused, true, "the clip itself pauses");
		await press(" ");
		assert.equal(reading().status, "playing");
		assert.equal(element().paused, false, "and resumes");
		await press("s");
		assert.equal(reading().rate, 1.2);
		assert.equal(stored.get("lh:listen-rate"), "1.2");
		for (const rate of [1.4, 1.6, 1.8, 2, 0.8]) {
			await press("S");
			assert.equal(reading().rate, rate);
		}
		assert.equal(stored.get("lh:listen-rate"), "0.8", "wraps to the slowest and persists on this device");
	});

	it("Esc stops reading and an armed autoplay, leaves, and restores focus — never the question or turn", async () => {
		gate = { pending: true, busy: true };
		await mount({ question: true });
		const row = $('[data-kbdrow="0"]') as HTMLElement;
		await focusOn('[data-kbdrow="0"]');
		await focusListening();
		await press("Enter");
		assert.equal(reading().status, "playing");
		controller!.autoplay = true;
		controller!.armAutoplay();
		assert.equal(controller!.pendingAutoplay, true);
		await press("Escape");
		assert.deepEqual(escTargets, ["listen"], "claimed before the question and turn");
		assert.equal(reading().status, "idle");
		assert.equal(element().paused, true, "the clip is silenced");
		assert.equal(controller!.pendingAutoplay, false, "autoplay is disarmed");
		assert.equal(surface(), null, "the idle player leaves");
		assert.equal(document.activeElement, row, "focus returns to where it was");
		assert.equal(submitted, 0);
	});

	it("Esc on the idle focused player only leaves it; the next Esc reaches the question", async () => {
		gate = { pending: true, busy: false };
		await mount({ question: true });
		await focusListening();
		await press("Escape");
		assert.deepEqual(escTargets, ["listen"]);
		assert.equal(surface(), null);
		assert.equal(document.activeElement, document.body, "nothing was focused before: focus is released");
		await press("Escape");
		assert.deepEqual(escTargets, ["listen", "question"], "only now the question's own Esc");
	});

	it("Esc falls back to the composer when there was no prior focused control", async () => {
		await mount();
		await focusListening();
		await press("Escape");
		assert.equal(document.activeElement, $("#composer"));
	});

	it("Esc falls back to the composer when the prior focus is gone", async () => {
		await mount({ question: true });
		await focusOn('[data-kbdrow="0"]');
		await focusListening();
		await mount({ question: false });
		await press("Escape");
		assert.equal(document.activeElement, $("#composer"));
	});

	it("the surface owns its keys: the question rows and Enter-to-submit never also act", async () => {
		await mount({ question: true });
		await act(async () => { ($('[data-kbdrow="0"]') as HTMLButtonElement).click(); });
		await focusListening();
		const before = status();
		await press("ArrowDown");
		assert.notEqual(status(), before, "listening browsed");
		assert.ok(!$('[data-kbdrow="1"]')!.className.includes("bg-accent/40"), "the question rows did not walk");
		await press("Enter");
		assert.equal(submitted, 0, "Enter read instead of submitting the answer");
		assert.equal(spoken[0], "Second paragraph.");
	});

	it("keys outside the surface keep their owners; focusing elsewhere leaves without stopping", async () => {
		await mount({ question: true });
		await focusListening();
		await press("Enter");
		assert.equal(reading().status, "playing");
		const selection = status();
		await focusOn('[data-kbdrow="0"]');
		assert.equal(surface()?.querySelector('[data-testid="listen-hint"]') ?? null, null, "focus moved away: the surface left");
		assert.equal(reading().status, "playing", "leaving is not stopping");
		await press("ArrowDown");
		assert.ok($('[data-kbdrow="0"]')!.className.includes("bg-accent/40"), "the question rows walk again");
		await press("s");
		await press(" ");
		assert.equal(reading().rate, 1, "bare keys outside the player are not listening's");
		assert.equal(reading().status, "playing");
		await mount({ question: false });
		await focusOn("#composer");
		for (const key of ["ArrowUp", "s", " "]) await press(key);
		assert.equal(reading().rate, 1);
		assert.equal(reading().status, "playing");
		assert.ok(selection);
	});

	it("an open overlay owns the shortcut and the keys, and closes before listening on Esc", async () => {
		let closed = 0;
		const close = () => { closed++; };
		await mount();
		await focusListening();
		await press("Enter");
		await mount({ popup: close });
		await press("ArrowDown");
		assert.equal(status(), "Reading: First paragraph.", "the overlay owns the arrows");
		await press("Escape");
		assert.equal(closed, 1, "the overlay closed first");
		assert.deepEqual(escTargets, [], "its Esc reached nothing below");
		assert.equal(reading().status, "playing");
		await mount();
		assert.ok(surface()?.querySelector('[data-testid="listen-hint"]'), "the surface is still focused");
		await press("Escape");
		assert.deepEqual(escTargets, ["listen"]);
		assert.equal(reading().status, "idle");
		// With an overlay up, the shortcut does not enter.
		await mount({ popup: () => {} });
		await focusListening();
		assert.equal(surface(), null);
	});

	it("a fading-in dialog already owns the shortcut", async () => {
		await mount({ popup: () => {} });
		($("[role='dialog']") as HTMLElement).style.opacity = "0";
		await focusListening();
		assert.equal(surface(), null);
		assert.deepEqual(spoken, []);
	});

	it("the cheat sheet and a live dictation take Esc first", async () => {
		let cancelled = 0;
		const onCancel = () => { cancelled++; };
		window.addEventListener("lh:kbd-cancel-dictation", onCancel);
		try {
			await mount();
			await focusListening();
			await press("Enter");
			await press("?");
			assert.ok($('[data-testid="cheat-sheet"]'), "? still opens the cheat sheet");
			await press("ArrowDown");
			assert.equal(status(), "Reading: First paragraph.", "the cheat sheet owns the arrows");
			await press("Escape");
			assert.equal($('[data-testid="cheat-sheet"]'), null);
			assert.equal(reading().status, "playing");
			setDictationActive(true);
			await press("Escape");
			assert.equal(cancelled, 1, "dictation cancelled first");
			assert.equal(reading().status, "playing");
			assert.deepEqual(escTargets, []);
			setDictationActive(false);
			await press("Escape");
			assert.deepEqual(escTargets, ["listen"]);
			assert.equal(reading().status, "idle");
		} finally {
			window.removeEventListener("lh:kbd-cancel-dictation", onCancel);
		}
	});

	it("leaving the session tears the surface down and stops reading", async () => {
		await mount();
		await focusListening();
		await press("Enter");
		const reader = controller!;
		assert.equal(reader.getSnapshot().status, "playing");
		await act(async () => root.unmount());
		await settle();
		assert.equal(reader.getSnapshot().status, "idle");
		root = createRoot(host);
		const requests = spoken.length;
		window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-focus-listening"));
		await settle();
		assert.equal(surface(), null);
		assert.equal(spoken.length, requests, "nothing listens or reads after leaving");
	});
});
