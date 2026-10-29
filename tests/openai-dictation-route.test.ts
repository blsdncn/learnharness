import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { pcm16Wav } from "../src/core/dictation.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-openai-stt-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.OPENAI_API_KEY;
delete process.env.CUSTOM_STT_API_KEY;
delete process.env.CUSTOM_TTS_API_KEY;
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey } = await import("../src/server/keys.ts");
const { POST } = await import("../app/api/stt/openai/route.ts");
const { STT_ENDPOINT, TTS_ENDPOINT } = await import("../src/core/custom-provider-auth.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	delete process.env.OPENAI_API_KEY;
	delete process.env.CUSTOM_STT_API_KEY;
	delete process.env.CUSTOM_TTS_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});
const request = () => new Request("http://localhost/api/stt/openai", {
	method: "POST", headers: { "content-type": "audio/wav" }, body: pcm16Wav([new Uint8Array([0, 1])]),
});

it("only dispatches through the saved OpenAI provider and Platform key", async () => {
	let calls = 0;
	globalThis.fetch = async (_input, init) => {
		calls++;
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-fake-test-key-123456");
		return Response.json({ text: "Recorded text" });
	};
	assert.equal((await POST(request())).status, 403, "Deepgram remains the default");
	writeSettings({ version: 1, general: { dictationProvider: "openai" } });
	assert.equal((await POST(request())).status, 503, "subscription login is not an API key");
	assert.equal(saveKey("OPENAI_API_KEY", "sk-fake-test-key-123456").ok, true);
	const result = await POST(request());
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), { text: "Recorded text" });
	assert.equal(calls, 1);
});

/** The dictation custom endpoint, bound like a real Connect. */
const connectStt = (key?: string) => authorizeFixture({ baseUrl: "http://compatible.test/v1", authMode: key ? "apiKey" : "keyless", models: [{ id: "another-model" }] }, key, STT_ENDPOINT);

it("a custom endpoint uses only its own bound key — never the OpenAI or TTS keys", async () => {
	authorizeFixture({ baseUrl: "http://compatible.test/v1", authMode: "apiKey" }, "test-separate-tts-credential", TTS_ENDPOINT);
	writeSettings({ version: 1, general: { dictationProvider: "custom" }, dictation: { language: "de", customModel: "another-model" }, customSttProvider: connectStt("test-separate-stt-credential") });
	let auth: string | undefined;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "http://compatible.test/v1/audio/transcriptions");
		auth = (init?.headers as Record<string, string>).Authorization;
		assert.equal((init?.body as FormData).get("model"), "another-model");
		assert.equal((init?.body as FormData).get("language"), "de");
		return Response.json({ text: "Independent" });
	};
	assert.equal((await POST(request())).status, 200);
	assert.equal(auth, "Bearer test-separate-stt-credential");
	writeSettings({ version: 1, general: { dictationProvider: "custom" }, dictation: { language: "de", customModel: "another-model" }, customSttProvider: connectStt() });
	assert.equal((await POST(request())).status, 200);
	assert.equal(auth, undefined, "a keyless endpoint sends no key, never the OpenAI key");
});

it("an endpoint whose key isn't bound to its URL is refused", async () => {
	const cp = connectStt("test-separate-stt-credential");
	writeSettings({ version: 1, general: { dictationProvider: "custom" }, dictation: { customModel: "another-model" }, customSttProvider: { ...cp, baseUrl: "http://elsewhere.test/v1" } });
	globalThis.fetch = async () => { assert.fail("must not dispatch"); };
	const res = await POST(request());
	assert.equal(res.status, 503);
	assert.match(((await res.json()) as { message: string }).message, /isn't authorized/);
});

it("Custom without a connected endpoint is refused, never sent to OpenAI", async () => {
	writeSettings({ version: 1, general: { dictationProvider: "custom" }, dictation: { customModel: "another-model" } });
	globalThis.fetch = async () => { assert.fail("must not dispatch"); };
	const res = await POST(request());
	assert.equal(res.status, 503);
	assert.match(((await res.json()) as { message: string }).message, /No custom dictation endpoint/);
});

it("choosing OpenAI again goes back to OpenAI with the OpenAI key", async () => {
	writeSettings({ version: 1, general: { dictationProvider: "openai" }, dictation: { customModel: "another-model" }, customSttProvider: connectStt("test-separate-stt-credential") });
	let url: string | undefined;
	globalThis.fetch = async (input, init) => {
		url = String(input);
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-fake-test-key-123456");
		assert.equal((init?.body as FormData).get("model"), "gpt-transcribe");
		return Response.json({ text: "OpenAI" });
	};
	assert.equal((await POST(request())).status, 200);
	assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
});

it("refuses a changed connection instead of sending captured audio to a different server", async () => {
	globalThis.fetch = async () => { assert.fail("must not dispatch stale recording"); };
	const recording = request();
	recording.headers.set("x-lh-dictation-connection", JSON.stringify({ custom: true, baseUrl: "http://previous.test/v1", model: "another-model" }));
	assert.equal((await POST(recording)).status, 409);
});

it("finishes a pinned OpenAI-compatible recording after the default switches to Deepgram", async () => {
	writeSettings({ version: 1, general: { dictationProvider: "deepgram" }, dictation: { customModel: "another-model" }, customSttProvider: connectStt() });
	let url: string | undefined;
	globalThis.fetch = async (input) => { url = String(input); return Response.json({ text: "Pinned recording" }); };
	const recording = request();
	recording.headers.set("x-lh-dictation-connection", JSON.stringify({ custom: true, baseUrl: "http://compatible.test/v1", model: "another-model" }));
	assert.equal((await POST(recording)).status, 200);
	assert.equal(url, "http://compatible.test/v1/audio/transcriptions");
});
