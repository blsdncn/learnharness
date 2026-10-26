import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { createCodex, codexFileStore, codexControl, attachCodexChild } = require("../electron/codex.cjs");
const credentials = (expires = Date.now() + 3600000) => ({ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", accountId: "fixture-account", expires });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function settled(service: any) {
	for (let i = 0; i < 100; i++) { const value = await service.status(); if (!value.status.pending) return value; await new Promise((resolve) => setImmediate(resolve)); }
	throw new Error("Login never settled");
}
function fixture(options: { credential?: any; login?: (interaction: any) => Promise<any>; refresh?: (credential: any) => Promise<any>; write?: (credential: any) => Promise<void> } = {}) {
	let saved = options.credential ?? null;
	const pushes: any[] = [];
	let refreshes = 0;
	const service = createCodex({
		store: { async read() { return saved; }, async write(value: any) { await options.write?.(value); saved = value; } },
		loadOAuth: async () => ({ login: options.login ?? (async () => credentials()), refresh: async (value: any) => { refreshes++; return options.refresh ? options.refresh(value) : credentials(); } }),
		openExternal: async () => {}, onChange: (value: any) => pushes.push(value),
	});
	return { service, pushes, get saved() { return saved; }, get refreshes() { return refreshes; } };
}

test("Codex login saves private credentials and only safe status reaches controls/events", async () => {
	const f = fixture();
	try {
		assert.equal((await f.service.status()).status.connected, false);
		assert.equal((await codexControl({ op: "login" }, f.service)).pending, true);
		const value = await settled(f.service);
		assert.equal(value.status.connected, true);
		assert.equal(f.saved.type, "oauth");
		const safe = JSON.stringify([f.pushes, await codexControl({ op: "status" }, f.service)]);
		assert.doesNotMatch(safe, /fixture-access|fixture-refresh|fixture-account/);
		assert.equal((await f.service.lease(value.epoch)).accessToken, "fixture-access");
		await assert.rejects(f.service.lease(value.epoch - 1));
		assert.match((await codexControl({ op: "lease" }, f.service)).error, /Unsupported/);
	} finally { f.service.close(); }
});

test("concurrent expired leases rotate once and persist before returning credentials", async () => {
	const f = fixture({ credential: credentials(0) });
	try {
		const { epoch } = await f.service.status();
		const values = await Promise.all(Array.from({ length: 8 }, () => f.service.lease(epoch)));
		assert.equal(f.refreshes, 1);
		assert(values.every((v) => v.accessToken === f.saved.access));
	} finally { f.service.close(); }
});

test("refresh failures are sanitized; no usable credential or fallback escapes", async () => {
	const f = fixture({ credential: credentials(0), refresh: async () => { throw new Error("SECRET-refresh-response"); } });
	try {
		await assert.rejects(f.service.lease((await f.service.status()).epoch), /No API-key fallback|no API-key fallback/);
		assert.doesNotMatch(JSON.stringify(await f.service.status()), /SECRET/);
	} finally { f.service.close(); }
});

test("failed durable rotation denies later leases even if memory held a credential", async () => {
	const f = fixture({ credential: credentials(0), write: async () => { throw new Error("disk full"); } });
	try {
		await assert.rejects(f.service.lease((await f.service.status()).epoch));
		const value = await f.service.status();
		assert.equal(value.status.connected, false); assert.equal(value.status.available, false);
		await assert.rejects(f.service.lease(value.epoch));
	} finally { f.service.close(); }
});

test("cancelled login cannot save a late result or resurrect a disconnected account", async () => {
	const gate = deferred<any>();
	const f = fixture({ login: () => gate.promise });
	try {
		await f.service.login();
		await f.service.disconnect();
		gate.resolve(credentials());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.saved, null); assert.equal((await f.service.status()).status.connected, false);
	} finally { f.service.close(); }
});

test("disconnect during refresh invalidates queued leases and removes rotated tokens", async () => {
	const gate = deferred<any>();
	const entered = deferred<void>();
	const f = fixture({ credential: credentials(0), refresh: () => { entered.resolve(); return gate.promise; } });
	try {
		const request = assert.rejects(f.service.lease((await f.service.status()).epoch));
		await entered.promise;
		const disconnected = f.service.disconnect();
		await new Promise((resolve) => setImmediate(resolve));
		gate.resolve(credentials());
		await request; await disconnected;
		assert.equal(f.saved, null);
	} finally { f.service.close(); }
});

test("manual callback submission stays out of public snapshots", async () => {
	const entered = deferred<void>(); let input = "";
	const f = fixture({ login: async (interaction) => {
		assert.equal(await interaction.prompt({ type: "select" }), "browser");
		const prompt = interaction.prompt({ type: "manual_code" }); entered.resolve();
		input = await prompt; return credentials();
	} });
	try {
		await f.service.login(); await entered.promise;
		assert.equal((await f.service.status()).status.manualCode, true);
		const result = await codexControl({ op: "submit", value: "private-code" }, f.service);
		assert.doesNotMatch(JSON.stringify(result), /private-code/);
		assert.equal((await settled(f.service)).status.connected, true);
		assert.equal(input, "private-code");
	} finally { f.service.close(); }
});

test("private child IPC alone can obtain leases; unknown operations fail closed", async () => {
	const f = fixture({ credential: credentials() });
	const child = Object.assign(new EventEmitter(), { connected: true, send: (value: any, callback: () => void) => { replies.push(value); callback(); } });
	const replies: any[] = [];
	const attachment = attachCodexChild(child, f.service);
	try {
		child.emit("message", { channel: "other", id: "ignored", op: "lease", epoch: 0 });
		child.emit("message", { channel: "lh:codex", id: "lease", op: "lease", epoch: 0 });
		child.emit("message", { channel: "lh:codex", id: "invalid", op: "read-file" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(replies.length, 2);
		assert.equal(replies.find((r) => r.id === "lease").value.accessToken, "fixture-access");
		assert.equal(replies.find((r) => r.id === "invalid").ok, false);
	} finally { attachment.dispose(); f.service.close(); }
});

test("Codex credentials persist atomically with private permissions and malformed files fail closed", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-codex-auth-"));
	const file = path.join(dir, "codex-credentials.json");
	try {
		const store = codexFileStore(file);
		assert.equal(await store.read(), null);
		await store.write(credentials()); assert.equal((await store.read()).access, "fixture-access");
		if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
		assert.deepEqual(await fs.readdir(dir), ["codex-credentials.json"]);
		await store.write(null); assert.equal(await store.read(), null);
		await fs.writeFile(file, "broken"); await assert.rejects(store.read());
		await assert.rejects(store.write({ type: "api_key", key: "sk-invalid" }));
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});
