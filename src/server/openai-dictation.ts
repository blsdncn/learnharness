import { DICTATION_SAMPLE_RATE, MAX_DICTATION_WAV_BYTES, WAV_HEADER_BYTES, openAIDictationLanguage, type DictationLanguage } from "../core/dictation.ts";
import { normalizeBaseUrl } from "../core/settings.ts";
import { OPENAI_AUDIO_KEY_ID, type AudioConnection } from "../core/audio-connection.ts";
import { STT_ENDPOINT } from "../core/custom-provider-auth.ts";
import { readSettings } from "../store/settings.ts";
import { customEndpointCredential } from "./custom-provider-auth.ts";
import { keyValue } from "./keys.ts";

interface DictationDeps extends AudioConnection {
	language: DictationLanguage;
	apiKey?: string;
	enabled: boolean;
	fetchFn?: typeof fetch;
}

/** The key one upload may send: OpenAI's from Providers, or the custom
 *  endpoint's bound credential (undefined apiKey = keyless). */
export function dictationCredential(custom: boolean): { authorized: boolean; apiKey?: string } {
	if (!custom) return { authorized: true, apiKey: keyValue(OPENAI_AUDIO_KEY_ID) };
	const credential = customEndpointCredential(STT_ENDPOINT, readSettings()?.customSttProvider);
	return credential.ok ? { authorized: true, apiKey: credential.apiKey } : { authorized: false };
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

/** One explicitly selected OpenAI-shape transcription (OpenAI or the custom
 *  endpoint). Never exposes a key or raw upstream error. `authorized` false:
 *  the custom endpoint's credential isn't bound to its URL. */
export async function transcribeOpenAIDictation(request: Request, deps: DictationDeps & { authorized?: boolean }): Promise<Response> {
	if (!deps.enabled) return response("Select OpenAI or Custom endpoint in Settings → Providers → Dictation first.", 403);
	if (!deps.baseUrl) return response("No custom dictation endpoint — add one in Settings → Providers → Dictation.", 503);
	if (!deps.model) return response("No dictation model — pick one in Settings → Providers → Dictation.", 503);
	const baseUrl = normalizeBaseUrl(deps.baseUrl);
	if (!baseUrl) return response("Invalid dictation server URL.", 400);
	if (deps.custom && deps.authorized === false) return response("The custom dictation endpoint isn't authorized — reconnect it in Settings → Providers → Dictation.", 503);
	if (!deps.custom && !deps.apiKey) return response("No OpenAI API key — add one in Settings → Providers.", 503);
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("audio/wav")) return response("Expected WAV audio.", 415);
	let bytes: Uint8Array | null;
	try { bytes = await readAudio(request); } catch { return response("Could not read dictation audio.", 400); }
	if (!bytes || !validWav(bytes)) return response("Invalid or oversized dictation audio.", 400);
	const form = new FormData();
	form.append("file", new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }), "dictation.wav");
	form.append("model", deps.model);
	const language = openAIDictationLanguage(deps.language);
	if (language) form.append("language", language);
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
	} catch { return response("Transcription could not be completed. Check the dictation settings in Providers.", 502); }
}
