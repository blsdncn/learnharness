/** Update UI with a fake preload bridge: no Electron, network or updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings, updateStatusText, MANUAL_UPDATE_HINT, AUTO_UPDATE_HINT, type UpdateState } from "../components/settings/update-settings.tsx";
import UpdateBanner from "../components/update-banner.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
	HTMLInputElement: dom.window.HTMLInputElement,
	// The model menus' MenuShell positions itself on the next frame.
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const state = (over: Partial<UpdateState> = {}): UpdateState => ({ status: "idle", version: null, revision: 0, ...over });
const props = { autoUpdate: true, onAutoUpdateChange: () => {}, version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function bridge(initial = state(), snapshot = Promise.resolve(initial)) {
	const listeners = new Set<(value: UpdateState) => void>();
	const calls = { check: 0, install: 0, get: 0 };
	let onOpen: ((section: string) => void) | null = null;
	let checkFailure: Error | null = null;
	window.lh = {
		expandWindow() {},
		getUpdateState: () => { calls.get++; return snapshot; },
		onUpdateStatus: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
		checkForUpdates: async () => { calls.check++; if (checkFailure) throw checkFailure; },
		installUpdate: () => { calls.install++; },
		onOpenSettings: cb => { onOpen = cb; return () => { onOpen = null; }; },
	};
	return {
		calls, listeners,
		failCheck: () => { checkFailure = new Error("sensitive raw diagnostics"); },
		push: async (value: UpdateState) => { await act(async () => { for (const listener of listeners) listener(value); }); },
		open: async () => { await act(async () => onOpen?.("general")); },
	};
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function click(element: HTMLElement | null) {
	assert.ok(element, "missing click target");
	await act(async () => { element.click(); });
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	delete window.lh;
	globalThis.fetch = originalFetch;
});

describe("version and contextual copy", () => {
	it("build metadata comes from package.json and exposes only public version/homepage values", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.deepEqual(nextConfig.env, { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage });
	});

	it("never claims live/latest information and keeps updater errors generic", () => {
		assert.equal(updateStatusText(null), null);
		assert.equal(updateStatusText(state()), null);
		assert.equal(updateStatusText(state({ status: "disabled" })), null);
		assert.equal(updateStatusText(state({ status: "checking" })), "Checking for updates…");
		assert.equal(updateStatusText(state({ status: "downloading", version: "0.3.8" })), "Downloading version 0.3.8…");
		assert.equal(updateStatusText(state({ status: "up-to-date" })), "No newer version was found at the last check.");
		assert.equal(updateStatusText(state({ status: "downloaded", version: "0.3.8" })), "Version 0.3.8 is ready. It will install when you quit the app.");
		assert.equal(updateStatusText(state({ status: "error" })), "Couldn’t check for updates. Try again later.");
		assert.equal(updateStatusText(state({ status: "downloading" })), "Downloading an update…");
		assert.equal(updateStatusText(state({ status: "downloaded" })), "An update is ready. It will install when you quit the app.");
	});
});

describe("General update rows", () => {
	it("browser/SSR shows version and installed-version release notes, without inactive controls or claims", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes(`${props.homepage}/releases/tag/v0.3.7`));
		assert.ok(!html.includes("update-check")); assert.ok(!html.includes("row-auto-update"));
		assert.ok(!html.includes(MANUAL_UPDATE_HINT)); assert.ok(!html.includes("update-status"));
	});

	it("unpackaged/unavailable updater shows the version-only surface", async () => {
		const b = bridge(state({ status: "disabled" })); const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version")); assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null); assert.equal(b.calls.check, 0);
	});

	it("idle shows two rows and clear consequences; opening Settings never checks", async () => {
		const b = bridge(); const seen: boolean[] = [];
		const host = await mount(<UpdateSettings {...props} onAutoUpdateChange={value => seen.push(value)} />);
		assert.deepEqual([...host.children].map(el => el.getAttribute("data-testid")), ["row-version", "row-auto-update"]);
		assert.ok(q(host, "row-version")!.contains(q(host, "update-check")));
		assert.ok(host.textContent!.includes(MANUAL_UPDATE_HINT)); assert.ok(host.textContent!.includes(AUTO_UPDATE_HINT));
		assert.equal(q(host, "update-status"), null); assert.equal(b.calls.check, 0);
		await click(q(host, "toggle-auto-update")); assert.deepEqual(seen, [false]);
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("manual check remains available while automatic checks are OFF", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} autoUpdate={false} />);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("checking/downloading shows context and disables only the UI button; ready offers Restart", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "checking", revision: 1 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		assert.equal(q(host, "update-check")!.getAttribute("aria-busy"), "true");
		assert.equal(q(host, "update-status")!.textContent, "Checking for updates…");
		await b.push(state({ status: "downloading", version: "0.3.8", revision: 2 }));
		assert.equal(q(host, "update-status")!.textContent, "Downloading version 0.3.8…");
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, true);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 3 }));
		assert.equal(q(host, "update-check"), null); assert.ok(q(host, "update-status")!.textContent!.includes("quit the app"));
		await click(q(host, "update-restart")); assert.equal(b.calls.install, 1);
	});

	it("up-to-date and failure statuses allow another manual check", async () => {
		const b = bridge(); const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "up-to-date", revision: 1 }));
		assert.equal(q(host, "update-status")!.textContent, "No newer version was found at the last check.");
		await b.push(state({ status: "error", revision: 2 }));
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, false);
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		await click(q(host, "update-check")); assert.equal(b.calls.check, 1);
	});

	it("bridge command rejection is handled without exposing raw diagnostics", async () => {
		const b = bridge(); b.failCheck(); const host = await mount(<UpdateSettings {...props} />);
		await click(q(host, "update-check"));
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});

	it("late Settings and banner subscribers recover the staged update without an event", async () => {
		const b = bridge(state({ status: "downloaded", version: "0.3.8", revision: 5 }));
		const host = await mount(<><UpdateSettings {...props} /><UpdateBanner /></>);
		assert.ok(q(host, "update-restart")); assert.ok(q(host, "update-banner"));
		assert.ok(q(host, "update-banner")!.textContent!.includes("0.3.8"));
		await click(q(host, "update-banner")!.querySelector("button")); assert.equal(b.calls.install, 1);
		assert.equal(b.calls.check, 0);
	});

	it("a delayed older snapshot cannot overwrite a newer push in Settings or the banner", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<><UpdateSettings {...props} /><UpdateBanner /></>);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 4 }));
		await act(async () => { snapshot.resolve(state({ status: "checking", revision: 3 })); });
		assert.ok(q(host, "update-restart")); assert.ok(q(host, "update-banner"));
	});

	it("snapshot rejection cannot erase an already received event and late callbacks are unsubscribed", async () => {
		const snapshot = deferred<UpdateState>(); const b = bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await b.push(state({ status: "downloaded", version: "0.3.8", revision: 1 }));
		await act(async () => { snapshot.reject(new Error("IPC disconnected")); });
		assert.ok(q(host, "update-restart"));
		const { root } = roots.pop()!; await act(async () => { root.unmount(); }); host.remove();
		assert.equal(b.listeners.size, 0);
	});

	it("snapshot rejection without an event is handled with a generic message", async () => {
		const snapshot = deferred<UpdateState>(); bridge(state(), snapshot.promise);
		const host = await mount(<UpdateSettings {...props} />);
		await act(async () => { snapshot.reject(new Error("sensitive error")); });
		assert.equal(q(host, "update-status")!.textContent, "Couldn’t check for updates. Try again later.");
		assert.ok(!host.textContent!.includes("sensitive"));
	});
});

describe("Settings integration", () => {
	it("the toggle sends the complete General section and follows stored server truth", async () => {
		bridge();
		// A synthetic future sibling exercises the caller's section-preserving
		// contract without introducing a new product setting or changing its API.
		const record = { version: 1, general: { autoUpdate: true, futureSibling: "keep" } };
		const puts: unknown[] = [];
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), init?.method === "PUT" ? "/api/settings/general" : "/api/settings");
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)); puts.push(body);
				return Response.json({ settings: { ...record, general: body } });
			}
			return Response.json({ settings: record });
		};
		const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
		await click(q(host, "toggle-auto-update"));
		assert.deepEqual(puts, [{ autoUpdate: false, futureSibling: "keep" }]);
		assert.equal(q(host, "toggle-auto-update")!.getAttribute("aria-checked"), "false");
	});


	it("the dictation provider (in Providers) and General edits never clobber each other", async () => {
		bridge();
		let record = { version: 1, general: { autoUpdate: true, dictationProvider: "deepgram" } };
		const first = deferred<Response>();
		const puts: Record<string, unknown>[] = [];
		globalThis.fetch = async (input, init) => {
			if (String(input) === "/api/keys") return Response.json({ keys: [] });
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)); puts.push(body);
				if (puts.length === 1) return first.promise;
				record = { ...record, general: body };
				return Response.json({ settings: record });
			}
			return Response.json({ settings: record });
		};
		const host = await mount(<SettingsDialogBody initialSection="keys" onClose={() => {}} />);
		assert.equal(q(host, "settings-nav-speech")!.textContent, "TTS");
		assert.equal(q(host, "settings-nav-dictation"), null, "dictation lives in Providers");
		assert.ok(q(host, "group-dictation")!.contains(q(host, "dictation-provider")));
		const selector = q(host, "dictation-provider") as HTMLSelectElement;
		await act(async () => { Object.defineProperty(selector, "value", { configurable: true, value: "openai" }); selector.dispatchEvent(new window.Event("change", { bubbles: true })); });
		await click(q(host, "settings-nav-general"));
		await click(q(host, "toggle-auto-update"));
		assert.equal(puts.length, 1, "the second edit waits for the first response");
		await act(async () => { record = { ...record, general: puts[0] as typeof record.general }; first.resolve(Response.json({ settings: record })); });
		assert.deepEqual(puts, [ { autoUpdate: true, dictationProvider: "openai" }, { autoUpdate: false, dictationProvider: "openai" } ]);
	});

	it("Providers → Dictation: Deepgram, OpenAI, or the connected custom endpoint with its model", async () => {
		bridge();
		let record: Record<string, unknown> = { version: 1, general: { dictationProvider: "deepgram" }, dictation: { language: "pl" } };
		const puts: [string, unknown][] = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url === "/api/keys") return Response.json({ keys: [], providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
			if (url.startsWith("/api/stt/custom-endpoint")) return Response.json({ baseUrl: "http://local.test/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "whisper-large" }, { id: "whisper-local" }], overrides: {}, manualModels: [] }, { headers: { etag: '"1"' } });
			if (url.startsWith("/api/tts/custom-endpoint") || url.startsWith("/api/custom-provider")) return Response.json({ baseUrl: "", models: [] }, { headers: { etag: '"t"' } });
			if (init?.method === "PUT") {
				const section = url.replace("/api/settings/", "");
				const body = JSON.parse(String(init.body)); puts.push([section, body]);
				record = { ...record, [section]: body };
				return Response.json({ settings: record });
			}
			return Response.json({ settings: record });
		};
		const { notifySettingsSaved } = await import("../components/settings-signal.ts");
		const host = await mount(<SettingsDialogBody initialSection="keys" onClose={() => {}} />);
		await act(async () => { notifySettingsSaved("dictation"); }); // a fresh language store read
		assert.deepEqual(Array.from((q(host, "dictation-provider") as HTMLSelectElement).options).map((o) => o.value), ["deepgram", "openai", "custom"]);
		assert.ok(q(host, "dictation-setup-hint"));
		assert.ok(q(host, "key-deepgram_api_key"));
		assert.equal(q(host, "dictation-openai-key"), null);
		assert.equal(q(host, "dictation-custom-model"), null);
		assert.match(q(host, "stt-custom-endpoint-status")!.textContent ?? "", /http:\/\/local\.test\/v1 · 2 models · keyless/);
		const change = async (value: string) => {
			const select = q(host, "dictation-provider") as HTMLSelectElement;
			await act(async () => { Object.defineProperty(select, "value", { configurable: true, value }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
		};
		await change("openai");
		assert.equal(q(host, "dictation-setup-hint"), null, "the Deepgram setup hint gives way");
		assert.equal(q(host, "key-deepgram_api_key"), null, "OpenAI's key row replaces Deepgram's");
		assert.match(q(host, "dictation-openai-key-status")!.textContent ?? "", /not set/);
		await click(q(host, "dictation-openai-key"));
		assert.ok(q(host, "key-openai-editor"), "opens the OpenAI paste field in Model API keys");

		await change("custom");
		assert.deepEqual(puts.at(-1), ["general", { dictationProvider: "custom" }]);
		assert.equal(q(host, "dictation-openai-key"), null);
		assert.match(q(host, "dictation-custom-model-row")!.textContent ?? "", /Required/);
		await click(q(host, "dictation-custom-model"));
		await click(q(document, "dictation-custom-model-option-whisper-large")!);
		assert.deepEqual(puts.at(-1), ["dictation", { language: "pl", customModel: "whisper-large" }], "the language rides along");
		assert.match(q(host, "dictation-custom-model")!.textContent ?? "", /whisper-large/);
	});

	it("Providers → TTS: OpenAI by default; a custom endpoint joins once added", async () => {
		bridge();
		let record: Record<string, unknown> = { version: 1, speech: { enabled: true, voice: "nova" } };
		const puts: [string, unknown][] = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url === "/api/keys") return Response.json({ keys: [{ id: "OPENAI_API_KEY", info: null, present: true, masked: "…abcd (51 chars)", source: "file", shadowedByEnv: false }], providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
			if (url.startsWith("/api/tts/custom-endpoint")) return Response.json({ baseUrl: "http://speech.test/v1", authMode: "apiKey", keySource: "file", keyPresent: true, keyReuseRequired: false, models: [{ id: "kokoro" }], overrides: {}, manualModels: [] }, { headers: { etag: '"1"' } });
			if (url.startsWith("/api/stt/custom-endpoint") || url.startsWith("/api/custom-provider")) return Response.json({ baseUrl: "", models: [] }, { headers: { etag: '"s"' } });
			if (init?.method === "PUT") {
				const section = url.replace("/api/settings/", "");
				const body = JSON.parse(String(init.body)); puts.push([section, body]);
				record = { ...record, [section]: body };
				return Response.json({ settings: record });
			}
			return Response.json({ settings: record });
		};
		const host = await mount(<SettingsDialogBody initialSection="keys" onClose={() => {}} />);
		const group = q(host, "group-tts")!;
		assert.ok(group.contains(q(host, "tts-provider")));
		assert.match(q(host, "tts-openai-key-status")!.textContent ?? "", /set in Model API keys/);
		assert.match(q(host, "tts-custom-endpoint-status")!.textContent ?? "", /http:\/\/speech\.test\/v1 · 1 model · API key/);
		assert.equal(q(host, "tts-add-provider"), null, "one endpoint per feature");
		const select = q(host, "tts-provider") as HTMLSelectElement;
		assert.deepEqual(Array.from(select.options).map((o) => o.value), ["openai", "custom"]);
		await act(async () => { Object.defineProperty(select, "value", { configurable: true, value: "custom" }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
		assert.deepEqual(puts.at(-1), ["speech", { enabled: true, voice: "nova", provider: "custom" }], "the section's other fields ride along");
		await click(q(host, "tts-custom-endpoint-row-btn"));
		assert.match(q(host, "tts-custom-path-note")!.textContent ?? "", /Calls POST http:\/\/speech\.test\/v1\/audio\/speech/);
		await click(q(host, "tts-custom-model"));
		await click(q(document, "tts-custom-model-option-kokoro")!);
		assert.deepEqual(puts.at(-1), ["speech", { enabled: true, voice: "nova", provider: "custom", customModel: "kokoro" }]);
	});

	it("the shell's navigation request opens General, but opening alone never checks", async () => {
		const b = bridge();
		globalThis.fetch = async () => Response.json({ settings: { version: 1 } });
		const host = await mount(<SettingsDialogProvider><span>app</span></SettingsDialogProvider>);
		assert.equal(q(document, "settings-dialog"), null);
		await b.open();
		assert.equal(q(document, "settings-nav-general")!.getAttribute("aria-current"), "true");
		assert.ok(q(document, "row-version")); assert.equal(b.calls.check, 0);
		assert.ok(host.textContent!.includes("app"));
	});
});
