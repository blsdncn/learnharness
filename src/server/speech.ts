/**
 * Speech (listen wave, 2026-10-26): text-to-speech through the OpenAI shape —
 * `POST {baseUrl}/audio/speech` with {model, voice, input, response_format}
 * returning audio bytes. OpenAI by default; the TTS custom endpoint (any
 * compatible hosted or local server, connected in Settings → Providers →
 * TTS with its key bound to its URL) uses the same request
 * (core/audio-connection.ts).
 *
 * The key never reaches the browser (the Deepgram precedent): the client
 * posts text to /api/tts/openai and this module calls the provider. That also
 * makes listening work over remote access — a phone can't reach a speech
 * server on the laptop's loopback, but the laptop's server can.
 *
 * Math: the client sends TeX; it becomes words here (KaTeX → MathML →
 * speech-rule-engine, ClearSpeak English). The engine loads its locale
 * JSON from its own package dir at runtime, hence serverExternalPackages
 * + the tracing include in next.config.ts.
 */

import katex from "katex";
import { normalizeSpokenText, splitSpokenText, type SpeechPart } from "../core/speech.ts";
import { OPENAI_AUDIO_KEY_ID } from "../core/audio-connection.ts";
import { TTS_ENDPOINT } from "../core/custom-provider-auth.ts";
import { readSettings } from "../store/settings.ts";
import { customEndpointCredential } from "./custom-provider-auth.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

export interface SpeechStatus {
	/** Listening is enabled; this is not a provider readiness check. */
	configured: boolean;
	/** OpenAI: its key has a value. Custom: the endpoint's credential is
	 *  authorized for its URL (or it's keyless). */
	keyPresent: boolean;
	/** The custom endpoint is the provider (otherwise OpenAI). */
	custom: boolean;
	baseUrl: string | null;
	model: string | null;
	voice: string;
	/** Read from here continues into the dock (Settings → TTS). */
	readQuestion: boolean;
	/** Replies to turns you start are read as they arrive (Settings → TTS). */
	autoplay: boolean;
}

/** The key one request may send: OpenAI's from Providers, or the custom
 *  endpoint's bound credential (undefined apiKey = keyless). */
function speechCredential(custom: boolean): { ok: true; apiKey?: string } | { ok: false } {
	if (custom) return customEndpointCredential(TTS_ENDPOINT, readSettings()?.customTtsProvider);
	const apiKey = keyValue(OPENAI_AUDIO_KEY_ID);
	return apiKey ? { ok: true, apiKey } : { ok: false };
}

export function speechStatus(): SpeechStatus {
	const { enabled, voice, readQuestion, autoplay, custom, baseUrl, model } = effectiveSettings().speech;
	return { configured: enabled ?? false, keyPresent: speechCredential(custom).ok, custom, baseUrl, model, voice, readQuestion, autoplay };
}

/** A refusal carrying the HTTP status the route should answer with. */
export class SpeechError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

// ─── math → words ────────────────────────────────────────────────────────────

type MathEngine = typeof import("speech-rule-engine").default;
let mathEngine: Promise<MathEngine> | null = null;

function loadMathEngine() {
	mathEngine ??= import("speech-rule-engine").then(async (mod) => {
		// A CommonJS bundle flagged __esModule: some loaders hand back the
		// exports object as `default`, others as the namespace itself.
		const SRE = ((mod as { default?: MathEngine }).default ?? mod) as MathEngine;
		await SRE.setupEngine({ domain: "clearspeak", locale: "en", modality: "speech", markup: "none" });
		await SRE.engineReady();
		return SRE;
	});
	return mathEngine;
}

/** English thousands separators are not spoken consistently by providers.
 * Send quantity words for complete, safely representable grouped integers.
 * Leave identifiers, decimals, addresses, and malformed groups untouched;
 * math argument separators arrive from SRE as "comma", not a digit comma. */
async function expandGroupedNumbers(text: string): Promise<string> {
	const grouped = /(?<![\w.,])[1-9]\d{0,2}(?:,\d{3})+(?![\w]|[.,]\d)/g;
	if (!grouped.test(text)) return text;
	try {
		const SRE = await loadMathEngine();
		return text.replace(grouped, (value) => {
			const digits = value.replace(/,/g, "");
			return Number.isSafeInteger(Number(digits)) ? SRE.number(digits).replace(/-/g, " ") : value;
		});
	} catch {
		console.warn("[speech] number speech failed, retaining numeric text");
		return text;
	}
}

