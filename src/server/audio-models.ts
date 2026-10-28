/**
 * The model list behind Settings → TTS / Dictation's Model picker:
 * `GET {baseUrl}/models` on the SAVED connection with the SAVED key
 * source, so the browser can never point a stored key at a URL of its
 * choosing. The OpenAI shape ({data: [{id}]}) carries no capability
 * field, so every id is returned, A–Z, unfiltered (owner ruling): name
 * guessing would hide models on servers we don't know.
 */

import { normalizeSpeechBaseUrl, SPEECH_ID_MAX } from "../core/settings.ts";
import { CUSTOM_AUDIO_KEY } from "../core/auth-keys.ts";

export interface AudioModelsDeps {
	baseUrl: string;
	keySource: string;
	apiKey: string | undefined;
	/** The settings page named in hints: "TTS" or "Dictation". */
	settingsName: string;
	fetchFn?: typeof fetch;
}

const reply = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** {models: string[]} on success, {message} otherwise. Never exposes a
 *  key or the provider's error body. */
export async function listAudioModels(deps: AudioModelsDeps): Promise<Response> {
	const baseUrl = normalizeSpeechBaseUrl(deps.baseUrl);
	if (!baseUrl) return reply({ message: "Invalid server URL." }, 400);
	if (deps.keySource !== CUSTOM_AUDIO_KEY && !deps.apiKey) {
		return reply({ message: `No ${deps.keySource} configured — pick a saved key in Settings → ${deps.settingsName}.` }, 503);
	}
	let upstream: Response;
	try {
		upstream = await (deps.fetchFn ?? fetch)(`${baseUrl}/models`, {
			headers: deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {},
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		return reply({ message: `Server unreachable at ${baseUrl}` }, 502);
	}
	if (!upstream.ok) {
		await upstream.body?.cancel().catch(() => {});
		const why = upstream.status === 401 || upstream.status === 403
			? ` — check the API key in Settings → ${deps.settingsName}`
			: upstream.status === 404 ? " — this server doesn't list models; type a model id" : "";
		return reply({ message: `Server answered ${upstream.status}${why}` }, 502);
	}
	const body: unknown = await upstream.json().catch(() => null);
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return reply({ message: "Server returned an invalid model list" }, 502);
	const ids = new Set<string>();
	for (const entry of data) {
		const id = (entry as { id?: unknown } | null)?.id;
		if (typeof id === "string" && id.trim() && id.length <= SPEECH_ID_MAX) ids.add(id.trim());
	}
	return reply({ models: [...ids].sort((a, b) => a.localeCompare(b, "en")) });
}
