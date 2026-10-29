import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { openAIDictationLanguage } from "../src/core/dictation.ts";
import { parseDictationSettingsBody, parseGeneralSettingsBody } from "../src/server/settings-body.ts";

it("defaults to Deepgram, and OpenAI dictation to OpenAI's model, never the TTS endpoint", () => {
	const resolved = resolveSettings({ version: 1, speech: { provider: "custom", customModel: "tts-model" }, customTtsProvider: { baseUrl: "http://tts.test/v1" } });
	assert.equal(resolved.general.dictationProvider, "deepgram");
	assert.deepEqual(resolved.dictation, { language: "en", custom: false, baseUrl: "https://api.openai.com/v1", model: "gpt-transcribe" });
});

it("the custom endpoint and its model apply only while Custom is the provider", () => {
	const saved = { dictation: { customModel: "whisper-local" }, customSttProvider: { baseUrl: "http://local.test/v1/", models: [{ id: "whisper-local" }] } };
	const off = resolveSettings(sanitizeUserSettings({ version: 1, general: { dictationProvider: "openai" }, ...saved }));
	assert.deepEqual(off.dictation, { language: "en", custom: false, baseUrl: "https://api.openai.com/v1", model: "gpt-transcribe" }, "kept, but unused while OpenAI is chosen");
	const on = resolveSettings(sanitizeUserSettings({ version: 1, general: { dictationProvider: "custom" }, ...saved }));
	assert.deepEqual(on.dictation, { language: "en", custom: true, baseUrl: "http://local.test/v1", model: "whisper-local" });
	const blank = resolveSettings({ version: 1, general: { dictationProvider: "custom" } });
	assert.deepEqual(blank.dictation, { language: "en", custom: true, baseUrl: null, model: null }, "no endpoint, no model: refused at request time, never OpenAI");
});

it("validates the model and provider, and drops retired or secret fields", () => {
	assert.deepEqual(parseDictationSettingsBody({ language: "pl", customModel: " whisper-local ", customEndpoint: true, baseUrl: "http://local.test/v1/", keySource: "GROQ_API_KEY", apiKey: "not-persisted" }), {
		ok: true, settings: { language: "pl", customModel: "whisper-local" },
	});
	for (const body of [{ customModel: 42 }, { language: "xx" }]) {
		assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
	}
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { keySource: "GROQ_API_KEY", customEndpoint: true, baseUrl: "http://local.test/v1" } })?.dictation, {});
	assert.equal(sanitizeUserSettings({ version: 1, general: { dictationProvider: "custom" } })?.general?.dictationProvider, "custom");
	assert.equal(parseGeneralSettingsBody({ dictationProvider: "custom" }).ok, true);
	assert.equal(parseGeneralSettingsBody({ dictationProvider: "whisper" }).ok, false);
});

it("OpenAI gets the language part of the dictation language; Multilingual sends none", () => {
	assert.equal(openAIDictationLanguage("en-US"), "en");
	assert.equal(openAIDictationLanguage("zh-Hant"), "zh");
	assert.equal(openAIDictationLanguage("pl"), "pl");
	assert.equal(openAIDictationLanguage("multi"), undefined);
});
