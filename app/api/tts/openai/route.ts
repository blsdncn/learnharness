/**
 * Text-to-speech (listen wave, 2026-10-26).
 *
 *   GET  → {configured, keyPresent, custom, baseUrl, model, voice, readQuestion} — the listening
 *          UI shows its affordances when listening is enabled.
 *   POST {parts: [{text} | {tex}]} → audio/mpeg for one listenable block,
 *          streamed from OpenAI or the custom endpoint. 503 when
 *          unconfigured, 400 on a bad body, 502 when the provider fails.
 *
 * The provider key stays server-side (server/speech.ts).
 */
import { parseSpeechRequest } from "@/src/core";
import { SpeechError, speechStatus, synthesizeSpeech } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(speechStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const parsed = parseSpeechRequest(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ message: parsed.error }, { status: 400 });
	try {
		const audio = await synthesizeSpeech(parsed.parts, request.signal);
		return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof SpeechError) return Response.json({ message: error.message }, { status: error.status });
		if (request.signal.aborted) return new Response(null, { status: 499 });
		throw error;
	}
}
