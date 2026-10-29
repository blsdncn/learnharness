/**
 * Speech (listen wave, 2026-10-26): the contract between the listening UI
 * and POST /api/tts/openai. Pure, browser-safe.
 *
 * The client sends one listenable BLOCK as parts in reading order: prose
 * as text, math as its TeX source (KaTeX keeps it in the DOM). The server
 * turns TeX into words (speech-rule-engine, server-only) so neither the
 * engine nor its locale data ever ship to the browser, then synthesizes
 * the joined text through the configured OpenAI-compatible endpoint.
 */

export type SpeechPart = { text: string } | { tex: string };

/** OpenAI's /audio/speech input limit is 4096 characters; stay under it. */
export const SPEECH_REQUEST_MAX_CHARS = 4000;

/** One block is a paragraph or a card section — anything beyond this is a
 *  client bug or abuse, not a block. */
export const SPEECH_BLOCK_MAX_CHARS = 20_000;

export type SpeechRequestResult = { ok: true; parts: SpeechPart[] } | { ok: false; error: string };

export function parseSpeechRequest(body: unknown): SpeechRequestResult {
	const raw = (body as { parts?: unknown } | null)?.parts;
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "parts must be a non-empty array" };
	const parts: SpeechPart[] = [];
	let size = 0;
	for (const p of raw) {
		const part = p as { text?: unknown; tex?: unknown } | null;
		if (part && typeof part.text === "string") {
			parts.push({ text: part.text });
			size += part.text.length;
		} else if (part && typeof part.tex === "string") {
			parts.push({ tex: part.tex });
			size += part.tex.length;
		} else {
			return { ok: false, error: "each part must be {text: string} or {tex: string}" };
		}
	}
	if (size > SPEECH_BLOCK_MAX_CHARS) return { ok: false, error: `block exceeds ${SPEECH_BLOCK_MAX_CHARS} characters` };
	if (!parts.some((p) => ("text" in p ? p.text : p.tex).trim())) return { ok: false, error: "nothing to speak" };
	return { ok: true, parts };
}

/** Collapse whitespace the way a reader hears it. */
export function normalizeSpokenText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Split spoken text into requests of at most `max` characters, cutting at
 * sentence ends, then word gaps — never mid-word unless a single word is
 * longer than `max`.
 */
export function splitSpokenText(text: string, max = SPEECH_REQUEST_MAX_CHARS): string[] {
	const out: string[] = [];
	let rest = normalizeSpokenText(text);
	while (rest.length > max) {
		const window = rest.slice(0, max + 1);
		const sentence = Math.max(...[". ", "! ", "? ", "; "].map((m) => window.lastIndexOf(m)));
		const space = window.lastIndexOf(" ");
		const cut = sentence > max / 3 ? sentence + 1 : space > 0 ? space : max;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}
