import React, { act } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ListenProvider, useListen } from "../components/listen/listen";
import type { ListenController } from "../components/listen/listen-controller";

/** Mount the actual overlay: touch release includes the non-hovering
 * pointer's leave event, which used to arm the mouse's hide timer. */
describe("listening pointer lifetimes", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	let root: Root;
	let host: HTMLDivElement;
	let controller: ListenController | null;
	let createRoot: typeof import("react-dom/client").createRoot;

	before(async () => {
		for (const [key, value] of Object.entries({
			React,
			window: dom.window,
			document: dom.document,
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			Node: dom.window.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
			localStorage: { getItem: () => null },
			fetch: async () => Response.json({ configured: true }),
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				frames.set(++frameId, callback);
				return frameId;
			},
			cancelAnimationFrame: (id: number) => frames.delete(id),
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		({ createRoot } = await import("react-dom/client"));
	});
	after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	function Content() {
		controller = useListen().controller;
		return <div data-listen-root="transcript"><p>Read this paragraph.</p></div>;
	}
	beforeEach(async () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root.render(<ListenProvider><Content /></ListenProvider>));
		for (const element of document.querySelectorAll<HTMLElement>("[data-listen-root], p")) {
			element.getBoundingClientRect = () => ({ left: 32, right: 232, top: 80, height: 24, width: 200 }) as DOMRect;
		}
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		frames.clear();
	});

	function frame() {
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(0);
	}
	function dispatch(target: Element, type: string, pointerType: string, y = 90) {
		const event = new dom.window.Event(type, { bubbles: type !== "pointerleave" });
		Object.assign(event, { pointerType, clientX: 40, clientY: y });
		act(() => { target.dispatchEvent(event); });
	}
	const paragraph = () => document.querySelector("p")!;
	const speaker = () => document.querySelector<HTMLButtonElement>('[data-testid="listen-speaker"]')!;
	function tap(target: Element) {
		dispatch(target, "pointerdown", "touch");
		dispatch(target, "pointerup", "touch");
	}

	it("touch release leaves time to press the speaker, then playback clears it", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		tap(paragraph());
		frame();
		assert.equal(speaker().style.opacity, "1");
		dispatch(document.documentElement, "pointerleave", "touch");
		t.mock.timers.tick(2000);
		frame();
		assert.equal(speaker().style.opacity, "1", "lifting the finger must not start a hide countdown");
		let read: Element | undefined;
		controller!.playFrom = (block) => { read = block; };
		act(() => speaker().click());
		assert.equal(read, paragraph(), "a delayed speaker press still reads the tapped paragraph");
		frame();
		assert.equal(speaker().style.opacity, "0");
	});

	for (const pointerType of ["mouse", "pen"]) {
		it(`${pointerType} leaving the window still hides the hover speaker`, (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			dispatch(paragraph(), "pointerover", pointerType);
			frame();
			assert.equal(speaker().style.opacity, "1");
			dispatch(document.documentElement, "pointerleave", pointerType);
			t.mock.timers.tick(250);
			frame();
			assert.equal(speaker().style.opacity, "0");
		});
	}

	it("swiping does not reveal a speaker; tapping elsewhere dismisses one", () => {
		dispatch(paragraph(), "pointerdown", "touch");
		dispatch(paragraph(), "pointerup", "touch", 140);
		frame();
		assert.equal(speaker().style.opacity, "0");
		tap(paragraph());
		frame();
		assert.equal(speaker().style.opacity, "1");
		tap(document.body);
		frame();
		assert.equal(speaker().style.opacity, "0");
	});
});
