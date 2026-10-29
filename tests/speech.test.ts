/**
 * Speech (listen wave, 2026-10-26): the /api/tts/openai contract, the speech
 * settings section, math speech, and the OpenAI-compatible provider call.
 *
 * The routes run framework-free under an isolated LH_DATA_DIR + LH_AUTH_FILE
 * (set BEFORE any config-loading import — every app import is dynamic), and
 * a recording fetch stands in for the speech server. Throwaway key values
 * only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

delete process.env.TTS_API_KEY;
delete process.env.OPENAI_API_KEY;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { parseSpeechRequest, splitSpokenText, sanitizeUserSettings, resolveSettings, SPEECH_REQUEST_MAX_CHARS } = await import(
	"../src/core/index.ts"
);
const { parseSpeechSettingsBody } = await import("../src/server/settings-body.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { texToWords, spokenText } = await import("../src/server/speech.ts");
const tts = await import("../app/api/tts/openai/route.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.TTS_API_KEY;
	delete process.env.OPENAI_API_KEY;
});

/** A fake speech server: records requests, answers with the next handler. */
function fakeServer(handler: (url: string, init: RequestInit) => Response) {
	const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
		return handler(url, init);
	}) as typeof fetch;
	return calls;
}

const post = (body: unknown) =>
	tts.POST(new Request("http://lh.test/api/tts/openai", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("the /api/tts/openai request contract (core)", () => {
	it("accepts text and tex parts in order", () => {
		const r = parseSpeechRequest({ parts: [{ text: "The area is" }, { tex: "x^2" }] });
		assert.ok(r.ok);
		if (r.ok) assert.deepEqual(r.parts, [{ text: "The area is" }, { tex: "x^2" }]);
	});
	it("rejects empty, malformed, blank, and oversized blocks", () => {
		assert.ok(!parseSpeechRequest(null).ok);
		assert.ok(!parseSpeechRequest({ parts: [] }).ok);
		assert.ok(!parseSpeechRequest({ parts: [{ html: "<p>x</p>" }] }).ok);
		assert.ok(!parseSpeechRequest({ parts: [{ text: "   " }] }).ok, "nothing to speak");
		assert.ok(!parseSpeechRequest({ parts: [{ text: "a".repeat(20_001) }] }).ok);
	});
	it("splits long text at sentence ends, under the limit, losing no words", () => {
		const sentence = "Routers forward packets using the longest matching prefix. ";
		const text = sentence.repeat(200);
		const chunks = splitSpokenText(text, 500);
		assert.ok(chunks.length > 1);
		for (const c of chunks) {
			assert.ok(c.length <= 500, `chunk of ${c.length}`);
			assert.ok(c.endsWith("."), "cut at a sentence end");
		}
		assert.equal(chunks.join(" "), text.trim());
		assert.deepEqual(splitSpokenText("short"), ["short"]);
		assert.equal(SPEECH_REQUEST_MAX_CHARS, 4000);
	});
});

describe("the speech settings section", () => {
	it("sanitizes stored values: http(s) only, no trailing slash, trimmed ids", () => {
		const r = sanitizeUserSettings({ version: 1, speech: { customEndpoint: true, baseUrl: "http://127.0.0.1:47616/v1/", model: " tts-1 ", voice: "", keySource: "custom" } });
		assert.deepEqual(r?.speech, { customEndpoint: true, baseUrl: "http://127.0.0.1:47616/v1", model: "tts-1" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { baseUrl: "file:///etc" } })?.speech, {});
	});
	it("resolves to OpenAI with its key unless the custom endpoint is on", () => {
		const openai = { enabled: undefined, voice: "alloy", readQuestion: false, autoplay: false, custom: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", keyId: "OPENAI_API_KEY" };
		assert.deepEqual(resolveSettings(null).speech, openai);
		assert.deepEqual(resolveSettings({ version: 1, speech: { baseUrl: "http://local.test/v1", model: "x" } }).speech, openai, "saved endpoint unused while off");
		assert.deepEqual(resolveSettings({ version: 1, speech: { customEndpoint: true, baseUrl: "http://local.test/v1" } }).speech,
			{ enabled: undefined, voice: "alloy", readQuestion: false, autoplay: false, custom: true, baseUrl: "http://local.test/v1", model: "gpt-4o-mini-tts", keyId: "TTS_API_KEY" });
		assert.equal(resolveSettings({ version: 1, speech: { voice: "geffenv1" } }).speech.voice, "geffenv1");
	});
	it("PUT parser: rejects bad URLs and ids with a rationale; empty strings clear", () => {
		const bad = parseSpeechSettingsBody({ baseUrl: "not a url" });
		assert.ok(!bad.ok);
		if (!bad.ok) assert.match(bad.error, /http\(s\) URL/);
		assert.ok(!parseSpeechSettingsBody({ voice: 42 }).ok);
		assert.ok(!parseSpeechSettingsBody({ customEndpoint: "on" }).ok);
		const ok = parseSpeechSettingsBody({ customEndpoint: false, baseUrl: "https://api.openai.com/v1/", model: "", voice: "alloy", keySource: "GROQ_API_KEY" });
		assert.ok(ok.ok);
		if (ok.ok) assert.deepEqual(ok.settings, { customEndpoint: false, baseUrl: "https://api.openai.com/v1", voice: "alloy" });
	});
	it("Read the question: off unless saved; booleans only", () => {
		assert.equal(resolveSettings(null).speech.readQuestion, false);
		assert.equal(resolveSettings({ version: 1, speech: { readQuestion: true } }).speech.readQuestion, true);
		assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { readQuestion: "yes" } })?.speech, {});
		assert.deepEqual(parseSpeechSettingsBody({ readQuestion: true }), { ok: true, settings: { readQuestion: true } });
		assert.equal(parseSpeechSettingsBody({ readQuestion: 1 }).ok, false);
	});
	it("Autoplay replies: off unless saved; booleans only", () => {
		assert.equal(resolveSettings(null).speech.autoplay, false);
		assert.equal(resolveSettings({ version: 1, speech: { autoplay: true } }).speech.autoplay, true);
		assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { autoplay: "yes" } })?.speech, {});
		assert.deepEqual(parseSpeechSettingsBody({ autoplay: true }), { ok: true, settings: { autoplay: true } });
		assert.equal(parseSpeechSettingsBody({ autoplay: 1 }).ok, false);
	});
	it("preserves explicit activation and rejects invalid activation or URL secrets", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { enabled: false } })?.speech, { enabled: false });
		assert.equal(resolveSettings({ version: 1, speech: { enabled: true } }).speech.enabled, true);
		assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { enabled: "true" } })?.speech, {});
		assert.deepEqual(parseSpeechSettingsBody({ enabled: true }), { ok: true, settings: { enabled: true } });
		assert.equal(parseSpeechSettingsBody({ enabled: 1 }).ok, false);
		for (const baseUrl of ["https://user:password@speech.test/v1", "https://speech.test/v1?token=value", "https://speech.test/v1#fragment"]) {
			assert.equal(parseSpeechSettingsBody({ baseUrl }).ok, false);
			assert.deepEqual(sanitizeUserSettings({ version: 1, speech: { baseUrl } })?.speech, {});
		}
	});
});

