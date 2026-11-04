import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escAbortTarget } from "../components/chat.tsx";
import { parseHTML } from "linkedom";
import { ListenController } from "../components/listen/listen-controller.ts";

/**
 * THE LAYERED ESC (owner report, 2026-10-04): Esc over an open overlay —
 * a mermaid focus, the plan popup, the setup dialog — must CLOSE THE
 * OVERLAY, never dismiss a pending question (or abort a turn) underneath.
 * KeyboardShortcuts dispatches lh:kbd-abort-turn on every unclaimed Esc
 * and its window listener registers FIRST, so the overlays' own listeners
 * can never outrun it — the state gate in ChatView (this ruling, exported
 * pure) is the defense. Priority = stacking order.
 */
describe("escAbortTarget (the layered-Esc ruling)", () => {
	const none = { abortAsk: false, mermaidFocus: false, planOpen: false, setupOpen: false, listening: false, pending: false, problem: false, busy: false };

	it("no overlays: the 2026-10-02 chain stands (question before turn)", () => {
		assert.equal(escAbortTarget({ ...none, pending: true }), "question");
		assert.equal(escAbortTarget({ ...none, busy: true }), "turn");
		assert.equal(escAbortTarget(none), null);
		assert.equal(escAbortTarget({ ...none, pending: true, busy: true }), "question", "a pending question outranks the turn");
	});

	it("an active practice problem sits between question and turn (2026-10-04)", () => {
		assert.equal(escAbortTarget({ ...none, problem: true }), "problem");
		assert.equal(escAbortTarget({ ...none, problem: true, busy: true }), "problem", "the problem card outranks the turn abort");
		assert.equal(escAbortTarget({ ...none, planOpen: true, problem: true }), "plan", "an open popup still outranks the problem");
	});

	it("an open overlay claims Esc over a pending question — the owner's report", () => {
		for (const overlay of ["mermaidFocus", "planOpen", "setupOpen"] as const) {
			const target = escAbortTarget({ ...none, [overlay]: true, pending: true });
			assert.notEqual(target, "question", `${overlay} open must not dismiss the question`);
			assert.notEqual(target, "turn", `${overlay} open must not abort the turn`);
		}
		assert.equal(escAbortTarget({ ...none, mermaidFocus: true, pending: true }), "mermaid");
		assert.equal(escAbortTarget({ ...none, planOpen: true, pending: true }), "plan");
		assert.equal(escAbortTarget({ ...none, setupOpen: true, pending: true }), "setup");
	});

	it("the abort confirm is topmost — its own Esc is claimed by the dialog", () => {
		assert.equal(
			escAbortTarget({ ...none, abortAsk: true, mermaidFocus: true, pending: true }),
			null,
			"never chain: the dialog owns that Esc",
		);
	});

	it("stacking order among overlays: mermaid paints above plan (later in DOM)", () => {
		assert.equal(escAbortTarget({ ...none, mermaidFocus: true, planOpen: true, pending: true }), "mermaid");
	});

	it("listening: Esc stops the audio before dismissing or aborting anything", () => {
		assert.equal(escAbortTarget({ ...none, listening: true }), "listen");
		for (const under of ["pending", "problem", "busy"] as const) {
			assert.equal(escAbortTarget({ ...none, listening: true, [under]: true }), "listen", `listening outranks ${under}`);
		}
		for (const overlay of ["mermaidFocus", "planOpen", "setupOpen"] as const) {
			assert.notEqual(escAbortTarget({ ...none, listening: true, [overlay]: true }), "listen", `${overlay} still closes first`);
		}
	});

	it("an armed but idle reader claims Esc before turn abort, then stays silent", async () => {
		const dom = parseHTML('<html><body><div data-listen-root="transcript"></div></body></html>');
		const previous = new Map<string, PropertyDescriptor | undefined>();
		let requests = 0;
		class Audio {
			addEventListener() {}
			play() { return Promise.resolve(); }
			pause() {}
			removeAttribute() {}
		}
		for (const [key, value] of Object.entries({
			document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
			MutationObserver: dom.window.MutationObserver, Audio,
			fetch: async () => { requests++; return new Response(new Blob(["mp3"])); },
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const controller = new ListenController();
		try {
			controller.autoplay = true;
			controller.armAutoplay();
			controller.setLive(true);
			assert.equal(controller.getSnapshot().status, "idle");
			const target = escAbortTarget({ ...none, listening: controller.pendingAutoplay, busy: true });
			assert.equal(target, "listen", "pending speech must win over aborting the turn");
			if (target === "listen") controller.stop();
			dom.document.querySelector('[data-listen-root="transcript"]')!.innerHTML = '<p>A reply.</p><p>Another paragraph.</p>';
			controller.setLive(false);
			await new Promise((resolve) => setTimeout(resolve, 90));
			assert.equal(requests, 0);
		} finally {
			controller.stop();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete (globalThis as Record<string, unknown>)[key];
			}
		}
	});
});
