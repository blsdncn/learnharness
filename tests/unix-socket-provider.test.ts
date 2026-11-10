import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { after, test, type TestContext } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-unix-"));
const originalEnv = process.env;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), ...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}), NODE_ENV: "test", HOME: root, LH_DATA_DIR: root, LH_AUTH_FILE: path.join(root, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const { discoverModels, buildOpenAiCompatibleProvider, customProviderAvailable } = await import("../src/server/custom-provider.ts");
const { customProviderGet, customProviderMutation } = await import("../src/server/custom-provider-http.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { readCustomAuth } = await import("../src/store/auth.ts");
const { customKeyAuthorized, customAuthState } = await import("../src/server/custom-provider-auth.ts");
const { normalizeSocketPath, sanitizeUserSettings, customProviderUsable } = await import("../src/core/settings.ts");
const { parseCustomAuthBinding } = await import("../src/core/custom-provider-auth.ts");
const { unixSocketFetch } = await import("../src/server/unix-socket-fetch.ts");
await import("../src/server/keys.ts");
after(() => { process.env = originalEnv; fs.rmSync(root, { recursive: true, force: true }); });

let sequence = 0;
async function fixture(t: TestContext, handler: http.RequestListener, tcp = false) {
	const address = path.join(root, `${++sequence}.sock`);
	const server = http.createServer(handler);
	server.listen(tcp ? { host: "127.0.0.1", port: 0 } : address);
	await once(server, "listening");
	t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
	return { server, address, base: tcp ? `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1` : "http://local-model.invalid/v1" };
}
function frame(delta: object, finish_reason: string | null = null) {
	return `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}
function finish(res: http.ServerResponse, reason = "stop") { res.end(frame({}, reason) + "data: [DONE]\n\n"); }
const context = () => normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
function provider(socketPath: string, baseUrl = "http://local-model.invalid/v1") {
	return buildOpenAiCompatibleProvider({ baseUrl, socketPath, apiKey: "fixture-key", models: [{ id: "fixture", context: 8192, maxTokens: 128 }] });
}

test("invalid persisted sockets remain disabled, not TCP", () => {
	for (const value of ["relative.sock", "~/llm.sock", "", "/bad\0socket", 17]) {
		assert.equal(normalizeSocketPath(value), "");
		const cp = sanitizeUserSettings({ customProvider: { baseUrl: "http://localhost/v1", socketPath: value } })?.customProvider;
		assert.equal(cp?.socketPath, ""); assert.equal(customProviderUsable(cp), false);
	}
	assert.equal(customProviderUsable({ baseUrl: "https://localhost/v1", socketPath: "/run/llm.sock" }), false);
});

test("discovery uses the socket, API prefix, Host, and optional bearer; no TCP fallback", async t => {
	let tcpRequests = 0;
	const tcp = await fixture(t, (_req, res) => { tcpRequests++; res.end("unexpected TCP"); }, true);
	const seen: { path?: string; host?: string; auth?: string }[] = [];
	const socket = await fixture(t, (req, res) => {
		seen.push({ path: req.url, host: req.headers.host, auth: req.headers.authorization });
		res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
	});
	assert.equal((await discoverModels(tcp.base, "fixture-key", socket.address)).ok, true);
	assert.equal((await discoverModels(tcp.base, undefined, socket.address)).ok, true);
	assert.deepEqual(seen, [
		{ path: "/v1/models", host: new URL(tcp.base).host, auth: "Bearer fixture-key" },
		{ path: "/v1/models", host: new URL(tcp.base).host, auth: undefined },
	]);
	assert.equal((await discoverModels(tcp.base, "fixture-key", path.join(root, "absent.sock"))).ok, false);
	const unavailable = provider(path.join(root, "absent.sock"), tcp.base);
	assert.equal((await unavailable.streamSimple(unavailable.getModels()[0]!, context(), { apiKey: "fixture-key" }).result()).stopReason, "error");
	assert.equal(tcpRequests, 0);
	assert.ok(fs.statSync(socket.address).isSocket(), "the transport never unlinks the server socket");
});

test("Unix requests refuse redirects and foreign origins without TCP traffic", async t => {
	let destinationRequests = 0;
	const tcp = await fixture(t, (_req, res) => { destinationRequests++; res.end("unexpected"); }, true);
	const socket = await fixture(t, (_req, res) => { res.writeHead(302, { location: tcp.base + "/models" }); res.end(); });
	const discovery = await discoverModels(socket.base, undefined, socket.address);
	assert.equal(discovery.ok, false); if (!discovery.ok) assert.equal(discovery.fatal, true);
	await assert.rejects(unixSocketFetch(socket.address, socket.base)(tcp.base), /configured endpoint/);
	assert.equal(destinationRequests, 0);
});

test("Unix transport bypasses framework wrappers of global fetch", async t => {
	const socket = await fixture(t, (_req, res) => { res.end(JSON.stringify({ data: [{ id: "fixture" }] })); });
	const original = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("Framework wrapper must not handle socket requests"); };
	try { assert.equal((await discoverModels(socket.base, undefined, socket.address)).ok, true); }
	finally { globalThis.fetch = original; }
});

test("native provider streams before completion and decodes tool calls", { timeout: 10000 }, async t => {
	let complete!: () => void;
	let call = 0;
	const socket = await fixture(t, async (req, res) => {
		assert.equal(req.url, "/v1/chat/completions");
		assert.equal(req.headers.authorization, "Bearer fixture-key");
		for await (const _chunk of req) { /* drain request */ }
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (++call === 1) {
			const released = new Promise<void>(resolve => { complete = resolve; });
			res.write(frame({ role: "assistant", content: "hello" }));
			await released; finish(res);
		} else {
			res.write(frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "echo", arguments: '{"value":' } }] }));
			res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }));
			finish(res, "tool_calls");
		}
	});
	const p = provider(socket.address);
	const model = p.getModels()[0]!;
	const stream = p.streamSimple(model, context(), { apiKey: "fixture-key" });
	let deltas = 0;
	for await (const event of stream) if (event.type === "text_delta") { deltas++; complete(); }
	assert.ok(deltas > 0);
	assert.equal((await stream.result()).stopReason, "stop");
	const tool = await p.stream(model, context(), { apiKey: "fixture-key" }).result();
	assert.equal(tool.stopReason, "toolUse");
	assert.ok(tool.content.some(block => block.type === "toolCall" && block.name === "echo" && block.arguments.value === "ok"));
});

test("abort cancels an active SSE body and closes the socket connection", { timeout: 10000 }, async t => {
	let closed!: Promise<unknown>;
	const socket = await fixture(t, async (req, res) => {
		for await (const _chunk of req) { /* drain */ }
		closed = once(res, "close");
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(frame({ role: "assistant", content: "started" }));
	});
	const p = provider(socket.address);
	const controller = new AbortController();
	const stream = p.streamSimple(p.getModels()[0]!, context(), { signal: controller.signal, apiKey: "fixture-key" });
	for await (const event of stream) if (event.type === "text_delta") controller.abort();
	assert.equal((await stream.result()).stopReason, "aborted");
	await closed;
});

test("socket replacement requires key consent, persists across restart, and rejects tampered bindings", { timeout: 15000 }, async t => {
	fs.writeFileSync(path.join(root, "auth.json"), "{}");
	writeSettings({ version: 1 });
	const calls: string[] = [];
	const handler = (label: string): http.RequestListener => async (req, res) => {
		calls.push(`${label}:${req.headers.authorization}`);
		if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture" }] })); }
		else { for await (const _chunk of req) { /* drain */ } res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ content: "restarted" })); finish(res); }
	};
	const a = await fixture(t, handler("a")); const b = await fixture(t, handler("b"));
	const mutate = (body: object) => customProviderMutation(new Request("http://app.test/api/custom-provider", { method: "POST", headers: { origin: "http://app.test", "content-type": "application/json", "if-match": customProviderGet(new Request("http://app.test/api/custom-provider")).headers.get("etag")! }, body: JSON.stringify(body) }));
	const config = { baseUrl: a.base, socketPath: a.address, authMode: "apiKey" };
	assert.equal((await mutate({ ...config, key: "fixture-secret" })).status, 200);
	assert.equal((await mutate({ ...config, socketPath: b.address })).status, 400);
	assert.deepEqual(calls, ["a:Bearer fixture-secret"]);
	assert.equal((await mutate({ ...config, socketPath: b.address, reuseKey: true })).status, 200);
	assert.equal(readSettings()?.customProvider?.socketPath, b.address);
	assert.equal(readCustomAuth().binding?.fileKeySocketPath, b.address);
	assert.equal(readCustomAuth().binding?.version, 2);
	assert.equal(parseCustomAuthBinding(JSON.stringify({ ...readCustomAuth().binding, version: 1 })), undefined);
	const script = `import { piEngineForSpec } from ${JSON.stringify(new URL("../src/agent/models.ts", import.meta.url).href)}; await import(${JSON.stringify(new URL("../src/server/keys.ts", import.meta.url).href)}); import { normalizeContext } from '@earendil-works/pi-ai'; const e=piEngineForSpec({provider:'custom',id:'fixture'}); const r=await e.streamFn(e.model,normalizeContext({messages:[{role:'user',content:'synthetic',timestamp:0}]}),{}).result(); if(r.stopReason!=='stop')throw new Error(JSON.stringify(r)); console.log('restart passed');`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined }, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	const [code] = await once(child, "exit"); assert.equal(code, 0, output);
	assert.equal(calls.at(-1), "b:Bearer fixture-secret");
	writeSettings({ ...readSettings()!, customProvider: { ...readSettings()!.customProvider, socketPath: a.address } });
	assert.equal(customProviderAvailable(), false);
	assert.equal(customKeyAuthorized(readSettings()?.customProvider, customAuthState(true)), false);
});

test("a shadowed file key remains bound to its original socket when an environment key moves", () => {
 const cp = { baseUrl: "http://localhost/v1", socketPath: "/run/b.sock", authMode: "apiKey" as const, credentialBindingId: "a".repeat(32) };
 const binding = { version: 2 as const, id: cp.credentialBindingId, baseUrl: cp.baseUrl, socketPath: cp.socketPath, authMode: "apiKey" as const, fileKeyBaseUrl: cp.baseUrl, fileKeySocketPath: "/run/a.sock" };
 assert.equal(customKeyAuthorized(cp, { readable: true, binding, key: "fixture-env", source: "env" }), true);
 assert.equal(customKeyAuthorized(cp, { readable: true, binding, key: "fixture-file", source: "file" }), false);
});
