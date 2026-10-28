import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { SpeechSettings } from "../src/core/settings.ts";
import { SpeechSection } from "../components/settings/speech-section.tsx";

describe("Speech settings with optional provider authentication", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")!;
	const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")!;
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let saved: SpeechSettings;
	let uploadSignal: AbortSignal | null | undefined;
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
				if (input === "/api/keys") return Response.json({ keys: [], providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
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
		return <SpeechSection speech={speech} onSectionChange={(next) => { saved = next; setSpeech(next); }} onOpenKey={() => {}} />;
	}
	const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
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
	it("can disable listening; the key row sits outside Advanced connection", async () => {
		saved.enabled = true;
		await mount();
		assert.equal(button("speech-test").disabled, false);
		await click("toggle-listening");
		assert.equal(saved.enabled, false);
		assert.equal(button("speech-test").disabled, true);
		const row = host.querySelector('[data-testid="speech-row-key"]')!;
		assert.equal(row.closest("details"), null, "the API key is not hidden under Advanced");
		assert.match(button("speech-row-key-provider").textContent ?? "", /OpenAI/);
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
