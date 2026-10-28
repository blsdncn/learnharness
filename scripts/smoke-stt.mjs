/** Opt-in live transcription through the same route the dictation UI uses.
 * Run with: STT_SAMPLE=<16 kHz mono PCM16 WAV> STT_EXPECT="words" node --import tsx scripts/smoke-stt.mjs
 * STT_BASE_URL, STT_MODEL override OpenAI defaults.
 * Authentication: STT_KEY_SOURCE=OPENAI_API_KEY (or another provider key name)
 * reads that key (or <NAME>_FILE); otherwise the custom STT_API_KEY or
 * STT_API_KEY_FILE, omitting both for keyless servers.
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
	const keySource = process.env.STT_KEY_SOURCE ?? "custom";
	const keyId = keySource === "custom" ? "STT_API_KEY" : keySource;
	if (process.env[`${keyId}_FILE`]) {
		process.env[keyId] = fs.readFileSync(process.env[`${keyId}_FILE`], "utf8").trim();
		assert.ok(process.env[keyId], "The API key file is empty");
	}
	assert.ok(process.env.STT_SAMPLE && process.env.STT_EXPECT, "STT_SAMPLE and STT_EXPECT are required");
	const { parseDictationSettingsBody } = await import("../src/server/settings-body.ts");
	const { writeSettings } = await import("../src/store/settings.ts");
	const settings = parseDictationSettingsBody({
		keySource,
		...(process.env.STT_BASE_URL ? { baseUrl: process.env.STT_BASE_URL } : {}),
		...(process.env.STT_MODEL ? { model: process.env.STT_MODEL } : {}),
	});
	assert.ok(settings.ok, settings.ok ? "" : settings.error);
	writeSettings({ version: 1, general: { dictationProvider: "openai" }, dictation: settings.settings });
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