describe("math speech (speech-rule-engine, server-side)", () => {
	it("reads grouped thousands as quantities in prose and rendered math", async () => {
		assert.equal(await spokenText([{ text: "1,000 and 1,250 packets" }]), "one thousand and one thousand two hundred fifty packets");
		assert.equal(await texToWords("1{,}000"), "one thousand");
		assert.equal(await texToWords("1{,}250"), "one thousand two hundred fifty");
		assert.equal(await texToWords("C = 1{,}250"), "C equals one thousand two hundred fifty");
		assert.equal(await spokenText([{ text: "1,000,000 packets" }]), "one million packets");
	});
	it("preserves math separators and non-quantity number syntax", async () => {
		assert.equal(await texToWords("f(1,250)"), "f of open paren 1 comma 250 close paren");
		const text = "Coordinates 1, 250; 12,34; v1,250; 10.1.4.7; 1,000.25; 01,250; 1,000,00; 9,007,199,254,740,992";
		assert.equal(await spokenText([{ text }]), text);
	});
	it("speaks TeX as words", async () => {
		assert.equal(await texToWords("x^2 + \\frac{1}{2}"), "x squared plus one half");
		assert.match(await texToWords("\\sum_{i=1}^{n} a_i"), /sum from i equals 1 to n of a sub i/);
	});
	it("falls back to the TeX itself when it cannot be read", async () => {
		assert.ok((await texToWords("\\notacommand{")).length > 0);
	});
});

