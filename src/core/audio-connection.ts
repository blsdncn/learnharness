/**
 * Where a TTS request goes: OpenAI's fixed base and model with its provider
 * key, or the independent custom endpoint and its selected model. Custom
 * credentials stay bound to the endpoint's URL; the OpenAI key is never
 * sent to a custom server. Browser-safe.
 */

import type { CustomProviderSettings } from "./settings.ts";

export const OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_AUDIO_KEY_ID = "OPENAI_API_KEY";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
/** The TTS custom endpoint's key (auth.json entry and env var), parallel
 *  to the chat endpoint's CUSTOM_OPENAI_API_KEY. */
export const CUSTOM_TTS_KEY_ID = "CUSTOM_TTS_API_KEY";

/** The request path under the base URL, shown live in the endpoint's form. */
export const TTS_PATH = "/audio/speech";

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
