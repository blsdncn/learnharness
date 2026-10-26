import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RemoteAccessSection } from "../components/settings/remote-access-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
});
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete (window as unknown as Record<string, unknown>).lh; });

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const STATUS = { available: true, enabled: true, url: "https://phone.test.ts.net:8443", error: null, devices: [] };

test("overlapping pair responses resolve out of order: only the latest link displays", async () => {
	const pending: ReturnType<typeof deferred<Record<string, unknown>>>[] = [];
	let pairCalls = 0;
	(window as unknown as Record<string, unknown>).lh = {
		remote: {
			status: async () => STATUS,
			pair: () => { pairCalls++; const d = deferred<Record<string, unknown>>(); pending.push(d); return d.promise; },
			onChange: () => () => {},
		},
	};
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<RemoteAccessSection />));
	// Flush the initial status() load.
	await act(async () => {});
	const pairButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Create one-time pairing link")!;
	const field = () => document.querySelector('input[aria-label="One-time pairing link"]') as HTMLInputElement | null;
	assert.ok(pairButton(), "pair button renders once enabled");
	// Two activations in one batch ride the same stale busy=false, so both invoke pair().
	await act(async () => { pairButton().click(); pairButton().click(); });
	assert.equal(pairCalls, 2, "both activations reach the bridge");
	const url = (n: number) => `https://phone.test.ts.net:8443/_lh/remote/pair#grant=grant-${n}`;
	const stamp = (n: number) => Date.now() + 60_000 + n;
	// Newest resolves first, then the stale one: display must keep the newest.
	await act(async () => pending[1]!.resolve({ ...STATUS, pairingUrl: url(2), pairingExpiresAt: stamp(2) }));
	assert.equal(field()?.value, url(2));
	await act(async () => pending[0]!.resolve({ ...STATUS, pairingUrl: url(1), pairingExpiresAt: stamp(1) }));
	assert.equal(field()?.value, url(2), "stale first response must not replace the latest link");
});
