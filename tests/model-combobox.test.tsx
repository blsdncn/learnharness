/**
 * The Model picker (Settings → Dictation / TTS, Advanced connection): a
 * typeable field whose chevron lists the saved server's models — fetched
 * on first open, refreshed on demand or after a save, filtered by typing.
 * Exercised through Settings → Dictation (OpenAI-compatible).
 */
import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { DictationSection } from "../components/settings/dictation-section.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { DictationSettings } from "../src/core/dictation.ts";

describe("model picker", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let settings: DictationSettings;
	let commits: (string | undefined)[];
	let listRequests: number;
	let answer: () => Response;

	before(async () => {
		for (const [name, value] of Object.entries({
			React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element,
			HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
			requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
			cancelAnimationFrame: (id: number) => clearTimeout(id),
			fetch: async (url: string) => {
				if (url === "/api/stt/openai/models") {
					listRequests++;
					return answer();
				}
				return Response.json({ keys: [], providers: [] });
			},
		})) {
			previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
		}
		Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
		dom.window.HTMLElement.prototype.scrollIntoView = () => {};
		Object.assign(dom.window.HTMLElement.prototype, {
			attachEvent(this: { propertyChange?: unknown }, _name: string, handler: unknown) { this.propertyChange = handler; },
			detachEvent() {},
			select() {},
		});
		({ createRoot } = await import("react-dom/client"));
	});
	after(() => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	});
	beforeEach(() => {
		settings = {};
		commits = [];
		listRequests = 0;
		answer = () => Response.json({ models: ["gpt-4o-transcribe", "gpt-5", "gpt-transcribe", "whisper-1"] });
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		document.querySelectorAll("[data-lh-menu]").forEach((node) => node.remove());
	});

	function Harness() {
		const [connection, setConnection] = useState(settings);
		return <DictationSection provider="openai" dictation={connection} onProviderChange={() => {}} onOpenKey={() => {}}
			onConnectionChange={(patch) => { if ("model" in patch) commits.push(patch.model); settings = { ...settings, ...patch }; setConnection(settings); }} />;
	}
	const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
	const mount = () => act(async () => root.render(<Harness />));
	const click = (el: Element) => act(async () => (el as HTMLElement).click());
	const toggle = () => click(q("input-dictation-model-toggle")!);
	const options = () => [...document.querySelectorAll('[data-testid="input-dictation-model-option"]')].map((node) => node.textContent);
	const input = () => q<HTMLInputElement>("input-dictation-model")!;
	const type = (value: string) => act(async () => {
		// linkedom has no native input events: React's legacy propertychange
		// fallback (see audio-key-row.test.tsx).
		input().dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
		Object.defineProperty(input(), "value", { configurable: true, writable: true, value });
		(input() as unknown as { propertyChange: (e: { propertyName: string }) => void }).propertyChange({ propertyName: "value" });
	});
	const key = (k: string) => act(async () => {
		// linkedom has no KeyboardEvent constructor.
		const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k });
		input().dispatchEvent(event);
	});

	it("fetches on first open, lists every model A–Z with the default marked, and refreshes on demand", async () => {
		await mount();
		assert.equal(listRequests, 0, "nothing is fetched until the list opens");
		assert.equal(input().getAttribute("placeholder"), "gpt-transcribe");
		await toggle();
		assert.equal(listRequests, 1);
		assert.deepEqual(options(), ["gpt-4o-transcribe", "gpt-5", "gpt-transcribedefault", "whisper-1"], "unfiltered — chat models stay listed");
		await toggle();
		await toggle();
		assert.equal(listRequests, 1, "reopening reuses the list");
		answer = () => Response.json({ models: ["gpt-transcribe", "new-model"] });
		await click(q("input-dictation-model-refresh")!);
		assert.equal(listRequests, 2);
		assert.deepEqual(options(), ["gpt-transcribedefault", "new-model"]);
	});

	it("picking commits that model once; typing filters the open list", async () => {
		await mount();
		await toggle();
		await type("WHIS");
		assert.deepEqual(options(), ["whisper-1"], "case-insensitive filter on the typed text");
		await click(document.querySelector('[data-testid="input-dictation-model-option"]')!);
		assert.deepEqual(commits, ["whisper-1"], "the pick, not the half-typed filter");
		assert.equal(q("input-dictation-model-menu"), null, "the list closes after a pick");
		assert.equal(input().value, "whisper-1");
	});

	it("arrow keys walk the list and Enter picks", async () => {
		await mount();
		await key("ArrowDown");
		assert.ok(q("input-dictation-model-menu"), "ArrowDown opens the list");
		await key("ArrowDown");
		await key("ArrowDown");
		await key("Enter");
		assert.deepEqual(commits, ["gpt-5"]);
	});

	it("a server without a list shows why, and a typed id still saves", async () => {
		answer = () => Response.json({ message: "Server answered 404 — this server doesn't list models; type a model id" }, { status: 502 });
		await mount();
		await toggle();
		assert.match(q("input-dictation-model-error")!.textContent ?? "", /doesn't list models/);
		await type("speechify");
		await key("Enter");
		// Enter blurs the field (CommitInput's contract); linkedom's blur()
		// dispatches nothing, so deliver the focusout React listens for.
		await act(async () => input().dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
		assert.deepEqual(commits, ["speechify"]);
	});

	it("Escape closes the list first, then discards the typed text without saving", async () => {
		await mount();
		await toggle();
		await type("tts");
		await act(async () => document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
		assert.equal(q("input-dictation-model-menu"), null, "the first Escape only closes the list");
		assert.equal(input().value, "tts", "…and keeps the text");
		// Escape's blur() runs onBlur before React re-renders (as in browsers).
		input().blur = () => input().dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
		await key("Escape");
		assert.deepEqual(commits, [], "the discarded text is never saved");
		assert.equal(input().value, "");
	});

	it("a saved connection or key makes the list stale", async () => {
		await mount();
		await toggle();
		await toggle();
		await act(async () => notifySettingsSaved("dictation"));
		await toggle();
		assert.equal(listRequests, 2, "re-fetched after the dictation section saved");
		await act(async () => notifySettingsSaved("keys"));
		assert.equal(listRequests, 3, "an open list re-fetches right away");
		await act(async () => notifySettingsSaved("speech"));
		assert.equal(listRequests, 3, "another section's save is ignored");
	});
});