describe("GET/POST /api/tts/openai against an OpenAI-compatible server", () => {
	beforeEach(() => writeSettings({ version: 1, speech: { enabled: true, customEndpoint: true, baseUrl: "http://speech.test/v1/", model: "tts-1", voice: "alloy" } }));

	it("is off until enabled, even with a saved key — the listen affordances stay hidden", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		writeSettings({ version: 1, speech: { customEndpoint: true, baseUrl: "http://speech.test/v1/", model: "tts-1", voice: "alloy" } });
		const res = await tts.GET();
		assert.deepEqual(await res.json(), { configured: false, keyPresent: true, custom: true, baseUrl: "http://speech.test/v1", model: "tts-1", voice: "alloy", readQuestion: false, autoplay: false });
		const refused = await post({ parts: [{ text: "Hello" }] });
		assert.equal(refused.status, 503);
		assert.match(((await refused.json()) as { message: string }).message, /Settings → TTS/);
	});

	it("defaults to OpenAI with the OpenAI key, never the custom key — even with an endpoint saved", async () => {
		writeSettings({ version: 1, speech: { enabled: true, customEndpoint: false, baseUrl: "http://speech.test/v1", model: "tts-1" } });
		process.env.TTS_API_KEY = "custom-key-must-not-be-sent";
		const calls = fakeServer(() => new Response(new Uint8Array([0xff, 0xf3])));
		const missing = await post({ parts: [{ text: "Hello" }] });
		assert.equal(missing.status, 503);
		assert.match(((await missing.json()) as { message: string }).message, /No OpenAI API key/);
		assert.equal(calls.length, 0);
		process.env.OPENAI_API_KEY = "sk-fake-openai-throwaway-key";
		try {
			const status = await (await tts.GET()).json();
			assert.equal(status.custom, false);
			assert.equal(status.keyPresent, true);
			const res = await post({ parts: [{ text: "Hello" }] });
			assert.equal(res.status, 200);
			await res.arrayBuffer();
			assert.equal(calls[0]!.url, "https://api.openai.com/v1/audio/speech");
			assert.equal(calls[0]!.body!.model, "gpt-4o-mini-tts");
			assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer sk-fake-openai-throwaway-key");
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	it("never sends the OpenAI key to a custom server, and refuses one without a server", async () => {
		process.env.OPENAI_API_KEY = "sk-fake-openai-must-not-leak";
		try {
			const calls = fakeServer(() => new Response(new Uint8Array([0xff, 0xf3])));
			const res = await post({ parts: [{ text: "Hello" }] });
			assert.equal(res.status, 200);
			await res.arrayBuffer();
			assert.equal(new Headers(calls[0]!.init.headers).has("authorization"), false, "no endpoint key: keyless");
			writeSettings({ version: 1, speech: { enabled: true, customEndpoint: true } });
			const noServer = await post({ parts: [{ text: "Hello" }] });
			assert.equal(noServer.status, 503);
			assert.match(((await noServer.json()) as { message: string }).message, /No server URL/);
			assert.equal(calls.length, 1);
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	it("sends the OpenAI shape with the server-side key and streams the audio back", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		const calls = fakeServer(() => new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { "content-type": "audio/mpeg" } }));
		assert.equal(((await (await tts.GET()).json()) as { configured: boolean }).configured, true);
		const res = await post({ parts: [{ text: "The area is" }, { tex: "x^2" }] });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "audio/mpeg");
		assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0xff, 0xf3, 1, 2]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "http://speech.test/v1/audio/speech");
		assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer sfy-local-throwaway-test-key");
		assert.deepEqual(calls[0]!.body, { model: "tts-1", voice: "alloy", input: "The area is x squared", response_format: "mp3" });
	});
	it("sends explicit quantity words for prose and math thousands to the provider", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		const calls = fakeServer(() => new Response(new Uint8Array([0xff, 0xf3])));
		const res = await post({ parts: [{ text: "1,000 packets compared with" }, { tex: "1{,}250" }] });
		await res.arrayBuffer();
		assert.equal(calls[0]!.body!.input, "one thousand packets compared with one thousand two hundred fifty");
	});

	it("splits text past the provider limit into ordered requests, concatenating the audio", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		let n = 0;
		const calls = fakeServer(() => new Response(new Uint8Array([++n])));
		const res = await post({ parts: [{ text: "A sentence that keeps going. ".repeat(300) }] });
		assert.equal(res.status, 200);
		assert.ok(calls.length >= 2);
		for (const c of calls) assert.ok((c.body!.input as string).length <= SPEECH_REQUEST_MAX_CHARS);
		assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], calls.map((_, i) => i + 1));
	});

	it("maps provider failures to 502 with the reason (auth failures name the key)", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		fakeServer(() => Response.json({ error: { message: "bad key" } }, { status: 401 }));
		const res = await post({ parts: [{ text: "Hello" }] });
		assert.equal(res.status, 502);
		assert.match(((await res.json()) as { message: string }).message, /401 — check the API key in Settings → TTS → Advanced/);
		fakeServer(() => {
			throw new TypeError("fetch failed");
		});
		const down = await post({ parts: [{ text: "Hello" }] });
		assert.equal(down.status, 502);
		assert.match(((await down.json()) as { message: string }).message, /unreachable at http:\/\/speech\.test\/v1/);
	});

	it("rejects a malformed body before calling anything", async () => {
		process.env.TTS_API_KEY = "sfy-local-throwaway-test-key";
		const calls = fakeServer(() => new Response(""));
		assert.equal((await post({ text: "not parts" })).status, 400);
		assert.equal(calls.length, 0);
	});

	it("explicit activation supports keyless providers without a fabricated bearer token", async () => {
		writeSettings({ version: 1, speech: { enabled: true, customEndpoint: true, baseUrl: "http://speech.test/v1" } });
		const calls = fakeServer(() => new Response(new Uint8Array([0xff, 0xf3])));
		const status = await (await tts.GET()).json();
		assert.equal(status.configured, true);
		assert.equal(status.keyPresent, false);
		const res = await post({ parts: [{ text: "Hello" }] });
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		assert.equal(new Headers(calls[0]!.init.headers).has("authorization"), false);
	});
	it("explicit disable wins over a saved key and never contacts the provider", async () => {
		process.env.TTS_API_KEY = "throwaway-test-key";
		writeSettings({ version: 1, speech: { enabled: false, customEndpoint: true } });
		const calls = fakeServer(() => new Response(""));
		assert.equal((await (await tts.GET()).json()).keyPresent, true);
		assert.equal((await post({ parts: [{ text: "Hello" }] })).status, 503);
		assert.equal(calls.length, 0);
	});
	it("does not expose provider error bodies that echo the API key", async () => {
		process.env.TTS_API_KEY = "throwaway-private-key";
		fakeServer(() => Response.json({ error: { message: `Rejected ${process.env.TTS_API_KEY}` } }, { status: 401 }));
		const res = await post({ parts: [{ text: "Hello" }] });
		assert.equal(res.status, 502);
		assert.doesNotMatch(await res.text(), /throwaway-private-key/);
	});
});
