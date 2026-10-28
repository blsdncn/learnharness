import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { openAIDictationLanguage } from "../src/core/dictation.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

it("defaults to Deepgram, and OpenAI dictation to OpenAI's model and key, never the TTS settings", () => {
	const resolved = resolveSettings({ version: 1, speech: { customEndpoint: true, baseUrl: "http://tts.test/v1", model: "tts-model" } });
	assert.equal(resolved.general.dictationProvider, "deepgram");
	assert.deepEqual(resolved.dictation, { language: "en", custom: false, baseUrl: "https://api.openai.com/v1", model: "gpt-transcribe", keyId: "OPENAI_API_KEY" });
});

it("the custom endpoint is the switch: its server, model and own key apply only while it's on", () => {
	const saved = { baseUrl: "http://local.test/v1/", model: "whisper-local" };
	const off = resolveSettings(sanitizeUserSettings({ version: 1, dictation: saved }));
	assert.deepEqual(off.dictation, { language: "en", custom: false, baseUrl: "https://api.openai.com/v1", model: "gpt-transcribe", keyId: "OPENAI_API_KEY" }, "kept, but unused while off");
	const on = resolveSettings(sanitizeUserSettings({ version: 1, dictation: { ...saved, customEndpoint: true } }));
	assert.deepEqual(on.dictation, { language: "en", custom: true, baseUrl: "http://local.test/v1", model: "whisper-local", keyId: "STT_API_KEY" });
	const blank = resolveSettings({ version: 1, dictation: { customEndpoint: true } });
	assert.deepEqual(blank.dictation, { language: "en", custom: true, baseUrl: null, model: "gpt-transcribe", keyId: "STT_API_KEY" }, "no server: refused at request time, never OpenAI");
});

it("validates the endpoint fields and drops retired or secret fields", () => {
	assert.deepEqual(parseDictationSettingsBody({ language: "pl", customEndpoint: true, baseUrl: "http://local.test/v1/", model: " whisper-local ", keySource: "GROQ_API_KEY", apiKey: "not-persisted" }), {
		ok: true, settings: { language: "pl", customEndpoint: true, baseUrl: "http://local.test/v1", model: "whisper-local" },
	});
	for (const body of [{ customEndpoint: "yes" }, { baseUrl: "https://user:password@test/v1" }, { model: 42 }, { language: "xx" }]) {
		assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
	}
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { keySource: "GROQ_API_KEY", customEndpoint: "on" } })?.dictation, {});
});

it("OpenAI gets the language part of the dictation language; Multilingual sends none", () => {
	assert.equal(openAIDictationLanguage("en-US"), "en");
	assert.equal(openAIDictationLanguage("zh-Hant"), "zh");
	assert.equal(openAIDictationLanguage("pl"), "pl");
	assert.equal(openAIDictationLanguage("multi"), undefined);
});
