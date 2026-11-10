import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test, after, type TestContext } from "node:test";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { responseFrames, responseFrame } from "../scripts/responses-fixture.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-responses-"));
const originalEnv = process.env;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), NODE_ENV: "test", HOME: root, LH_DATA_DIR: root, LH_AUTH_FILE: path.join(root, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const { buildOpenAiCompatibleProvider, discoverModels, customProviderAvailable } = await import("../src/server/custom-provider.ts");
const { customProviderGet, customProviderMutation } = await import("../src/server/custom-provider-http.ts");
const { sanitizeUserSettings, customProviderUsable } = await import("../src/core/settings.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { readCustomAuth } = await import("../src/store/auth.ts");
const { parseCustomAuthBinding } = await import("../src/core/custom-provider-auth.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
await import("../src/server/keys.ts");
after(() => { process.env = originalEnv; fs.rmSync(root, { recursive: true, force: true }); });
let sequence = 0;
async function endpoint(t: TestContext, unix: boolean, handler: http.RequestListener) {
	const socketPath = path.join(root, `${++sequence}.sock`);
	const server = http.createServer(handler);
	server.listen(unix ? socketPath : { host: "127.0.0.1", port: 0 }); await once(server, "listening");
	t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
	return { baseUrl: unix ? "http://fixture.invalid/v1" : `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`, ...(unix ? { socketPath } : {}) };
}
const context = (messages: Message[] = [{ role: "user", content: "héllo 🌙", timestamp: 0 }]) => normalizeContext({ messages });
function status() { return customProviderGet(new Request("http://app.test/api/custom-provider")); }
function mutate(body: object, method = "POST") {
	return customProviderMutation(new Request("http://app.test/api/custom-provider", { method, headers: { origin: "http://app.test", "content-type": "application/json", "if-match": status().headers.get("etag")! }, body: JSON.stringify(body) }));
}

test("legacy API defaults to Chat Completions; unsupported saved/API choices never fall back", async () => {
	assert.equal(buildOpenAiCompatibleProvider({ baseUrl: "http://fixture/v1", models: [{ id: "m" }] }).getModels()[0]?.api, "openai-completions");
	const invalid = sanitizeUserSettings({ customProvider: { baseUrl: "http://fixture/v1", api: "unsupported" } });
	assert.equal(customProviderUsable(invalid?.customProvider), false);
	for (const api of ["unsupported", "", null, false, {}, []]) {
		assert.equal((await mutate({ baseUrl: "http://fixture/v1", authMode: "keyless", api })).status, 400);
	}
});

for (const unix of [false, true]) {
	const name = unix ? "Unix socket" : "TCP";
	test(`${name}: Responses streams text/tools/usage and encodes tool results`, { timeout: 15000 }, async t => {
		const bodies: Record<string, any>[] = []; let release!: () => void;
		const target = await endpoint(t, unix, async (req, res) => {
			if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] })); return; }
			assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, "Bearer fixture-key");
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
			const bytes = Buffer.concat(chunks); const body = JSON.parse(bytes.toString()); bodies.push(body);
			assert.equal(body.model, "gpt-5.6-luna"); assert.equal(body.stream, true); assert.equal(body.store, false);
			assert.ok(Array.isArray(body.input)); assert.equal(body.messages, undefined);
			if (unix) { assert.equal(req.headers["transfer-encoding"], undefined); assert.equal(Number(req.headers["content-length"]), bytes.length); }
			res.writeHead(200, { "content-type": "text/event-stream" });
			const frames = responseFrames("hello", bodies.length === 2);
			if (bodies.length === 1) {
				const gate = new Promise<void>(resolve => { release = resolve; });
				res.write(frames.slice(0, -2).join("")); await gate; res.end(frames.slice(-2).join(""));
			} else res.end(frames.join(""));
		});
		assert.equal((await discoverModels(target.baseUrl, undefined, target.socketPath)).ok, true);
		const provider = buildOpenAiCompatibleProvider({ ...target, api: "openai-responses", apiKey: "fixture-key", models: [{ id: "gpt-5.6-luna" }] });
		const model = provider.getModels()[0]!; assert.equal(model.api, "openai-responses");
		const stream = provider.streamSimple(model, context(), { apiKey: "fixture-key" });
		let deltas = 0; for await (const event of stream) if (event.type === "text_delta") { deltas++; release(); }
		assert.ok(deltas); const result = await stream.result(); assert.equal(result.stopReason, "stop"); assert.equal(result.usage.input, 3); assert.equal(result.usage.output, 2);
		const toolMessage = await provider.stream(model, context(), { apiKey: "fixture-key" }).result(); assert.equal(toolMessage.stopReason, "toolUse");
		const tool = toolMessage.content.find(block => block.type === "toolCall"); assert.ok(tool); assert.equal(tool.name, "echo"); assert.deepEqual(tool.arguments, { value: "ok" });
		await provider.streamSimple(model, context([{ role: "user", content: "test", timestamp: 0 }, toolMessage, { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 }]), { apiKey: "fixture-key" }).result();
		assert.ok(bodies[2]!.input.some((item: { type: string }) => item.type === "function_call_output"));
	});
	test(`${name}: Responses cancellation closes SSE; failures never retry Chat Completions`, { timeout: 15000 }, async t => {
		let closed!: Promise<unknown>; const routes: string[] = []; let fail = false;
		const target = await endpoint(t, unix, async (req, res) => {
			routes.push(req.url!); for await (const _chunk of req) { /* drain */ }
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (fail) res.end(responseFrame("response.failed", { response: { id: "failed", status: "failed", error: { code: "fixture", message: "synthetic failure" } } }));
			else { closed = once(res, "close"); res.write(responseFrames("started").slice(0, -2).join("")); }
		});
		const provider = buildOpenAiCompatibleProvider({ ...target, api: "openai-responses", models: [{ id: "m" }] });
		const controller = new AbortController(); const stream = provider.streamSimple(provider.getModels()[0]!, context(), { apiKey: "fixture", signal: controller.signal });
		for await (const event of stream) if (event.type === "text_delta") controller.abort();
		assert.equal((await stream.result()).stopReason, "aborted"); await closed;
		fail = true; const failure = await provider.streamSimple(provider.getModels()[0]!, context(), { apiKey: "fixture" }).result();
		assert.equal(failure.stopReason, "error"); assert.match(failure.errorMessage ?? "", /synthetic failure/);
		assert.deepEqual(routes, ["/v1/responses", "/v1/responses"]);
	});
}

