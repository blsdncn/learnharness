/**
 * "Read the question" (Settings → TTS): read from here that starts in the
 * transcript continues into the dock's question, Previous steps back
 * across, the dock never reads up into the transcript, and a dock section
 * that re-renders while it is read (the folded practice bar's hidden
 * Problem → the open dock's) is followed. Reading never signals the chat
 * to open the dock: a folded dock is read hidden, and left folded.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProblemCard } from "../components/practice-cards";
import { PracticeDock } from "../components/practice-dock";
import { QuestionDock } from "../components/question-dock";

const { document, window } = parseHTML(`<!doctype html><html><body>
<div data-listen-root="transcript"><p id="p1">First.</p><p id="p2">Second.</p></div>
<div data-listen-root="dock"><div data-listen-block="Question" id="dq">Pick one</div>
  <div data-listen-block="Options" id="opts"><button>Alpha</button></div></div>
</body></html>`);

class FakeAudio {
	src = "";
	playbackRate = 1;
	preservesPitch = true;
	private listeners = new Map<string, () => void>();
	addEventListener(type: string, fn: () => void) {
		this.listeners.set(type, fn);
	}
	play() {
		return Promise.resolve();
	}
	pause() {}
	removeAttribute() {}
	end() {
		this.listeners.get("ended")?.();
	}
}

const previous = new Map<string, PropertyDescriptor | undefined>();
let audio: FakeAudio;
before(() => {
	for (const [key, value] of Object.entries({
		React,
		document,
		Node: window.Node,
		Element: window.Element,
		Event: window.Event,
		localStorage: { getItem: () => null, setItem: () => {} },
		Audio: class extends FakeAudio {
			constructor() {
				super();
				audio = this;
			}
		},
		fetch: async () => new Response(new Blob(["mp3"])),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	URL.createObjectURL = () => "blob:clip";
	URL.revokeObjectURL = () => {};
});


after(() => {
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});

const { ListenController } = await import("../components/listen/listen-controller.ts");
const { blocksIn } = await import("../components/listen/speech-dom.ts");
const $ = (id: string) => document.getElementById(id)!;
/** Let a block's clip load and start playing. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Every event dispatched on the document: the chat's only way to hear
 *  from the reader. Crossing into the dock must not ask it for anything. */
const dispatched: string[] = [];
before(() => {
	const dispatch = document.dispatchEvent.bind(document);
	document.dispatchEvent = (event: Event) => {
		dispatched.push(event.type);
		return dispatch(event);
	};
});
beforeEach(() => {
	dispatched.length = 0;
});

