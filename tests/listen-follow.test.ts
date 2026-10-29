/**
 * Follow mode and autoplay (Settings → TTS). While a turn is live only
 * finished transcript blocks are read — a block is finished once another
 * follows it, or the turn ends — and a read that catches up waits instead
 * of stopping. Autoplay reads the reply to a turn the learner started,
 * from its first finished block past their own rows; it never interrupts.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");

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
		MutationObserver: window.MutationObserver,
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
const { setDictationActive } = await import("../components/dictation-state.ts");
type Controller = InstanceType<typeof ListenController>;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let mutations be noticed (50ms throttle) and a clip start playing. */
const settle = async () => {
	await tick(80);
	for (let i = 0; i < 5; i++) await tick();
};
const $ = (id: string) => document.getElementById(id)!;
const transcript = () => document.querySelector('[data-listen-root="transcript"]')!;
function add(html: string) {
	transcript().insertAdjacentHTML("beforeend", html);
}
const at = (c: Controller) => {
	const s = c.getSnapshot();
	return s.status === "playing" || s.status === "loading" ? s.block?.id : s.status;
};

let controller: Controller;
beforeEach(() => {
	document.body.innerHTML = `<div data-listen-root="transcript"><p id="old">Earlier reply.</p></div><div data-listen-root="dock"></div>`;
	controller?.stop();
	controller = new ListenController();
	setDictationActive(false);
});

describe("follow mode", () => {
	it("never reads the block still being written; waits, then goes on as blocks finish", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("a"));
		await settle();
		assert.equal(at(controller), "a");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting", "b is still growing");
		assert.equal(controller.getSnapshot().label, "Waiting…");
		$("b").textContent = "Two, still streaming.";
		add(`<p id="c">Three</p>`);
		await settle();
		assert.equal(at(controller), "b", "b finished once c began");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "c", "the turn's end finishes the last block");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("Read from here on the block still being written waits until it's finished", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("b"));
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		$("b").textContent = "Two, still streaming.";
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting", "growing text alone doesn't finish it");
		add(`<p id="c">Three</p>`);
		await settle();
		assert.equal(at(controller), "b");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
	});

	it("a block still being written when the turn ends is read then", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("b"));
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "b");
	});

	it("Next while caught up waits too", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("a"));
		await settle();
		controller.next();
		assert.equal(controller.getSnapshot().status, "waiting");
	});

	it("a wait the turn's end leaves with nothing to read stops", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("a"));
		await settle();
		$("b").remove();
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await tick(700);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("outside a turn, reading stops at the end as before", async () => {
		controller.playFrom($("old"));
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a block a re-render replaced is found again by position and text", async () => {
		add(`<p id="a">One.</p><p id="b">Two.</p>`);
		controller.playFrom($("a"));
		await settle();
		const copy = document.createElement("p");
		copy.textContent = "One.";
		$("a").replaceWith(copy);
		assert.equal(controller.activeBlock(), copy);
		audio.end();
		assert.equal(at(controller), "b");
	});
});

describe("briefs", () => {
	const brief = (id: string) =>
		`<details open data-listen-aside=""><summary>Research complete</summary><p id="${id}-1">Finding one.</p><p id="${id}-2">Finding two.</p></details>`;

	it("a read from above passes over an open brief", async () => {
		add(`${brief("b")}<p id="after">After.</p>`);
		controller.playFrom($("old"));
		await settle();
		audio.end();
		assert.equal(at(controller), "after");
	});

	it("a read started inside one reads it, then continues past it, skipping other briefs", async () => {
		add(`${brief("b")}<p id="mid">Between.</p>${brief("c")}<p id="after">After.</p>`);
		controller.playFrom($("b-1"));
		await settle();
		audio.end();
		assert.equal(at(controller), "b-2");
		await settle();
		audio.end();
		assert.equal(at(controller), "mid");
		await settle();
		audio.end();
		assert.equal(at(controller), "after");
	});
});

describe("autoplay", () => {
	beforeEach(() => {
		controller.autoplay = true;
	});

	async function turn(reply: string) {
		controller.armAutoplay();
		controller.setLive(true);
		add(`<div data-listen-yours=""><div data-listen-block="You" id="you">My question</div></div>`);
		add(reply);
		await settle();
	}

	it("reads the reply from its first finished block, skipping your own row", async () => {
		await turn(`<p id="r1">Reply one.</p>`);
		assert.equal(controller.getSnapshot().status, "idle", "r1 is still being written");
		add(`<p id="r2">Reply two</p>`);
		await settle();
		assert.equal(at(controller), "r1");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "r2");
	});

	it("skips the research and PDF briefs even open", async () => {
		const brief = `<details open data-listen-aside=""><summary>Research complete</summary><p id="finding">A finding.</p></details>`;
		await turn(`${brief}<p id="r1">Reply one.</p><p id="r2">Reply two.</p>`);
		assert.equal(at(controller), "r1", "the reply starts past the brief");
		controller.prev();
		assert.equal(at(controller), "you", "Previous passes over it too");
	});

	it("off: nothing plays", async () => {
		controller.autoplay = false;
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		controller.setLive(false);
		await tick(700);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("never interrupts: a reply that arrives while something reads is skipped", async () => {
		controller.playFrom($("old"));
		await settle();
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		assert.equal(at(controller), "old", "the read in progress is not interrupted");
		audio.end();
		await settle();
		assert.equal(at(controller), "you", "it just reads on through the transcript, as Read from here does");
	});

	it("dictation skips the reply", async () => {
		setDictationActive(true);
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a reply that is only a question reads the question with Read the question on", async () => {
		controller.readQuestion = true;
		await turn("");
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Question" id="dq">Pick one</div>`;
		controller.setLive(false);
		await tick(700);
		await settle();
		assert.equal(at(controller), "dq");
	});

	it("a refused send disarms", async () => {
		controller.armAutoplay();
		controller.disarmAutoplay();
		controller.setLive(true);
		add(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		await settle();
		assert.equal(controller.getSnapshot().status, "idle");
	});
});
