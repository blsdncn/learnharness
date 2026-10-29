import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { SpeechSettings } from "../src/core/settings.ts";
import { SpeechSection } from "../components/settings/speech-section.tsx";

describe("TTS settings: listening controls, and the provider named with a link to Providers", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")!;
	const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")!;
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let saved: SpeechSettings;
	let uploadSignal: AbortSignal | null | undefined;
	/** GET /api/tts/openai's readiness beyond `configured`. */
	let ready: { keyPresent: boolean; baseUrl: string | null; model: string | null };
	let opened: number;
	const requests: string[] = [];
	const revoked: string[] = [];
	const audio: FakeAudio[] = [];
	class FakeAudio extends EventTarget {
		paused = false;
		constructor(readonly src: string) { super(); audio.push(this); }
		play() { return Promise.resolve(); }
		pause() { this.paused = true; }
	}
	before(async () => {
		for (const [key, value] of Object.entries({
			React, window: dom.window, document: dom.document,
			HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
			IS_REACT_ACT_ENVIRONMENT: true, Audio: FakeAudio,
			fetch: async (input: string, init?: RequestInit) => {
				requests.push(input);
				assert.equal(input, "/api/tts/openai", "settings must not probe provider-specific routes");
				if (init?.method === "POST") {
					uploadSignal = init.signal;
					return new Response(new Uint8Array([0xff, 0xf3]), { headers: { "content-type": "audio/mpeg" } });
				}
				return Response.json({ configured: saved.enabled ?? false, custom: saved.provider === "custom", ...ready });
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		// linkedom has no native input events: React's legacy propertychange
		// fallback (see dictation-language tests).
		Object.assign(dom.window.HTMLElement.prototype, {
			attachEvent(this: { propertyChange?: unknown }, _name: string, handler: unknown) { this.propertyChange = handler; },
			detachEvent() {},
		});
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test-sample" });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
		({ createRoot } = await import("react-dom/client"));
	});
	after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
		Object.defineProperty(URL, "createObjectURL", originalCreate);
		Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
	});
	beforeEach(() => {
		saved = { voice: "alloy" };
		ready = { keyPresent: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts" };
		opened = 0;
		uploadSignal = null;
		requests.length = 0; revoked.length = 0; audio.length = 0;
		host = document.createElement("div"); document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount()); host.remove();
	});
	function Content() {
		const [speech, setSpeech] = useState(saved);
		return <SpeechSection speech={speech} onSectionChange={(next) => { saved = next; setSpeech(next); }} onOpenProviders={() => opened++} />;
	}
	const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
	const input = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
	const mount = () => act(async () => root.render(<Content />));
	const click = (id: string) => act(async () => button(id).click());
	it("listening is opt-in, and enabling it preserves the provider settings", async () => {
		saved = { provider: "custom", customModel: "tts-1", voice: "alloy" };
		await mount();
		assert.equal(button("speech-test").disabled, true);
		await click("toggle-listening");
		assert.deepEqual(saved, { enabled: true, provider: "custom", customModel: "tts-1", voice: "alloy" });
		assert.equal(button("speech-test").disabled, false);
		assert.ok(requests.every((url) => url === "/api/tts/openai"));
	});
	it("can disable listening", async () => {
		saved.enabled = true;
		await mount();
		assert.equal(button("speech-test").disabled, false);
		await click("toggle-listening");
		assert.equal(saved.enabled, false);
		assert.equal(button("speech-test").disabled, true);
	});
	it("Read the question is off by default and saves with the rest of the section", async () => {
		await mount();
		assert.equal(button("toggle-read-the-question").getAttribute("aria-checked"), "false");
		await click("toggle-read-the-question");
		assert.deepEqual(saved, { voice: "alloy", readQuestion: true });
		assert.equal(button("toggle-read-the-question").getAttribute("aria-checked"), "true");
	});
	it("Autoplay replies is off by default and saves with the rest of the section", async () => {
		await mount();
		assert.equal(button("toggle-autoplay-replies").getAttribute("aria-checked"), "false");
		await click("toggle-autoplay-replies");
		assert.deepEqual(saved, { voice: "alloy", autoplay: true });
	});
	it("names OpenAI by default; a missing key shows, and the link opens Providers", async () => {
		await mount();
		assert.equal(host.querySelector('[data-testid="speech-provider"]')!.textContent, "OpenAI");
		assert.equal(host.querySelector('[data-testid="speech-provider-problem"]'), null);
		assert.equal(host.querySelector("details"), null, "no Advanced endpoint here any more");
		await click("speech-open-providers");
		assert.equal(opened, 1);
		ready = { ...ready, keyPresent: false };
		act(() => root.unmount());
		root = createRoot(host);
		await mount();
		assert.match(host.querySelector('[data-testid="speech-provider-problem"]')!.textContent ?? "", /No OpenAI API key/);
	});
	it("names the custom endpoint and its model, and says what's missing", async () => {
		saved = { provider: "custom", customModel: "kokoro", voice: "alloy" };
		ready = { keyPresent: true, baseUrl: "http://local.test/v1", model: "kokoro" };
		await mount();
		assert.equal(host.querySelector('[data-testid="speech-provider"]')!.textContent, "Custom endpoint · kokoro");
		assert.equal(host.querySelector('[data-testid="speech-provider-problem"]'), null);
		for (const [state, problem] of [
			[{ keyPresent: true, baseUrl: null, model: "kokoro" }, /No custom endpoint connected/],
			[{ keyPresent: true, baseUrl: "http://local.test/v1", model: null }, /No model chosen/],
			[{ keyPresent: false, baseUrl: "http://local.test/v1", model: "kokoro" }, /needs reconnecting/],
		] as const) {
			ready = state;
			act(() => root.unmount());
			root = createRoot(host);
			await mount();
			assert.match(host.querySelector('[data-testid="speech-provider-problem"]')!.textContent ?? "", problem);
		}
	});
	it("stops the sample and releases its object URL when settings unmount", async () => {
		saved.enabled = true;
		await mount();
		await click("speech-test");
		assert.equal(audio.length, 1);
		assert.equal(button("speech-test").textContent, "Playing…");
		act(() => root.render(null));
		assert.equal(uploadSignal?.aborted, true);
		assert.equal(audio[0]!.paused, true);
		assert.deepEqual(revoked, ["blob:test-sample"]);
	});
	it("turning listening off also stops a sample already playing", async () => {
		saved.enabled = true;
		await mount();
		await click("speech-test");
		await click("toggle-listening");
		assert.equal(audio[0]!.paused, true);
		assert.equal(button("speech-test").textContent, "Play sample");
		assert.equal(button("speech-test").disabled, true);
		assert.deepEqual(revoked, ["blob:test-sample"]);
	});
});