describe("Read the question", () => {

	async function readFrom(id: string, readQuestion: boolean) {
		const controller = new ListenController();
		controller.readQuestion = readQuestion;
		controller.playFrom($(id));
		await settle();
		return controller;
	}

	it("off: reading stops at the end of the transcript", async () => {
		const controller = await readFrom("p2", false);
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
		assert.deepEqual(dispatched, []);
	});

	it("on: continues into the dock's question, and on through it", async () => {
		const controller = await readFrom("p2", true);
		audio.end();
		assert.equal(controller.getSnapshot().block, $("dq"));
		assert.equal(controller.getSnapshot().label, "Question");
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().block, $("opts"));
		assert.deepEqual(dispatched, [], "the dock is left as it is");
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("Previous from the dock's first block steps back into the transcript", async () => {
		const controller = await readFrom("p2", true);
		audio.end();
		await settle();
		controller.prev();
		assert.equal(controller.getSnapshot().block, $("p2"));
	});

	it("a read started in the dock never reads up into the transcript", async () => {
		const controller = await readFrom("dq", true);
		controller.prev();
		assert.equal(controller.getSnapshot().block, $("dq"));
		audio.end();
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("follows a dock section that re-renders while it is read", async () => {
		const controller = await readFrom("p2", true);
		audio.end();
		await settle();
		const hidden = $("dq");
		const open = document.createElement("div");
		open.setAttribute("data-listen-block", "Question");
		open.textContent = "Pick one";
		hidden.replaceWith(open);
		assert.equal(controller.activeBlock(), open);
		assert.equal(controller.getSnapshot().block, open);
		audio.end();
		assert.equal(controller.getSnapshot().block, $("opts"), "Next goes on from the open section");
		open.replaceWith(hidden);
	});
});

describe("the active practice problem", () => {
	const statement = "A path has bottleneck rate 20 Mbit/s. How much data must be in flight?";
	function fixture(expanded: boolean, historical = false) {
		const card = (id: string) => renderToStaticMarkup(React.createElement(ProblemCard, {
			part: { type: "tool-problem", state: "input-available", toolCallId: id, input: { statement } },
		}));
		const dock = renderToStaticMarkup(React.createElement(PracticeDock, {
			problemCallId: "current", input: { statement }, expanded, onExpand() {}, onSubmit() {},
		}));
		document.body.innerHTML = `<div data-listen-root="transcript"><p id="intro">Introduction.</p>${historical ? card("older") : ""}${card("current")}</div><div data-listen-root="dock">${dock}</div>`;
	}
	const rootName = (block: Element | null | undefined) => block?.closest("[data-listen-root]")?.getAttribute("data-listen-root");
	const transcriptCopy = () => document.querySelector('[data-testid="problem-card"] [data-listen-block]')!;
	for (const expanded of [true, false]) {
		it(`a read from here reads the transcript problem, then the ${expanded ? "open" : "folded"} dock's copy`, async () => {
			fixture(expanded);
			const dock = document.querySelector('[data-listen-root="dock"]')!.innerHTML;
			const controller = new ListenController();
			controller.readQuestion = true;
			controller.playFrom($("intro"));
			await settle();
			audio.end();
			assert.equal(controller.getSnapshot().block, transcriptCopy(), "the learner's read is not deduplicated");
			await settle();
			audio.end();
			assert.equal(rootName(controller.getSnapshot().block), "dock");
			await settle();
			audio.end();
			assert.equal(controller.getSnapshot().status, "idle");
			assert.equal(document.querySelector('[data-listen-root="dock"]')!.innerHTML, dock, "the dock is unchanged");
			assert.equal(document.querySelector('[data-testid="practice-dock-bar"]') !== null, !expanded, "a folded dock stays folded");
			assert.deepEqual(dispatched, []);
		});
	}
	it("keeps the transcript problem readable with Read the question off", async () => {
		fixture(true);
		const controller = new ListenController();
		controller.playFrom($("intro"));
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().block, document.querySelector('[data-testid="problem-card"] [data-listen-block]'));
		controller.stop();
	});
	it("reads an older problem with identical wording, and Previous steps back to the active one", async () => {
		fixture(true, true);
		const controller = new ListenController();
		controller.readQuestion = true;
		controller.playFrom($("intro"));
		await settle();
		audio.end();
		const [older, current] = document.querySelectorAll('[data-testid="problem-card"] [data-listen-block]');
		assert.equal(controller.getSnapshot().block, older);
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().block, current);
		await settle();
		audio.end();
		assert.equal(rootName(controller.getSnapshot().block), "dock");
		controller.prev();
		assert.equal(controller.getSnapshot().block, current);
		controller.stop();
	});
	it("starting on the active transcript copy starts there, then reads the dock copy", async () => {
		fixture(false);
		const controller = new ListenController();
		controller.readQuestion = true;
		controller.playFrom(transcriptCopy());
		assert.equal(controller.getSnapshot().block, transcriptCopy());
		await settle();
		audio.end();
		assert.equal(rootName(controller.getSnapshot().block), "dock");
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});
	it("with Read the question off, starting on the transcript copy stays in the transcript", async () => {
		fixture(false);
		const controller = new ListenController();
		controller.playFrom(transcriptCopy());
		assert.equal(controller.getSnapshot().block, transcriptCopy());
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});
});

describe("an unanswered recall question", () => {
	for (const expanded of [true, false]) {
		it(`never sends the committed solution to speech (${expanded ? "open" : "folded"} dock)`, async (t) => {
			const requests: unknown[] = [];
			t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
				requests.push(JSON.parse(String(init?.body)));
				return new Response(new Blob(["mp3"]));
			});
			const html = renderToStaticMarkup(React.createElement(QuestionDock, {
				toolName: "recall", toolCallId: "unanswered_recall", expanded,
				input: { question: "What is $15 + 8 \\times (3-1)^2 / 4$? Show the steps.", correctAnswer: "HIDDEN_SOLUTION_SENTINEL: work through each operation to get 23." },
				onExpand() {}, onSubmit() {},
			}));
			document.body.innerHTML = `<div data-listen-root="dock">${html}</div>`;
			const blocks = blocksIn(document.querySelector('[data-listen-root="dock"]')!);
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0]!.getAttribute("data-listen-block"), "Question");
			const controller = new ListenController();
			controller.readQuestion = true;
			controller.readModelAnswers = true;
			controller.playFrom(blocks[0]!);
			await settle();
			assert.equal(requests.length, 1);
			assert.match(JSON.stringify(requests), /Show the steps/);
			assert.doesNotMatch(JSON.stringify(requests), /HIDDEN_SOLUTION_SENTINEL|correctAnswer|operation to get 23/);
			controller.stop();
		});
	}
});
