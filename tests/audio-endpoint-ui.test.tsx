/** Providers → TTS: adding a feature's own custom endpoint through
 * upstream's connect form, its live request-path note, and the dropdown. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";

// DOM globals before React loads: react-dom decides input-event support at
// import, from `oninput in document` (linkedom has none — declare it).
const dom = parseHTML("<html><body></body></html>");
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
const React = (await import("react")).default;
(globalThis as Record<string, unknown>).React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { KeysSection } = await import("../components/settings/keys-section.tsx");

const originalFetch = globalThis.fetch;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; globalThis.fetch = originalFetch; });

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function element(id: string) { const node = q(id); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => { element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); }
async function type(id: string, value: string) {
	const input = element(id) as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
const options = (id: string) => Array.from((element(id) as HTMLSelectElement).options).map((o) => o.value);

for (const feature of [
	{ name: "TTS", prefix: "tts", route: "/api/tts/custom-endpoint", path: "/audio/speech", key: "CUSTOM_TTS_API_KEY", builtIns: ["openai"] },
] as const) test(`${feature.name}: + Add a provider opens upstream's form at the feature's own route`, async () => {
	let status: Record<string, unknown> = { baseUrl: "", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [], overrides: {}, manualModels: [] };
	const posts: { url: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith(feature.route)) {
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				posts.push({ url, body });
				status = { ...status, baseUrl: "http://local.test/v1", authMode: body.authMode, keyPresent: Boolean(body.key), keySource: body.key ? "file" : "none", models: [{ id: "model-b" }, { id: "model-a" }] };
				return Response.json({ ok: true }, { headers: { etag: '"2"' } });
			}
			return Response.json(status, { headers: { etag: '"1"' } });
		}
		if (url.startsWith("/api/") && url.includes("custom")) return Response.json({ baseUrl: "", models: [] }, { headers: { etag: '"x"' } });
		if (url === "/api/keys") return Response.json({ keys: [], providers: [] });
		return Response.json({ settings: { version: 1 } });
	}) as typeof fetch;
	const picks: string[] = [];
	const models: string[] = [];
	const choice = (provider: string) => ({ provider, onProvider: (p: string) => picks.push(p), customModel: undefined, onCustomModel: (m: string) => models.push(m) });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const render = (provider: string) => act(async () => root.render(<KeysSection tts={choice(provider) as never} />));
	cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
	await render(feature.builtIns[0]);

	assert.deepEqual(options(`${feature.prefix}-provider`), feature.builtIns, "Custom joins only once added");
	await click(`${feature.prefix}-add-provider`);
	assert.match(element("provider-option-custom").textContent ?? "", new RegExp(`Custom endpoint.*${feature.key}`), "the feature's own key name");
	await click("provider-option-custom");
	const p = "tts-";
	assert.equal(q(`${p}custom-pins`), null, "no chat budget pins");
	assert.equal(q(`${p}custom-reasoning-help`), null);
	assert.equal(element(`${p}custom-path-note`).textContent, `Calls POST <base URL>${feature.path} · models are listed from <base URL>/models`);
	await type(`${p}custom-baseurl-input`, "http://local.test/v1/");
	assert.equal(element(`${p}custom-path-note`).textContent,
		`Calls POST http://local.test/v1${feature.path} · models are listed from http://local.test/v1/models`, "live from the typed URL; /v1 is never added");
	await type(`${p}custom-models-input`, "model-a");
	await click(`${p}custom-save`);
	assert.deepEqual(posts.map((r) => [r.url, r.body.baseUrl, r.body.authMode, r.body.manualModels]), [[feature.route, "http://local.test/v1/", "keyless", "model-a"]]);

	assert.match(element(`${p}custom-endpoint-status`).textContent ?? "", /http:\/\/local\.test\/v1 · 2 models · keyless/);
	assert.equal(q(`${feature.prefix}-add-provider`), null, "one endpoint per feature");
	assert.deepEqual(options(`${feature.prefix}-provider`), [...feature.builtIns, "custom"]);
	assert.deepEqual(picks, [], "connecting never switches the provider by itself");

	await render("custom");
	await click(`${feature.prefix}-custom-model`);
	assert.deepEqual(Array.from(element(`${feature.prefix}-custom-model-list`).querySelectorAll("li")).map((li) => li.textContent), ["model-a", "model-b"]);
	await click(`${feature.prefix}-custom-model-option-model-b`);
	assert.deepEqual(models, ["model-b"]);
});

test("the chat endpoint's form names its own path, keeping its pins", async () => {
	globalThis.fetch = (async (input: string) => {
		const url = String(input);
		if (url.startsWith("/api/custom-provider")) return Response.json({ baseUrl: "http://chat.test/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "chat-model" }], overrides: {}, manualModels: [] }, { headers: { etag: '"c"' } });
		return Response.json({ keys: [], providers: [] });
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
	await act(async () => root.render(<KeysSection />));
	await click("custom-endpoint-row-btn");
	assert.equal(element("custom-path-note").textContent, "Calls POST http://chat.test/v1/chat/completions · models are listed from http://chat.test/v1/models");
	assert.ok(q("custom-pins"));
	assert.equal(q("group-tts"), null, "audio groups need the dialog's choices");
});

for (const prefix of ["", "tts-"]) test(`Escape closes the TTS model menu before the ${prefix || "chat"} endpoint editor`, async () => {
	globalThis.fetch = (async (input: string) => {
		if (String(input).includes("custom")) return Response.json({ baseUrl: "http://endpoint.test/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "voice-model" }], overrides: {}, manualModels: [] }, { headers: { etag: '"1"' } });
		return Response.json({ keys: [], providers: [] });
	}) as typeof fetch;
	// linkedom does not order capture listeners ahead of React's root.
	// Run the real registered document-capture handlers first, as a browser does.
	const capture = new Set<EventListenerOrEventListenerObject>();
	const add = document.addEventListener;
	const remove = document.removeEventListener;
	document.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
		if (type === "keydown" && options === true) capture.add(listener);
		else add.call(this, type, listener, options);
	};
	document.removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
		if (type === "keydown" && options === true) capture.delete(listener);
		else remove.call(this, type, listener, options);
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	cleanup = async () => {
		try { await act(async () => root.unmount()); }
		finally {
			document.addEventListener = add;
			document.removeEventListener = remove;
			host.remove();
		}
	};
	const escape = async (target: HTMLElement) => act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Escape" });
		let stopped = false;
		const stop = event.stopPropagation.bind(event);
		event.stopPropagation = () => { stopped = true; stop(); };
		for (const listener of [...capture]) {
			if (typeof listener === "function") listener.call(document, event);
			else listener.handleEvent(event);
		}
		if (!stopped) target.dispatchEvent(event);
	});
	await act(async () => root.render(<KeysSection tts={{ provider: "custom", onProvider() {}, customModel: "voice-model", onCustomModel() {} }} />));
	await click(`${prefix}custom-endpoint-row-btn`);
	await click("tts-custom-model");
	assert.ok(q(`${prefix}custom-endpoint-editor`));
	assert.ok(q("tts-custom-model-menu"));
	await escape(element("tts-custom-model-search"));
	assert.equal(q("tts-custom-model-menu"), null, "the topmost menu closes first");
	assert.ok(q(`${prefix}custom-endpoint-editor`), "the editor underneath stays open");
	await escape(element(`${prefix}custom-baseurl-input`));
	assert.equal(q(`${prefix}custom-endpoint-editor`), null, "the next Escape folds the editor");
});
