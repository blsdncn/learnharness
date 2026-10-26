import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CodexConnection, CODEX_NOTICE } from "../components/settings/codex-connection.tsx";
import type { CodexStatus, CodexControlBridge } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
const disconnected = (): CodexStatus => ({ available: true, connected: false, pending: false, manualCode: false, error: null });
function fixture() {
	let status = disconnected();
	let loginCalls = 0, cancelCalls = 0;
	const listeners = new Set<() => void>();
	const push = (next: CodexStatus) => { status = next; for (const listener of listeners) listener(); };
	const bridge: CodexControlBridge = {
		status: async () => status,
		login: async () => { loginCalls++; push({ ...status, pending: true }); return status; },
		cancel: async () => { cancelCalls++; push({ ...status, pending: false }); return status; },
		submit: async () => status,
		disconnect: async () => { push(disconnected()); return status; },
		onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
	};
	window.lh = { expandWindow() {}, codex: bridge };
	return { push, bridge, get loginCalls() { return loginCalls; }, get cancelCalls() { return cancelCalls; } };
}
async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<CodexConnection />));
}
function button(text: string) { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text); assert(value, `missing button: ${text}`); return value; }
async function click(text: string) { await act(async () => button(text).click()); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; });

test("subscription has an explicit sign-in action and disclosure before OAuth starts", async () => {
	const f = fixture(); await mount();
	await click("Sign in with Codex subscription");
	assert.equal(f.loginCalls, 0); assert(document.body.textContent?.includes(CODEX_NOTICE));
	await click("Continue to OpenAI");
	assert.equal(f.loginCalls, 1); assert(document.body.textContent?.includes("Waiting for OpenAI sign-in"));
	await click("Cancel sign-in"); assert.equal(f.cancelCalls, 1);
});

test("verified completion advances model discovery and hides the pending form", async () => {
	const f = fixture(); let changes = 0;
	const onChange = () => { changes++; };
	window.addEventListener("lh:settings-saved", onChange);
	try {
		await mount(); await click("Sign in with Codex subscription"); await click("Continue to OpenAI");
		await act(async () => f.push({ ...disconnected(), connected: true }));
		assert(document.body.textContent?.includes("Connected · ChatGPT plan"));
		assert(!document.querySelector("input")); assert.equal(changes, 1);
	} finally { window.removeEventListener("lh:settings-saved", onChange); }
});

test("an event overtaking the login acknowledgement cannot regress completed sign-in", async () => {
	const f = fixture();
	f.bridge.login = async () => { f.push({ ...disconnected(), connected: true }); return { ...disconnected(), pending: true }; };
	await mount(); await click("Sign in with Codex subscription"); await click("Continue to OpenAI");
	assert(document.body.textContent?.includes("Connected · ChatGPT plan"));
	assert(!document.body.textContent?.includes("Waiting for OpenAI sign-in"));
});

test("browser-only mode never offers an enabled OAuth action", async () => {
	await mount(); assert.equal(button("Sign in with Codex subscription").disabled, true);
});