test("saved API switches reconfigure existing engines, preserve pins/keys, and survive restart", { timeout: 15000 }, async t => {
	fs.writeFileSync(path.join(root, "auth.json"), "{}\n"); writeSettings({ version: 1 });
	const routes: string[] = [];
	const target = await endpoint(t, true, async (req, res) => {
		routes.push(req.url!);
		if (req.method === "GET") { res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
		for await (const _chunk of req) { /* drain */ }
		assert.equal(req.headers.authorization, "Bearer fixture-key");
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(req.url === "/v1/responses" ? responseFrames().join("") : 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	const config = { ...target, authMode: "apiKey" };
	assert.equal((await mutate({ ...config, key: "fixture-key" })).status, 200);
	assert.equal((await status().json()).api, "openai-completions");
	const engine = piEngineForSpec({ provider: "custom", id: "m" }); const run = () => engine.streamFn(engine.model, context(), {}).result();
	assert.equal((await run()).stopReason, "stop"); assert.equal(routes.at(-1), "/v1/chat/completions");
	assert.equal((await mutate({ overrides: { m: { context: 65536 } } }, "PATCH")).status, 200);
	assert.equal((await mutate({ ...config, api: "openai-responses" })).status, 200);
	assert.equal(readSettings()?.customProvider?.overrides?.m?.context, 65536);
	assert.equal(readCustomAuth().binding?.version, 3);
	assert.equal(parseCustomAuthBinding(JSON.stringify({ ...readCustomAuth().binding, version: 2 })), undefined);
	assert.equal((await run()).stopReason, "stop"); assert.equal(routes.at(-1), "/v1/responses");
	const script = `import {piEngineForSpec} from ${JSON.stringify(new URL("../src/agent/models.ts", import.meta.url).href)};await import(${JSON.stringify(new URL("../src/server/keys.ts", import.meta.url).href)});import {normalizeContext} from '@earendil-works/pi-ai';const e=piEngineForSpec({provider:'custom',id:'m'});if(e.model.api!=='openai-responses')throw Error('API lost');const r=await e.streamFn(e.model,normalizeContext({messages:[{role:'user',content:'test',timestamp:0}]}),{}).result();if(r.stopReason!=='stop')throw Error(JSON.stringify(r));`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	assert.equal((await once(child, "exit"))[0], 0, output);
	writeSettings({ ...readSettings()!, customProvider: { ...readSettings()!.customProvider, api: "openai-completions" } });
	assert.equal(customProviderAvailable(), false, "settings cannot silently reinterpret Responses authorization");
	// Explicitly saving Chat Completions at the same address reauthorizes it.
	assert.equal((await mutate({ ...config, api: "openai-completions", reuseKey: true })).status, 200);
	assert.equal((await run()).stopReason, "stop"); assert.equal(routes.at(-1), "/v1/chat/completions");
});
