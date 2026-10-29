/**
 * "Read the question" (Settings → TTS): read from here that starts in the
 * transcript continues into the dock's question, Previous steps back
 * across, the dock never reads up into the transcript, and a dock section
 * that re-renders while it is read (the folded practice bar's hidden
 * Problem → the open dock's) is followed.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

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
const { LISTEN_ENTER_DOCK_EVENT } = await import("../components/listen/speech-dom.ts");
const $ = (id: string) => document.getElementById(id)!;
/** Let a block's clip load and start playing. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("Read the question", () => {
	let entered = 0;
	before(() => document.addEventListener(LISTEN_ENTER_DOCK_EVENT, () => entered++));
	beforeEach(() => {
		entered = 0;
	});

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
		assert.equal(entered, 0);
	});

	it("on: continues into the dock's question, and on through it", async () => {
		const controller = await readFrom("p2", true);
		audio.end();
		assert.equal(controller.getSnapshot().block, $("dq"));
		assert.equal(controller.getSnapshot().label, "Question");
		assert.equal(entered, 1, "the chat is told the dock was entered");
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().block, $("opts"));
		assert.equal(entered, 1, "only on the crossing");
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
		assert.equal(entered, 0, "starting in the dock is not a crossing");
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
