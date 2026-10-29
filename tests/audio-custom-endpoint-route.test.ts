/**
 * TTS reuses the chat custom endpoint's connect flow: each stores its own top-level
 * settings entry, key and URL binding, and never touches chat's (or the
 * other feature's), nor registers TTS as a chat provider.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-audio-endpoint-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.CUSTOM_TTS_API_KEY;
delete process.env.CUSTOM_OPENAI_API_KEY;
const SETTINGS_FILE = path.join(dir, "settings.json");
const AUTH_FILE = process.env.LH_AUTH_FILE;

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

type Route = typeof import("../app/api/tts/custom-endpoint/route.ts");
let tts: Route;
let chat: Route;
let speech: typeof import("../app/api/tts/openai/route.ts");
let customProviderAvailable: () => boolean;
let saveKey: typeof import("../src/server/keys.ts").saveKey;
let keyStatuses: typeof import("../src/server/keys.ts").keyStatuses;
before(async () => {
	tts = await import("../app/api/tts/custom-endpoint/route.ts");
	chat = await import("../app/api/custom-provider/route.ts");
	speech = await import("../app/api/tts/openai/route.ts");
	({ customProviderAvailable } = await import("../src/server/custom-provider.ts"));
	({ saveKey, keyStatuses } = await import("../src/server/keys.ts"));
});

const BASE = "http://speech.test/v1";
const settings = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, Record<string, unknown> | undefined>;
const auth = () => (fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")) : {}) as Record<string, string>;

/** The probe answers with a model list; every request is recorded. */
let probes: { url: string; auth: string | null }[];
function serve(models: string[] = ["kokoro", "whisper-1"]) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		probes.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
		return Response.json({ data: models.map((id) => ({ id })) });
	}) as typeof fetch;
}

function request(route: Route, url: string, method: "POST" | "DELETE", body: Record<string, unknown>, etag?: string) {
	const handler = method === "POST" ? route.POST : route.DELETE;
	return handler(new Request(`http://localhost${url}`, {
		method,
		headers: { "content-type": "application/json", origin: "http://localhost", "if-match": etag ?? route.GET(new Request(`http://localhost${url}`)).headers.get("etag")! },
		body: JSON.stringify(body),
	}));
}
const connectTts = (body: Record<string, unknown>, etag?: string) => request(tts, "/api/tts/custom-endpoint", "POST", { authMode: "keyless", ...body }, etag);
const connectChat = (body: Record<string, unknown>) => request(chat, "/api/custom-provider", "POST", { authMode: "keyless", ...body });

beforeEach(() => {
	probes = [];
	fs.rmSync(SETTINGS_FILE, { force: true });
	fs.rmSync(AUTH_FILE, { force: true });
	serve();
});
afterEach(() => { delete process.env.CUSTOM_TTS_API_KEY; });

