/** Opt-in live synthesis through the same route used by the listening UI.
 * Run with: node --import tsx scripts/smoke-tts.mjs
 * TTS_BASE_URL, TTS_MODEL, TTS_VOICE override OpenAI defaults.
 * Authentication: TTS_KEY_SOURCE=OPENAI_API_KEY (or another provider key name)
 * reads that key (or <NAME>_FILE); otherwise the custom TTS_API_KEY or
 * TTS_API_KEY_FILE, omitting both for keyless servers.
 * Temporary settings are isolated; no audio or credentials are saved.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-live-tts-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
try {
	const keySource = process.env.TTS_KEY_SOURCE ?? "custom";
	const keyId = keySource === "custom" ? "TTS_API_KEY" : keySource;
	if (process.env[`${keyId}_FILE`]) {
		process.env[keyId] = fs.readFileSync(process.env[`${keyId}_FILE`], "utf8").trim();
		assert.ok(process.env[keyId], "The API key file is empty");
	}
	const { parseSpeechSettingsBody } = await import("../src/server/settings-body.ts");
	const { writeSettings } = await import("../src/store/settings.ts");
	const settings = parseSpeechSettingsBody({
		enabled: true,
		keySource,
		baseUrl: process.env.TTS_BASE_URL ?? "https://api.openai.com/v1",
		model: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
		voice: process.env.TTS_VOICE ?? "alloy",
	});
	assert.ok(settings.ok, settings.ok ? "" : settings.error);
	writeSettings({ version: 1, speech: settings.settings });
	const { POST } = await import("../app/api/tts/openai/route.ts");
	const response = await POST(new Request("http://app.test/api/tts/openai", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ parts: [{ text: "The area is" }, { tex: "x^2" }] }),
		signal: AbortSignal.timeout(60_000),
	}));
	assert.equal(response.status, 200, `Synthesis failed with HTTP ${response.status}`);
	assert.equal(response.headers.get("content-type"), "audio/mpeg");
	const audio = Buffer.from(await response.arrayBuffer());
	const mp3 = audio.subarray(0, 3).toString() === "ID3" ||
		(audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
	assert.ok(audio.length > 512 && mp3, "The response was not a non-empty MP3");
	console.log(`[smoke-tts] synthesis passed through /api/tts/openai (${audio.length} MP3 bytes)`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
