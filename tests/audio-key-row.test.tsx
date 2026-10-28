/**
 * The shared TTS / Dictation API-key row: a picker over saved provider
 * keys (default OpenAI, red when missing) or, with Custom key on, an
 * inline key in the same slot. Exercised through Settings → Dictation.
 */
import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { DictationSection } from "../components/settings/dictation-section.tsx";
import type { DictationSettings } from "../src/core/dictation.ts";

type Status = { id: string; present: boolean; masked: string | null; source: string; shadowedByEnv: boolean; info: null };
const key = (id: string, masked: string): Status => ({ id, present: true, masked, source: "file", shadowedByEnv: false, info: null });
const PROVIDERS = [
	{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
	{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
	{ id: "moonshotai", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI" },
	{ id: "moonshotai-cn", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI CN" },
	{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
];

describe("audio API-key row", () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let createRoot: typeof import("react-dom/client").createRoot;
	let root: Root;
	let host: HTMLDivElement;
	let settings: DictationSettings;
	let keys: Status[];
	let writes: { url: string; method: string; body?: unknown }[];
	let opened: string[];

	before(async () => {
		for (const [name, value] of Object.entries({
			React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element,
			HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
			requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
			cancelAnimationFrame: (id: number) => clearTimeout(id),
			fetch: async (url: string, init?: RequestInit) => {
				if (init?.method === "PUT" || init?.method === "DELETE") {
					writes.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
					const id = url.split("/").pop()!;
					keys = keys.filter((k) => k.id !== id);
					if (init.method === "PUT") {
						const status = key(id, "…cus1 (20 chars)");
						keys.push(status);
						return Response.json({ status });
					}
					return Response.json({});
				}
				return Response.json({ keys, providers: PROVIDERS });
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
		keys = [];
		writes = [];
		opened = [];
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
		return <DictationSection provider="openai" dictation={connection} onProviderChange={() => {}} onOpenKey={(id) => opened.push(id)}
			onConnectionChange={(patch) => { settings = { ...settings, ...patch }; setConnection(settings); }} />;
	}
	const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
	const mount = () => act(async () => root.render(<Harness />));
	const type = (input: HTMLInputElement, value: string) => act(async () => {
		// linkedom has no native input-event support, so React tracks text
		// inputs through its legacy fallback: focus attaches a
		// propertychange listener (stubbed in before()), which a value
		// change then fires.
		input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
		Object.defineProperty(input, "value", { configurable: true, writable: true, value });
		(input as unknown as { propertyChange: (e: { propertyName: string }) => void }).propertyChange({ propertyName: "value" });
	});
	const click = (id: string) => act(async () => q<HTMLButtonElement>(id)!.click());
	const optionIds = () => [...document.querySelectorAll('[data-testid^="provider-option-"]')].map((node) => node.getAttribute("data-testid")).sort();

	it("defaults to OpenAI; a missing key is red and links to its Providers paste field", async () => {
		await mount();
		const picker = q<HTMLButtonElement>("dictation-row-key-provider")!;
		assert.match(picker.textContent ?? "", /OpenAI/);
		assert.equal(picker.getAttribute("aria-invalid"), "true");
		assert.match(picker.className, /border-destructive/);
		assert.equal(picker.getAttribute("title"), "No OpenAI API key configured");
		assert.match(q("dictation-row-key-missing")!.textContent ?? "", /No OpenAI API key · Add in Providers/);
		await click("dictation-row-key-missing");
		assert.deepEqual(opened, ["OPENAI_API_KEY"]);
		assert.equal(q("dictation-row-key")!.closest("details"), null, "the key row is not under Advanced connection");
	});

	it("lists saved keys plus OpenAI always, so the default can be picked again", async () => {
		keys = [key("GROQ_API_KEY", "…gq34 (56 chars)"), key("MOONSHOT_API_KEY", "…ms56 (40 chars)")];
		await mount();
		await click("dictation-row-key-provider");
		assert.deepEqual(optionIds(), ["provider-option-groq", "provider-option-moonshotai", "provider-option-openai"], "saved keys, one per env var, plus OpenAI");
		assert.match(q("provider-option-openai")!.textContent ?? "", /not set/);
		assert.match(q("provider-option-groq")!.textContent ?? "", /…gq34 · 56/);
		await click("provider-option-groq");
		assert.equal(settings.keySource, "GROQ_API_KEY");
		assert.equal(q("dictation-row-key-missing"), null);
		await click("dictation-row-key-provider");
		await click("provider-option-openai");
		assert.equal(settings.keySource, "OPENAI_API_KEY", "OpenAI stays selectable after picking another provider");
	});

	it("the Provider | Custom switch swaps one slot and restores the last provider", async () => {
		keys = [key("GROQ_API_KEY", "…gq34 (56 chars)")];
		settings = { keySource: "GROQ_API_KEY" };
		await mount();
		const slot = q("dictation-row-key-provider")!.parentElement!;
		const custom = q("dictation-row-key-source-custom")!;
		assert.equal(q("dictation-row-key-source-provider")!.getAttribute("aria-checked"), "true");
		await click("dictation-row-key-source-custom");
		assert.equal(settings.keySource, "custom");
		assert.equal(q("dictation-row-key-custom")!.parentElement, slot, "the custom key takes the picker's slot");
		assert.equal(q("dictation-row-key-source-custom"), custom, "the switch stays the same element");
		assert.equal(custom.getAttribute("aria-checked"), "true");
		await click("dictation-row-key-source-provider");
		assert.equal(settings.keySource, "GROQ_API_KEY", "back to the provider picked before");
	});

	it("the custom key is read-only at rest; edits save only on Save, and Cancel discards", async () => {
		settings = { keySource: "custom" };
		await mount();
		const rest = q<HTMLButtonElement>("dictation-row-key-custom")!;
		assert.equal(rest.tagName, "BUTTON", "no typeable field at rest");
		assert.equal(rest.querySelector("input"), null);
		assert.match(rest.textContent ?? "", /Custom key/);
		assert.match(rest.textContent ?? "", /not set/);
		assert.equal(q("dictation-row-key-editor"), null);

		await act(async () => rest.click());
		assert.equal(q("dictation-row-key-custom"), null, "the row itself becomes the editor — no second box");
		assert.equal(document.querySelectorAll('[data-testid="dictation-row-key"] input').length, 1);
		await type(q<HTMLInputElement>("dictation-row-key-input")!, "discard-me");
		await click("dictation-row-key-cancel");
		assert.equal(q("dictation-row-key-editor"), null);
		assert.deepEqual(writes, [], "Cancel never writes");

		await act(async () => q<HTMLButtonElement>("dictation-row-key-custom")!.click());
		assert.equal(q("dictation-row-key-delete"), null, "nothing to delete yet");
		await type(q<HTMLInputElement>("dictation-row-key-input")!, "test-only-custom-key");
		await click("dictation-row-key-save");
		assert.deepEqual(writes, [{ url: "/api/keys/STT_API_KEY", method: "PUT", body: { value: "test-only-custom-key" } }]);
		assert.equal(q("dictation-row-key-editor"), null, "the editor folds after saving");
		assert.match(q("dictation-row-key-custom")!.textContent ?? "", /…cus1 · 20/);

		await act(async () => q<HTMLButtonElement>("dictation-row-key-custom")!.click());
		await click("dictation-row-key-delete");
		assert.deepEqual(writes[1], { url: "/api/keys/STT_API_KEY", method: "DELETE", body: undefined });
		assert.match(q("dictation-row-key-custom")!.textContent ?? "", /not set/);
	});
});
