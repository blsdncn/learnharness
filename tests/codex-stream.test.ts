import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { zstdDecompressSync } from "node:zlib";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { codexConnected, refreshCodexConnection } from "../src/agent/codex.ts";
import { modelCatalog } from "../src/server/model-catalog.ts";
import { providerKeyPresent } from "../src/server/keys.ts";
import { callCost, sessionCost, jobCost } from "../src/server/pricing.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const originalMarker = process.env.LH_DESKTOP_SERVER, originalSecret = process.env.LH_DESKTOP_API_SECRET, originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const access = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
let connected = true, epoch = 1, leaseError = false;
let requests: { url: string; authorization: string | null; account: string | null; body: any }[] = [];
let responseEvents: unknown[] = [];
const status = () => ({ available: true, connected, pending: false, manualCode: false, error: null });
const native = piModels().getModels("openai-codex")[0]!;
const engine = () => piEngineForSpec({ provider: "openai-codex", id: native.id });
const context = () => normalizeContext({ systemPrompt: "Teach the fixture lesson", messages: [{ role: "user", content: [{ type: "text", text: "Explain" }, { type: "image", data: "c2NyYXRjaA==", mimeType: "image/png" }], timestamp: 1 }], tools: [{ name: "quiz", description: "Ask the learner", parameters: Type.Object({ question: Type.String() }) }] });
const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const complete = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output, usage } });
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64); process.env.OPENAI_API_KEY = "sk-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: "lh:codex", id: message.id, ok: !(message.op === "lease" && leaseError), value: message.op === "lease" ? { accessToken: access, epoch } : { status: status(), epoch } }));
		callback?.(); return true;
	} });
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const bytes = Buffer.from(await request.arrayBuffer());
		const body = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString();
		requests.push({ url: request.url, authorization: request.headers.get("authorization"), account: request.headers.get("chatgpt-account-id"), body: JSON.parse(body) });
		return new Response(responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of [["LH_DESKTOP_SERVER", originalMarker], ["LH_DESKTOP_API_SECRET", originalSecret], ["OPENAI_API_KEY", originalKey]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});

test("native Codex catalog is available only with authenticated desktop subscription", async () => {
	await refreshCodexConnection(); assert(codexConnected());
	assert(providerKeyPresent("openai-codex"));
	assert(modelCatalog().models.some((model) => model.provider === "openai-codex"));
	connected = false; epoch++;
	ipc({ channel: "lh:codex", kind: "state", status: status(), epoch });
	assert.equal(providerKeyPresent("openai-codex"), false);
	assert.equal(modelCatalog().models.some((model) => model.provider === "openai-codex"), false);
	connected = true; epoch++; await refreshCodexConnection();
});

test("native subscription transport preserves image/tools/reasoning and tool-result replay", async () => {
	requests = [];
	const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-signature" };
	const tool = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "quiz", arguments: '{"question":"Why?"}', status: "completed" };
	responseEvents = [{ type: "response.created", response: { id: "resp_fixture" } }, { type: "response.output_item.added", output_index: 0, item: reasoning }, { type: "response.output_item.done", output_index: 0, item: reasoning }, { type: "response.output_item.added", output_index: 1, item: tool }, { type: "response.output_item.done", output_index: 1, item: tool }, complete([reasoning, tool])];
	const e = engine();
	const result = await e.streamFn(e.model, context(), { transport: "sse" }).result();
	assert.equal(result.stopReason, "toolUse"); assert.equal(result.provider, "openai-codex");
	assert.equal(requests.length, 1); assert.equal(requests[0]!.url, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(requests[0]!.authorization, `Bearer ${access}`); assert.equal(requests[0]!.account, "fixture-account");
	const body = requests[0]!.body;
	assert.equal(body.store, false); assert.equal(body.stream, true);
	assert(body.input.some((message: any) => message.content?.some((part: any) => part.type === "input_image")));
	const tools = body.tools ?? body.input.flatMap((item: any) => item.type === "additional_tools" ? item.tools : []);
	assert(tools.some((tool: any) => tool.name === "quiz"));
	const call = result.content.find((part) => part.type === "toolCall")!;
	assert.equal(call.id, "call_fixture|fc_fixture");
	assert.equal(result.content.find((part) => part.type === "thinking")!.thinkingSignature, JSON.stringify(reasoning));
	responseEvents = [complete()];
	await e.streamFn(e.model, normalizeContext({ messages: [...context().messages, result, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "Learner answer" }], isError: false, timestamp: 2 }] }), { transport: "sse" }).result();
	assert(requests[1]!.body.input.some((item: any) => item.encrypted_content === "fixture-signature"));
	assert(requests[1]!.body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_fixture"));
});

test("disconnected and failed credential leases never dispatch through ambient OpenAI API keys", async () => {
	requests = [];
	const e = engine();
	connected = false; epoch++;
	assert.equal((await e.streamFn(e.model, context(), { transport: "sse" }).result()).stopReason, "error");
	connected = true; epoch++; leaseError = true;
	const result = await e.streamFn(e.model, context(), { transport: "sse" }).result();
	assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /No API-key fallback/);
	assert.equal(requests.length, 0); leaseError = false;
});

test("subscription usage is never reported as API dollars", () => {
	const model = `openai-codex:${native.id}`;
	const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
	assert.equal(callCost(step, model), null);
	assert.equal(jobCost({ usage: { model, ...step, steps: 1 } }), null);
	const cost = sessionCost({ turns: [{ id: "fixture", messageId: "fixture", at: "2026-10-19", model, steps: [step] }] });
	assert.equal(cost.cost, 0); assert.equal(cost.unpriced, 0); assert.equal(cost.subscription, 1);
});

test("framework IPC or browser-only execution cannot enable subscription access", async () => {
	delete process.env.LH_DESKTOP_SERVER;
	ipc({ channel: "lh:codex", kind: "state", epoch: ++epoch, status: status() });
	await refreshCodexConnection(); assert.equal(codexConnected(), false);
	requests = [];
	const e = engine();
	assert.equal((await e.streamFn(e.model, context(), { transport: "sse" }).result()).stopReason, "error");
	assert.equal(requests.length, 0);
	process.env.LH_DESKTOP_SERVER = "1";
});
