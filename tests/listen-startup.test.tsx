import React, { act, StrictMode, useEffect, useRef } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ListenProvider, useListen } from "../components/listen/listen";
import type { ListenController } from "../components/listen/listen-controller";
import type { SpeechSettings } from "../src/core";
import { FakeAudio, replaceProperties } from "./helpers/browser";

describe("listening at session startup", () => {
	const dom = parseHTML("<html><body></body></html>");
	let restore: (() => void)[] = [];
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let controller: ListenController | null;
	let initialFlags: boolean[] | undefined;
	let speechRequests: unknown[];
	let releaseStatus: (response: Response) => void;
	let status: Promise<Response>;
	let audio: FakeAudio;
	before(async () => {
		restore = [replaceProperties(globalThis, {
			React, window: dom.window, document: dom.document,
			Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
			Node: dom.window.Node, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
			IS_REACT_ACT_ENVIRONMENT: true,
			localStorage: { getItem: () => null, setItem() {} },
			requestAnimationFrame: () => 1, cancelAnimationFrame() {},
			Audio: class extends FakeAudio { constructor() { super(); audio = this; } },
			fetch: async (_url: unknown, init?: RequestInit) => {
				if (init?.method === "POST") {
					speechRequests.push(JSON.parse(String(init.body)));
					return new Response(new Blob(["mp3"]));
				}
				return (await status).clone();
			},
		}), replaceProperties(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => {} })];
		({ createRoot } = await import("react-dom/client"));
	});
	after(() => {
		for (const undo of restore) undo();
	});
	beforeEach(() => {
		controller = null;
		initialFlags = undefined;
		speechRequests = [];
		status = new Promise((resolve) => { releaseStatus = resolve; });
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(async () => {
		const mounted = controller;
		await act(async () => root.unmount());
		assert.equal(mounted?.getSnapshot().status, "idle", "leaving the session stops its reader");
		host.remove();
	});

	/** Match Chat's mount effect: the initial send arms autoplay once,
	 * before the provider's effects or its asynchronous settings GET. */
	function OpeningReply({ start }: { start: boolean }) {
		controller = useListen().controller;
		const sent = useRef(false);
		useEffect(() => {
			if (!start || sent.current || !controller) return;
			sent.current = true;
			initialFlags = [controller.autoplay, controller.readQuestion, controller.readModelAnswers];
			controller.armAutoplay();
			controller.setLive(true);
			document.querySelector('[data-listen-root="transcript"]')!.insertAdjacentHTML("beforeend",
				'<p id="opening">Skipping the warm-up — checking your map and getting to the loop.</p><details><summary>LIST_SESSIONS</summary><pre>Tool output</pre></details>');
			controller.setLive(false);
		}, [start]);
		return <div data-listen-root="transcript"><p>Earlier assistant reply.</p></div>;
	}
	async function mount(initialSpeech: SpeechSettings, start: boolean, strict = false) {
		const content = <ListenProvider initialSpeech={initialSpeech}><OpeningReply start={start} /></ListenProvider>;
		await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content));
		await act(async () => {
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	const saved = { enabled: true, autoplay: true, readQuestion: true, readModelAnswers: true };
	for (const strict of [false, true]) {
		it(`reads the opening before the settings GET completes, once (StrictMode ${strict})`, async () => {
			await mount(saved, true, strict);
			assert.deepEqual(initialFlags, [true, true, true], "the child sees saved preferences on its first send");
			assert.equal(controller!.getSnapshot().block?.id, "opening");
			assert.equal(controller!.getSnapshot().status, "playing");
			assert.equal(speechRequests.length, 1);
			assert.match(JSON.stringify(speechRequests[0]), /Skipping the warm-up/);
			assert.doesNotMatch(JSON.stringify(speechRequests), /Earlier assistant reply|LIST_SESSIONS|Tool output/);
			await act(async () => {
				audio.end();
				releaseStatus(Response.json({ configured: true, autoplay: true, readQuestion: true, readModelAnswers: true }));
			});
			assert.equal(speechRequests.length, 1, "the settings refresh does not replay the opening");
			assert.equal(controller!.autoplay, true);
		});
	}
	for (const settings of [{ enabled: false, autoplay: true }, { enabled: true, autoplay: false }]) {
		it(`respects saved disabled settings ${JSON.stringify(settings)}`, async () => {
			await mount(settings, true);
			assert.equal(initialFlags?.[0], false);
			assert.equal(speechRequests.length, 0);
		});
	}
	it("opening an existing session does not autoplay its history", async () => {
		await mount(saved, false);
		await act(async () => releaseStatus(Response.json({ configured: true, autoplay: true })));
		assert.equal(speechRequests.length, 0);
		assert.equal(controller!.getSnapshot().status, "idle");
	});
	it("leaving the session forgets an armed autoplay: nothing reads from a later page", async () => {
		await mount(saved, false);
		const left = controller!;
		left.armAutoplay();
		left.setLive(true);
		await act(async () => root.unmount());
		root = createRoot(host);
		assert.equal(left.getSnapshot().status, "idle");
		document.body.insertAdjacentHTML("beforeend",
			'<div data-listen-root="transcript" id="next-session"><p>Another session.</p><p>Its reply.</p><p>More of it.</p></div>');
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
		document.getElementById("next-session")!.remove();
		assert.equal(speechRequests.length, 0);
		assert.equal(left.getSnapshot().status, "idle");
	});
	it("the live settings response still updates and disables the seeded reader", async () => {
		await mount(saved, true);
		assert.equal(controller!.getSnapshot().status, "playing");
		await act(async () => releaseStatus(Response.json({ configured: false, autoplay: false })));
		assert.equal(controller!.autoplay, false);
		assert.equal(controller!.getSnapshot().status, "idle");
	});
});
