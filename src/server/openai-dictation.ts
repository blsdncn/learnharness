import { DEFAULT_DICTATION_MODEL, OPENAI_DICTATION_BASE_URL, DICTATION_SAMPLE_RATE, MAX_DICTATION_WAV_BYTES, WAV_HEADER_BYTES, type DictationSettings } from "../core/dictation.ts";
import { normalizeSpeechBaseUrl } from "../core/settings.ts";
import { CUSTOM_AUDIO_KEY, DEFAULT_AUDIO_KEY_SOURCE } from "../core/auth-keys.ts";

interface DictationDeps extends DictationSettings {
	apiKey: string | undefined;
	enabled: boolean;
	fetchFn?: typeof fetch;
}

const response = (message: string, status: number) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });

/** Read incrementally so a request without Content-Length cannot exceed the cap. */
async function readAudio(request: Request): Promise<Uint8Array | null> {
	const announced = request.headers.get("content-length");
	if (announced && (!/^\d+$/.test(announced) || Number(announced) > MAX_DICTATION_WAV_BYTES)) return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_DICTATION_WAV_BYTES) { void reader.cancel(); return null; }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}

/** Accept the exact WAV emitted by the capture helper, not arbitrary uploads. */
function validWav(bytes: Uint8Array): boolean {
	if (bytes.byteLength <= WAV_HEADER_BYTES || bytes.byteLength > MAX_DICTATION_WAV_BYTES) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, text: string) => [...text].every((char, i) => view.getUint8(offset + i) === char.charCodeAt(0));
	const length = bytes.byteLength - WAV_HEADER_BYTES;
	return length % 2 === 0 && ascii(0, "RIFF") && view.getUint32(4, true) === bytes.byteLength - 8 &&
		ascii(8, "WAVE") && ascii(12, "fmt ") && view.getUint32(16, true) === 16 &&
		view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 &&
		view.getUint32(24, true) === DICTATION_SAMPLE_RATE && view.getUint32(28, true) === DICTATION_SAMPLE_RATE * 2 &&
		view.getUint16(32, true) === 2 && view.getUint16(34, true) === 16 &&
		ascii(36, "data") && view.getUint32(40, true) === length;
}

/** One explicitly selected Platform API transcription. Never exposes a key or raw upstream error. */
export async function transcribeOpenAIDictation(request: Request, deps: DictationDeps): Promise<Response> {
	if (!deps.enabled) return response("Select OpenAI-compatible in Dictation settings first.", 403);
	const baseUrl = normalizeSpeechBaseUrl(deps.baseUrl ?? OPENAI_DICTATION_BASE_URL);
	if (!baseUrl) return response("Invalid dictation server URL.", 400);
	if (deps.keySource !== CUSTOM_AUDIO_KEY && !deps.apiKey) return response(`No ${deps.keySource ?? DEFAULT_AUDIO_KEY_SOURCE} configured — pick a saved key in Settings → Dictation.`, 503);
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("audio/wav")) return response("Expected WAV audio.", 415);
	let bytes: Uint8Array | null;
	try { bytes = await readAudio(request); } catch { return response("Could not read dictation audio.", 400); }
	if (!bytes || !validWav(bytes)) return response("Invalid or oversized dictation audio.", 400);
	const form = new FormData();
	form.append("file", new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }), "dictation.wav");
	form.append("model", deps.model ?? DEFAULT_DICTATION_MODEL);
	try {
		const upstream = await (deps.fetchFn ?? fetch)(`${baseUrl}/audio/transcriptions`, {
			method: "POST",
			headers: deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {},
			redirect: "error",
			body: form,
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
		});
		if (!upstream.ok) {
			await upstream.body?.cancel().catch(() => {});
			return response(`Transcription server answered ${upstream.status}.`, 502);
		}
		const result: unknown = await upstream.json();
		if (!result || typeof result !== "object" || typeof (result as { text?: unknown }).text !== "string") {
			return response("Transcription server returned an invalid transcript.", 502);
		}
		return Response.json({ text: (result as { text: string }).text }, { headers: { "Cache-Control": "no-store" } });
	} catch { return response("Transcription could not be completed. Check Dictation connection settings.", 502); }
}
