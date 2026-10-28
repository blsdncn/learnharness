/**
 * The Model picker's lists: GET /api/tts/openai/models and
 * /api/stt/openai/models call the SAVED server's /models with the SAVED
 * key source, returning every id A–Z and never a key or provider body.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-audio-models-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
for (const id of ["OPENAI_API_KEY", "GROQ_API_KEY", "TTS_API_KEY", "STT_API_KEY"]) delete process.env[id];
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey, deleteKey } = await import("../src/server/keys.ts");
const { listAudioModels } = await import("../src/server/audio-models.ts");
const tts = await import("../app/api/tts/openai/models/route.ts");
const stt = await import("../app/api/stt/openai/models/route.ts");
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

type Call = { url: string; auth?: string };
let calls: Call[];
const serve = (respond: () => Response) => {
	globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
		return respond();
	};
};
const list = (...ids: unknown[]) => Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "x" })) });

beforeEach(() => {
	calls = [];
	for (const id of ["OPENAI_API_KEY", "GROQ_API_KEY", "TTS_API_KEY", "STT_API_KEY"]) deleteKey(id);
	writeSettings({ version: 1 });
});

describe("listAudioModels", () => {
	const deps = { baseUrl: "http://compatible.test/v1/", keySource: "custom", apiKey: undefined, settingsName: "TTS" };

	it("returns every id A–Z, deduped, with nothing filtered by name", async () => {
		serve(() => list("whisper-1", "gpt-5", "tts-1", "text-embedding-3-small", "tts-1", "  ", 7, "x".repeat(201)));
		const res = await listAudioModels(deps);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { models: ["gpt-5", "text-embedding-3-small", "tts-1", "whisper-1"] });
		assert.deepEqual(calls, [{ url: "http://compatible.test/v1/models", auth: undefined }], "an empty custom key sends no Authorization");
	});

	it("explains upstream failures without the provider's body", async () => {
		const secret = "sk-echoed-secret-value";
		for (const [status, expected] of [
			[401, "Server answered 401 — check the API key in Settings → TTS"],
			[404, "Server answered 404 — this server doesn't list models; type a model id"],
			[500, "Server answered 500"],
		] as const) {
			serve(() => new Response(`bad key ${secret}`, { status }));
			const res = await listAudioModels({ ...deps, apiKey: secret });
			assert.equal(res.status, 502);
			const body = await res.json();
			assert.deepEqual(body, { message: expected });
		}
		serve(() => Response.json({ models: ["not-openai-shape"] }));
		assert.deepEqual(await (await listAudioModels(deps)).json(), { message: "Server returned an invalid model list" });
		globalThis.fetch = async () => { throw new TypeError("connect ECONNREFUSED"); };
		assert.deepEqual(await (await listAudioModels(deps)).json(), { message: "Server unreachable at http://compatible.test/v1" });
	});

	it("refuses a missing provider key and an invalid URL before any request", async () => {
		serve(() => list("never"));
		const missing = await listAudioModels({ ...deps, keySource: "OPENAI_API_KEY", settingsName: "Dictation" });
		assert.equal(missing.status, 503);
		assert.deepEqual(await missing.json(), { message: "No OPENAI_API_KEY configured — pick a saved key in Settings → Dictation." });
		assert.equal((await listAudioModels({ ...deps, baseUrl: "ftp://nope" })).status, 400);
		assert.deepEqual(calls, []);
	});
});

describe("the model-list routes", () => {
	it("TTS lists from the saved server with the saved key source", async () => {
		serve(() => list("tts-1", "gpt-4o-mini-tts"));
		assert.equal(saveKey("OPENAI_API_KEY", "sk-fake-openai-key-123456").ok, true);
		const res = await tts.GET();
		assert.deepEqual(await res.json(), { models: ["gpt-4o-mini-tts", "tts-1"] });
		assert.deepEqual(calls, [{ url: "https://api.openai.com/v1/models", auth: "Bearer sk-fake-openai-key-123456" }], "defaults: OpenAI + OPENAI_API_KEY");

		calls = [];
		assert.equal(saveKey("TTS_API_KEY", "test-custom-tts-key").ok, true);
		writeSettings({ version: 1, speech: { baseUrl: "http://127.0.0.1:47616/v1", keySource: "custom" } });
		await tts.GET();
		assert.deepEqual(calls, [{ url: "http://127.0.0.1:47616/v1/models", auth: "Bearer test-custom-tts-key" }]);
	});

	it("dictation uses its own connection and key, never the TTS ones", async () => {
		serve(() => list("gpt-transcribe"));
		assert.equal(saveKey("TTS_API_KEY", "test-custom-tts-key").ok, true);
		assert.equal(saveKey("GROQ_API_KEY", "gsk-fake-groq-key-123456").ok, true);
		writeSettings({ version: 1, speech: { baseUrl: "http://tts.test/v1", keySource: "custom" }, dictation: { baseUrl: "http://stt.test/v1", keySource: "GROQ_API_KEY" } });
		assert.deepEqual(await (await stt.GET()).json(), { models: ["gpt-transcribe"] });
		assert.deepEqual(calls, [{ url: "http://stt.test/v1/models", auth: "Bearer gsk-fake-groq-key-123456" }]);

		calls = [];
		deleteKey("GROQ_API_KEY");
		assert.equal((await stt.GET()).status, 503, "a missing selected key never falls back");
		assert.deepEqual(calls, []);
	});
});
