import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection, CustomEndpointSetup } from "../components/settings/keys-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
async function mount(setup = false, socketPath?: string, api?: "openai-completions" | "openai-responses") {
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "polish interactions must not save credentials/settings");
		if (String(input).startsWith("/api/custom-provider")) return Response.json({ baseUrl: "http://fixture.invalid/v1", ...(api === undefined ? {} : { api }), ...(socketPath === undefined ? {} : { socketPath }), authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [] }, { headers: { etag: '"fixture"' } });
		return Response.json({ keys: [], providers: [] });
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(setup ? <CustomEndpointSetup onSaved={() => assert.fail("unexpected save")} /> : <KeysSection />));
	if (!setup) await click("custom-endpoint-row-btn");
}
function element(id: string) { const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }
async function selectMode(value: string) {
	const select = element("custom-auth-mode");
	Object.defineProperty(select, "value", { value, configurable: true });
	await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });
for (const setup of [false, true]) {
	test(`${setup ? "Setup" : "Settings"} hides key input in Keyless and reveals it only in API key mode`, async () => {
		await mount(setup);
		assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		await selectMode("apiKey"); assert.equal(element("custom-key-input").getAttribute("type"), "password");
		await selectMode("keyless"); assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		assert.ok(element("custom-save"));
	});
}
test("model controls use approved effort labels, right-align Save limits, and group help below", async () => {
	await mount();
	const select = element("custom-pin-reasoning-fixture-model");
	assert.equal(select.getAttribute("aria-label"), "fixture-model reasoning effort support");
	assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Reasoning effort: Use reported", "Reasoning effort: Supported", "Reasoning effort: Not supported"]);
	assert.deepEqual(Array.from(select.children).map(option => option.getAttribute("value")), ["", "on", "off"], "capability values unchanged");
	const save = element("custom-pins-save"); assert.ok(save.classList.contains("ml-auto")); assert.equal(save.parentElement!.lastElementChild, save);
	const help = element("custom-help"); assert.equal(element("custom-budget-help").parentElement, help); assert.equal(element("custom-reasoning-help").parentElement, help);
	const children = Array.from(element("custom-endpoint-editor").children); assert.ok(children.indexOf(help) > children.indexOf(element("custom-pins")));
	assert.match(help.textContent ?? "", /do not resize backend context/); assert.match(help.textContent ?? "", /Off may not disable/);
});

for (const setup of [false, true]) {
 test(`${setup ? "Setup" : "Settings"} selects and restores Unix socket transport`, async () => {
  await mount(setup, "/run/fixture.sock");
  assert.equal(element("custom-socket-input").getAttribute("value"), "/run/fixture.sock");
  const select = element("custom-transport");
  Object.defineProperty(select, "value", { value: "tcp", configurable: true });
  await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  assert.equal(document.querySelector('[data-testid="custom-socket-input"]'), null);
  Object.defineProperty(select, "value", { value: "unix", configurable: true });
  await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  assert.equal(element("custom-socket-input").getAttribute("value"), "/run/fixture.sock");
 });
}

for (const transport of ["unix", "tcp"]) {
	test(`saving ${transport} transport sends only its selected socket configuration`, async () => {
		await mount(false, "/run/fixture.sock");
		if (transport === "tcp") {
			const select = element("custom-transport");
			Object.defineProperty(select, "value", { value: "tcp", configurable: true });
			await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
		}
		const read = globalThis.fetch;
		const saves: Record<string, unknown>[] = [];
		globalThis.fetch = async (input, init) => {
			if (init?.method === "POST") { saves.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
			return read(input, init);
		};
		await click("custom-save");
		assert.equal(saves.length, 1);
		assert.equal(saves[0]!.api, "openai-completions");
		assert.equal(saves[0]!.baseUrl, "http://fixture.invalid/v1");
		assert.equal(saves[0]!.socketPath, transport === "unix" ? "/run/fixture.sock" : undefined);
	});
}

for (const socketPath of [undefined, "/run/fixture.sock"]) {
 test(`API selection persists and saves Responses over ${socketPath ? "Unix socket" : "TCP"}`, async () => {
  await mount(false, socketPath);
  const select = element("custom-api");
  assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Chat Completions", "Responses"]);
  Object.defineProperty(select, "value", { value: "openai-responses", configurable: true });
  await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  const read = globalThis.fetch; const saves: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
   if (init?.method === "POST") { saves.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
   return read(input, init);
  };
  await click("custom-save");
  assert.equal(saves[0]!.api, "openai-responses"); assert.equal(saves[0]!.socketPath, socketPath);
 });
}
for (const setup of [false, true]) {
 test(`${setup ? "Setup" : "Settings"} restores a saved Responses selection`, async () => {
  await mount(setup, "/run/fixture.sock", "openai-responses");
  const option = Array.from(element("custom-api").children).find(node => node.getAttribute("value") === "openai-responses")!;
  assert.ok((option as HTMLOptionElement).selected);
 });
}
