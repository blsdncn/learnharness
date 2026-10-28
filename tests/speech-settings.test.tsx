import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { SpeechSettings } from "../src/core/settings.ts";
import { SpeechSection } from "../components/settings/speech-section.tsx";

describe("TTS settings: OpenAI by default, a custom endpoint under Advanced", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")!;
	const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")!;
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let saved: SpeechSettings;
	let uploadSignal: AbortSignal | null | undefined;
	let keys: { id: string; present: boolean; source?: string; masked?: string; length?: number }[];
	let opened: string[];
	const keyWrites: { url: string; method?: string; body?: string }[] = [];
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
				if (input === "/api/keys") return Response.json({ keys });
				if (input === "/api/keys/TTS_API_KEY") {
					keyWrites.push({ url: input, method: init?.method, body: init?.body as string | undefined });
					return Response.json({ status: { id: "TTS_API_KEY", present: true, source: "file", masked: "…7890", length: 16 } });
				}
				assert.equal(input, "/api/tts/openai", "settings must not probe provider-specific routes");
				if (init?.method === "POST") {
					uploadSignal = init.signal;
					return new Response(new Uint8Array([0xff, 0xf3]), { headers: { "content-type": "audio/mpeg" } });
				}
				return Response.json({ configured: saved.enabled ?? false });
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
		saved = { baseUrl: "http://local.test/v1", model: "tts-1", voice: "alloy" };
		keys = [];
		opened = [];
		keyWrites.length = 0;
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
		return <SpeechSection speech={speech} onSectionChange={(next) => { saved = next; setSpeech(next); }} onOpenKey={(id) => opened.push(id)} />;
	}
	const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
	const input = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
	/** linkedom's click() doesn't toggle a checkbox; browsers flip it first. */
	const check = (id: string) => act(async () => { const box = input(id); box.checked = !box.checked; box.click(); });
	const mount = () => act(async () => root.render(<Content />));
	const click = (id: string) => act(async () => button(id).click());
	it("listening is opt-in, and enabling it preserves the connection settings", async () => {
		await mount();
		assert.equal(button("speech-test").disabled, true);
		await click("toggle-listening");
		assert.deepEqual(saved, { enabled: true, baseUrl: "http://local.test/v1", model: "tts-1", voice: "alloy" });
		assert.equal(button("speech-test").disabled, false);
		assert.ok(requests.every((url) => url === "/api/tts/openai" || url === "/api/keys"));
	});
	it("can disable listening", async () => {
		saved.enabled = true;
		await mount();
		assert.equal(button("speech-test").disabled, false);
		await click("toggle-listening");
		assert.equal(saved.enabled, false);
		assert.equal(button("speech-test").disabled, true);
	});
	it("by default uses the OpenAI key; a missing one links to Providers", async () => {
		await mount();
		const missing = button("speech-endpoint-openai-missing");
		assert.match(missing.textContent ?? "", /No OpenAI API key/);
		assert.equal(missing.closest("details"), null, "the key status is not hidden under Advanced");
		await click("speech-endpoint-openai-missing");
		assert.deepEqual(opened, ["OPENAI_API_KEY"]);
		keys = [{ id: "OPENAI_API_KEY", present: true, source: "file", masked: "…abcd", length: 51 }];
		act(() => root.unmount());
		root = createRoot(host);
		await mount();
		assert.equal(host.querySelector('[data-testid="speech-endpoint-openai-missing"]'), null);
		assert.match(host.querySelector('[data-testid="speech-endpoint-openai"]')!.textContent ?? "", /Uses your OpenAI key from Providers/);
	});
	it("the custom endpoint checkbox is the switch; its fields stay greyed and kept while off", async () => {
		await mount();
		assert.equal(input("speech-endpoint-base-url").disabled, true);
		assert.equal(input("speech-endpoint-model").disabled, true);
		assert.equal(input("speech-endpoint-model").placeholder, "gpt-4o-mini-tts");
		assert.equal(button("speech-endpoint-key-row").disabled, true);
		await check("speech-endpoint-custom");
		assert.deepEqual(saved, { baseUrl: "http://local.test/v1", model: "tts-1", voice: "alloy", customEndpoint: true });
		assert.equal(input("speech-endpoint-base-url").disabled, false);
		assert.equal(host.querySelector('[data-testid="speech-endpoint-openai"]'), null, "no OpenAI key line while custom");
		await check("speech-endpoint-custom");
		assert.deepEqual(saved, { baseUrl: "http://local.test/v1", model: "tts-1", voice: "alloy", customEndpoint: false }, "unchecking keeps the endpoint");
	});
	it("a custom endpoint without a server says it's required", async () => {
		saved = { customEndpoint: true };
		await mount();
		assert.notEqual((host.querySelector('[data-testid="speech-endpoint-advanced"]') as HTMLDetailsElement).open, true, "Advanced starts folded, even in use");
		assert.match(host.textContent ?? "", /Required/);
	});
	it("the endpoint key is saved to its own key id, never the OpenAI key", async () => {
		saved = { customEndpoint: true, baseUrl: "http://local.test/v1" };
		await mount();
		assert.equal(host.querySelector('[data-testid="speech-endpoint-key-status"]')!.textContent, "not set");
		await click("speech-endpoint-key-row");
		const field = input("speech-endpoint-key-input");
		await act(async () => {
			field.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
			Object.defineProperty(field, "value", { configurable: true, writable: true, value: "local-key-1234567890" });
			(field as unknown as { propertyChange: (e: { propertyName: string }) => void }).propertyChange({ propertyName: "value" });
		});
		await click("speech-endpoint-key-save");
		assert.deepEqual(keyWrites.map(({ url, method }) => [url, method]), [["/api/keys/TTS_API_KEY", "PUT"]]);
		assert.equal(host.querySelector('[data-testid="speech-endpoint-key-status"]')!.textContent?.includes("7890"), true);
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
