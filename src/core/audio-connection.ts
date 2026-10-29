/**
 * Where an audio request goes (TTS, OpenAI-shape dictation). OpenAI: the
 * fixed base and model, with the OpenAI key from Providers. Custom: the
 * feature's own custom endpoint (settings.customTtsProvider /
 * customSttProvider — connected like the chat custom endpoint, its key
 * bound to its URL) and the model picked for it. The OpenAI key is never
 * sent to a custom server. Browser-safe.
 */

import type { CustomProviderSettings } from "./settings.ts";

export const OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_AUDIO_KEY_ID = "OPENAI_API_KEY";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_DICTATION_MODEL = "gpt-transcribe";
/** The audio custom endpoints' keys (auth.json entry and env var), parallel
 *  to the chat endpoint's CUSTOM_OPENAI_API_KEY. */
export const CUSTOM_TTS_KEY_ID = "CUSTOM_TTS_API_KEY";
export const CUSTOM_STT_KEY_ID = "CUSTOM_STT_API_KEY";

/** The request paths under a base URL — shown live in each endpoint's form. */
export const TTS_PATH = "/audio/speech";
export const STT_PATH = "/audio/transcriptions";

export interface AudioConnection {
	custom: boolean;
	/** null: custom is chosen but no endpoint is connected. */
	baseUrl: string | null;
	/** null: custom is chosen but no model is picked. */
	model: string | null;
}

function audioConnection(custom: boolean, endpoint: CustomProviderSettings | undefined, customModel: string | undefined, defaultModel: string): AudioConnection {
	if (!custom) return { custom: false, baseUrl: OPENAI_AUDIO_BASE_URL, model: defaultModel };
	return { custom: true, baseUrl: endpoint?.baseUrl ?? null, model: customModel ?? null };
}

export const ttsConnection = (provider: "openai" | "custom" | undefined, endpoint: CustomProviderSettings | undefined, customModel: string | undefined) =>
	audioConnection(provider === "custom", endpoint, customModel, DEFAULT_TTS_MODEL);
export const dictationConnection = (provider: string | undefined, endpoint: CustomProviderSettings | undefined, customModel: string | undefined) =>
	audioConnection(provider === "custom", endpoint, customModel, DEFAULT_DICTATION_MODEL);
