/** Opt-in live transcription through the same route the dictation UI uses.
 * Run with: STT_SAMPLE=<16 kHz mono PCM16 WAV> STT_EXPECT="words" node --import tsx scripts/smoke-stt.mjs
 * Default: OpenAI, with OPENAI_API_KEY (or OPENAI_API_KEY_FILE).
 * STT_BASE_URL connects the custom endpoint through its real Connect route
 * and picks STT_MODEL (required), with CUSTOM_STT_API_KEY or
 * CUSTOM_STT_API_KEY_FILE — omit both for keyless servers.
 * STT_LANGUAGE sets the dictation language (default en).
 * Temporary settings are isolated; no audio or credentials are saved.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-live-stt-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const words = (text) => text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
try {
	const custom = Boolean(process.env.STT_BASE_URL);
	const keyId = custom ? "CUSTOM_STT_API_KEY" : "OPENAI_API_KEY";
	if (process.env[`${keyId}_FILE`]) {
		process.env[keyId] = fs.readFileSync(process.env[`${keyId}_FILE`], "utf8").trim();
		assert.ok(process.env[keyId], "The API key file is empty");
	}
	assert.ok(process.env.STT_SAMPLE && process.env.STT_EXPECT, "STT_SAMPLE and STT_EXPECT are required");
	const { parseDictationSettingsBody } = await import("../src/server/settings-body.ts");
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	if (custom) {
		assert.ok(process.env.STT_MODEL, "STT_MODEL is required with STT_BASE_URL");
		const { connectSmokeEndpoint } = await import("./smoke-audio-endpoint.mjs");
		await connectSmokeEndpoint("../app/api/stt/custom-endpoint/route.ts", process.env.STT_BASE_URL, process.env.CUSTOM_STT_API_KEY, process.env.STT_MODEL);
	}
	const settings = parseDictationSettingsBody({
		...(custom ? { customModel: process.env.STT_MODEL } : {}),
		...(process.env.STT_LANGUAGE ? { language: process.env.STT_LANGUAGE } : {}),
	});
	assert.ok(settings.ok, settings.ok ? "" : settings.error);
	writeSettings({ ...(readSettings() ?? { version: 1 }), general: { dictationProvider: custom ? "custom" : "openai" }, dictation: settings.settings });
	const { POST } = await import("../app/api/stt/openai/route.ts");
	const response = await POST(new Request("http://app.test/api/stt/openai", {
		method: "POST", headers: { "content-type": "audio/wav" },
		body: fs.readFileSync(process.env.STT_SAMPLE),
		signal: AbortSignal.timeout(120_000),
	}));
	const body = await response.json();
	assert.equal(response.status, 200, `Transcription failed with HTTP ${response.status}: ${body.message ?? ""}`);
	const heard = new Set(words(body.text));
	const missing = words(process.env.STT_EXPECT).filter((w) => !heard.has(w));
	assert.deepEqual(missing, [], `Transcript missed words: ${JSON.stringify(body.text)}`);
	console.log(`[smoke-stt] transcription passed through /api/stt/openai: ${JSON.stringify(body.text)}`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