/** Spoken words for one TeX expression; the raw TeX when anything fails
 *  (a mangled formula read literally beats silence). */
export async function texToWords(tex: string): Promise<string> {
	try {
		const html = katex.renderToString(tex, { output: "mathml", throwOnError: false });
		const mathml = html.match(/<math[\s\S]*<\/math>/)?.[0]?.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
		if (!mathml) return tex;
		const SRE = await loadMathEngine();
		return await expandGroupedNumbers(SRE.toSpeech(mathml) || tex);
	} catch (error) {
		console.warn(`[speech] math speech failed, reading TeX: ${(error as Error).message}`);
		return tex;
	}
}

export async function spokenText(parts: readonly SpeechPart[]): Promise<string> {
	const words = await Promise.all(parts.map((p) => ("text" in p ? p.text : texToWords(p.tex))));
	return normalizeSpokenText(await expandGroupedNumbers(words.join(" ")));
}

// ─── synthesis ───────────────────────────────────────────────────────────────

async function requestSpeech(status: SpeechStatus & { baseUrl: string; model: string }, apiKey: string | undefined, input: string, signal: AbortSignal): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${status.baseUrl}/audio/speech`, {
			method: "POST",
			headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
			body: JSON.stringify({ model: status.model, voice: status.voice, input, response_format: "mp3" }),
			// A redirect could carry the bound key to another server.
			redirect: "error",
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new SpeechError(502, `Speech server unreachable at ${status.baseUrl}`);
	}
	if (!res.ok || !res.body) {
		// Provider errors may echo credentials or request contents. Return only
		// the status and actionable local configuration guidance.
		await res.body?.cancel().catch(() => {});
		const why = res.status === 401 || res.status === 403
			? status.custom ? " — check the custom endpoint's key in Settings → Providers → TTS" : " — check the OpenAI key in Settings → Providers"
			: "";
		throw new SpeechError(502, `Speech server answered ${res.status}${why}`);
	}
	return res;
}

/**
 * MP3 audio for one block, as a stream. The first upstream request is
 * awaited before returning, so configuration and provider errors surface
 * as a real status instead of a broken stream; text over the provider's
 * input limit continues in further requests, appended in order (MP3 frames
 * concatenate).
 */
export async function synthesizeSpeech(parts: readonly SpeechPart[], signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	const status = speechStatus();
	if (!status.configured) throw new SpeechError(503, "Listening is off — enable it in Settings → TTS.");
	const { baseUrl, model } = status;
	if (!baseUrl) throw new SpeechError(503, "No custom TTS endpoint — add one in Settings → Providers → TTS.");
	if (!model) throw new SpeechError(503, "No TTS model — pick one in Settings → Providers → TTS.");
	const credential = speechCredential(status.custom);
	if (!credential.ok) {
		throw new SpeechError(503, status.custom
			? "The custom TTS endpoint isn't authorized — reconnect it in Settings → Providers → TTS."
			: "No OpenAI API key — add one in Settings → Providers.");
	}
	const { apiKey } = credential;
	const chunks = splitSpokenText(await spokenText(parts));
	if (chunks.length === 0) throw new SpeechError(400, "nothing to speak");
	const abort = new AbortController();
	const upstreamSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
	const target = { ...status, baseUrl, model };
	const first = await requestSpeech(target, apiKey, chunks[0]!, upstreamSignal);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let cancelled = false;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for (let i = 0; i < chunks.length; i++) {
					if (cancelled) return;
					const res = i === 0 ? first : await requestSpeech(target, apiKey, chunks[i]!, upstreamSignal);
					reader = res.body!.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (cancelled) return;
						if (done) break;
						controller.enqueue(value);
					}
					reader.releaseLock();
					reader = undefined;
				}
				controller.close();
			} catch (error) {
				if (!cancelled) controller.error(error);
			} finally {
				reader?.releaseLock();
			}
		},
		cancel(reason) {
			cancelled = true;
			abort.abort(reason);
			return reader?.cancel(reason).catch(() => {});
		},
	});
}
