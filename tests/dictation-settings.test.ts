import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

it("defaults to Deepgram and the current OpenAI transcription model without sharing TTS settings", () => {
	const resolved = resolveSettings({ version: 1, speech: { baseUrl: "http://tts.test/v1", model: "tts-model" } });
	assert.equal(resolved.general.dictationProvider, "deepgram");
	assert.deepEqual(resolved.dictation, { baseUrl: "https://api.openai.com/v1", model: "gpt-transcribe", keySource: "OPENAI_API_KEY" });
});

it("any saved provider key may be selected for any endpoint — the explicit pick is the consent", () => {
	const resolved = resolveSettings(sanitizeUserSettings({ version: 1, dictation: { baseUrl: "http://local.test/v1/", model: "custom", keySource: "GROQ_API_KEY" } }));
	assert.deepEqual(resolved.dictation, { baseUrl: "http://local.test/v1", model: "custom", keySource: "GROQ_API_KEY" });
	assert.deepEqual(parseDictationSettingsBody({ baseUrl: "http://local.test/v1", keySource: "OPENAI_API_KEY" }), {
		ok: true, settings: { baseUrl: "http://local.test/v1", keySource: "OPENAI_API_KEY" },
	});
	// Tool keys (and anything else) are never valid sources.
	for (const keySource of ["TAVILY_API_KEY", "DEEPGRAM_API_KEY", "TTS_API_KEY", "openai", "stt"]) {
		assert.equal(parseDictationSettingsBody({ keySource }).ok, false, keySource);
		assert.equal(sanitizeUserSettings({ version: 1, dictation: { keySource } })?.dictation?.keySource, undefined, keySource);
	}
});

it("validates explicit key selection and endpoint settings without persisting key values", () => {
	assert.deepEqual(parseDictationSettingsBody({ baseUrl: "http://local.test/v1/", model: " whisper-local ", keySource: "custom", apiKey: "not-persisted" }), {
		ok: true, settings: { baseUrl: "http://local.test/v1", model: "whisper-local", keySource: "custom" },
	});
	for (const body of [{ keySource: "fallback" }, { baseUrl: "https://user:password@test/v1" }, { model: 42 }]) {
		assert.equal(parseDictationSettingsBody(body).ok, false);
	}
});
