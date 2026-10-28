/** Exercise the TTS adapter over HTTP against an independent, strict audio contract. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-http-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.TTS_API_KEY;
const { writeSettings } = await import("../src/store/settings.ts");
const { POST } = await import("../app/api/tts/openai/route.ts");

describe("TTS through a strict OpenAI-compatible HTTP provider", () => {
	const audio = new Uint8Array([0xff, 0xf3, 1, 2, 3, 4]);
	const requests: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
	let baseUrl: string;
	let expectedKey: string | undefined;
	let slow = false;
	let closed: Promise<void>;
	let markClosed: () => void;
	const server = http.createServer(async (request, response) => {
		try {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/gateway/v1/audio/speech");
			assert.equal(request.headers["content-type"], "application/json");
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			assert.equal(Number(request.headers["content-length"]), bytes.length);
			const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
			requests.push({ url: request.url!, auth: request.headers.authorization, body });
			assert.deepEqual(Object.keys(body).sort(), ["input", "model", "response_format", "voice"]);
			assert.equal(body.model, "gpt-4o-mini-tts");
			assert.equal(body.voice, "alloy");
			assert.equal(body.response_format, "mp3");
			assert.equal(typeof body.input, "string");
			assert.ok((body.input as string).length <= 4000);
			assert.equal(request.headers.authorization, expectedKey ? `Bearer ${expectedKey}` : undefined);
			response.writeHead(200, { "content-type": "audio/mpeg", connection: "close" });
			if (slow) {
				response.once("close", () => markClosed());
				response.write(audio);
			} else response.end(audio);
		} catch (error) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: (error as Error).message } }));
		}
	});
	before(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		baseUrl = `http://127.0.0.1:${address.port}/gateway/v1`;
	});
	beforeEach(() => {
		requests.length = 0;
		expectedKey = undefined;
		slow = false;
		closed = new Promise((resolve) => { markClosed = resolve; });
		writeSettings({ version: 1, speech: { enabled: true, keySource: "custom", baseUrl } });
	});
	afterEach(() => {
		delete process.env.TTS_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.DEEPGRAM_API_KEY;
		server.closeAllConnections();
	});
	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function post(text = "Read this sentence.", signal?: AbortSignal) {
		return POST(new Request("http://app.test/api/tts/openai", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ parts: [{ text }] }), signal,
		}));
	}
	it("uses only the standard audio route and an independently configured TTS key", async () => {
		expectedKey = process.env.TTS_API_KEY = "tts-throwaway-test-key";
		process.env.OPENAI_API_KEY = "different-openai-test-key";
		process.env.DEEPGRAM_API_KEY = "different-deepgram-test-key";
		const response = await post();
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
		assert.equal(requests.length, 1);
	});
	it("supports a keyless endpoint without borrowing another provider's credentials", async () => {
		process.env.OPENAI_API_KEY = "different-openai-test-key";
		const response = await post();
		assert.equal(response.status, 200);
		await response.arrayBuffer();
		assert.equal(requests[0]!.auth, undefined);
	});
	it("splits long input into standard requests and preserves audio ordering", async () => {
		const text = "This is a complete sentence. ".repeat(300).trim();
		const response = await post(text);
		const bytes = new Uint8Array(await response.arrayBuffer());
		assert.ok(requests.length > 1);
		assert.equal(requests.map((r) => r.body.input).join(" "), text);
		assert.equal(bytes.length, audio.length * requests.length);
	});
	it("cancelling the output closes the upstream stream before another chunk is requested", { timeout: 5000 }, async () => {
		slow = true;
		const response = await post("This is a complete sentence. ".repeat(300));
		assert.equal(response.status, 200);
		const reader = response.body!.getReader();
		assert.deepEqual((await reader.read()).value, audio);
		await reader.cancel();
		await closed;
		assert.equal(requests.length, 1);
	});
	it("request cancellation propagates to the provider and errors the audio stream", { timeout: 5000 }, async () => {
		slow = true;
		const abort = new AbortController();
		const response = await post("Read this sentence.", abort.signal);
		const reader = response.body!.getReader();
		await reader.read();
		abort.abort();
		await assert.rejects(reader.read());
		await closed;
		assert.equal(requests.length, 1);
	});
});