describe("audio custom endpoints", () => {
	it("connect stores the feature's own top-level entry, key and binding — never chat's", async () => {
		const res = await connectTts({ baseUrl: `${BASE}/`, authMode: "apiKey", key: "tts-only-throwaway-key" });
		assert.equal(res.status, 200);
		assert.deepEqual(probes, [{ url: `${BASE}/models`, auth: "Bearer tts-only-throwaway-key" }], "the probe uses the URL as typed, /v1 never added");
		const record = settings();
		assert.equal(record.customTtsProvider?.baseUrl, BASE);
		assert.equal(record.customTtsProvider?.authMode, "apiKey");
		assert.deepEqual(record.customTtsProvider?.models, [{ id: "kokoro" }, { id: "whisper-1" }]);
		assert.equal(record.customTtsProvider?.overrides, undefined, "no chat budget pins");
		assert.equal(record.customProvider, undefined);
		assert.equal(record.customProvider, undefined);
		const stored = auth();
		assert.equal(stored.CUSTOM_TTS_API_KEY, "tts-only-throwaway-key");
		assert.equal(JSON.parse(stored.__learnharness_custom_tts_binding!).id, record.customTtsProvider?.credentialBindingId);
		assert.equal(stored.CUSTOM_OPENAI_API_KEY, undefined);
		assert.equal(stored.__learnharness_custom_provider_binding, undefined);
		assert.equal(customProviderAvailable(), false, "an audio endpoint is never a chat provider");
		const status = await tts.GET(new Request("http://localhost/api/tts/custom-endpoint")).json() as Record<string, unknown>;
		assert.equal(status.baseUrl, BASE);
		assert.equal(status.keyPresent, true);
		assert.doesNotMatch(JSON.stringify(status), /throwaway/, "GET never returns the key");
	});

	it("the bound key reaches /audio/speech; TTS and chat endpoints stay independent", async () => {
		assert.equal((await connectTts({ baseUrl: BASE, authMode: "apiKey", key: "tts-only-throwaway-key" })).status, 200);
		assert.equal((await connectChat({ baseUrl: "http://chat.test/v1" })).status, 200);
		const record = settings();
		assert.equal(record.customProvider?.baseUrl, "http://chat.test/v1");
		assert.equal(record.customProvider?.authMode, "keyless");
		assert.equal(record.customTtsProvider?.baseUrl, BASE, "connecting chat leaves TTS alone");
		assert.equal(auth().CUSTOM_OPENAI_API_KEY, undefined);
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...record, speech: { enabled: true, provider: "custom", customModel: "kokoro" } }));
		probes = [];
		const res = await speech.POST(new Request("http://localhost/api/tts/openai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ text: "Hello" }] }) }));
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		assert.deepEqual(probes, [{ url: `${BASE}/audio/speech`, auth: "Bearer tts-only-throwaway-key" }]);
	});

	it("a saved key never follows the endpoint to a new URL without a new key or consent", async () => {
		await connectTts({ baseUrl: BASE, authMode: "apiKey", key: "tts-only-throwaway-key" });
		const moved = await connectTts({ baseUrl: "http://elsewhere.test/v1", authMode: "apiKey" });
		assert.equal(moved.status, 400);
		assert.match(((await moved.json()) as { error: string }).error, /explicitly allow reuse/);
		assert.equal(settings().customTtsProvider?.baseUrl, BASE);
		probes = [];
		const consented = await connectTts({ baseUrl: "http://elsewhere.test/v1", authMode: "apiKey", reuseKey: true });
		assert.equal(consented.status, 200);
		assert.deepEqual(probes, [{ url: "http://elsewhere.test/v1/models", auth: "Bearer tts-only-throwaway-key" }]);
	});

	it("a stale revision is refused with 409", async () => {
		const etag = tts.GET(new Request("http://localhost/api/tts/custom-endpoint")).headers.get("etag")!;
		await connectTts({ baseUrl: BASE });
		const stale = await connectTts({ baseUrl: "http://other.test/v1" }, etag);
		assert.equal(stale.status, 409);
		assert.equal(settings().customTtsProvider?.baseUrl, BASE);
	});

	it("a rejected key fails, even with typed model ids; a missing /models list falls back to them", async () => {
		globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
		assert.equal((await connectTts({ baseUrl: BASE, authMode: "apiKey", key: "bad-throwaway-key", manualModels: "kokoro" })).status, 502);
		globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
		assert.equal((await connectTts({ baseUrl: BASE, manualModels: "kokoro, af_heart" })).status, 200);
		assert.deepEqual(settings().customTtsProvider?.models, [{ id: "af_heart" }, { id: "kokoro" }]);
	});

	it("an environment key is used for the endpoint when allowed, and stays out of the generic key API", async () => {
		const realEnv = (await import("../src/core/auth-env.ts")).authEnvRecord().realEnv;
		process.env.CUSTOM_TTS_API_KEY = "env-tts-throwaway-key";
		realEnv.add("CUSTOM_TTS_API_KEY");
		try {
			const status = await tts.GET(new Request("http://localhost/api/tts/custom-endpoint?authMode=apiKey")).json() as { keySource: string };
			assert.equal(status.keySource, "env");
			assert.equal((await connectTts({ baseUrl: BASE, authMode: "apiKey", reuseKey: true })).status, 200);
			assert.equal(probes.at(-1)!.auth, "Bearer env-tts-throwaway-key");
			assert.equal(auth().CUSTOM_TTS_API_KEY, undefined, "the environment's key is never copied to the file");
		} finally { realEnv.delete("CUSTOM_TTS_API_KEY"); }
		assert.deepEqual(saveKey("CUSTOM_TTS_API_KEY", "x".repeat(20)), { ok: false, error: "Use the custom endpoint editor" });
		assert.deepEqual(saveKey("__learnharness_custom_provider_binding", "x".repeat(20)), { ok: false, error: "Use the custom endpoint editor" });
		assert.ok(keyStatuses().every((s) => !s.id.startsWith("__learnharness")), "bindings are never listed");
	});

	it("disconnect forgets the endpoint and its key, leaving a disabled binding", async () => {
		await connectTts({ baseUrl: BASE, authMode: "apiKey", key: "tts-only-throwaway-key" });
		const res = await request(tts, "/api/tts/custom-endpoint", "DELETE", {});
		assert.equal(res.status, 200);
		assert.equal(settings().customTtsProvider, undefined);
		const stored = auth();
		assert.equal(stored.CUSTOM_TTS_API_KEY, undefined);
		assert.equal(JSON.parse(stored.__learnharness_custom_tts_binding!).authMode, "disabled");
	});

	it("has no per-model pins (PATCH)", () => {
		assert.equal("PATCH" in tts, false);
		assert.equal("PATCH" in chat, true, "chat keeps its per-model pins");
	});
});
