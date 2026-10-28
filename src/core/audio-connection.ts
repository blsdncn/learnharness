/**
 * Where an audio request goes (TTS, OpenAI dictation). By default: OpenAI
 * at a fixed model, with the OpenAI key from Providers. With the custom
 * endpoint on: the section's saved server and model, with that section's
 * own key (TTS_API_KEY / STT_API_KEY; none saved = no auth). The OpenAI
 * key is never sent to a custom server. Browser-safe.
 */

export const OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_AUDIO_KEY_ID = "OPENAI_API_KEY";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_DICTATION_MODEL = "gpt-transcribe";
export const TTS_KEY_ID = "TTS_API_KEY";
export const STT_KEY_ID = "STT_API_KEY";

/** The stored endpoint fields both sections share. Server and model are
 *  kept while the custom endpoint is off, so it can be switched back on. */
export interface AudioEndpointSettings {
	customEndpoint?: boolean;
	/** API root including the version segment, e.g. http://127.0.0.1:47616/v1. */
	baseUrl?: string;
	model?: string;
}

export interface AudioConnection {
	custom: boolean;
	/** null: the custom endpoint is on but no server is saved. */
	baseUrl: string | null;
	model: string;
	/** The stored key this connection reads. */
	keyId: string;
}

function audioConnection(settings: AudioEndpointSettings | undefined, defaultModel: string, customKeyId: string): AudioConnection {
	if (!settings?.customEndpoint) return { custom: false, baseUrl: OPENAI_AUDIO_BASE_URL, model: defaultModel, keyId: OPENAI_AUDIO_KEY_ID };
	return { custom: true, baseUrl: settings.baseUrl ?? null, model: settings.model ?? defaultModel, keyId: customKeyId };
}

export const ttsConnection = (settings: AudioEndpointSettings | undefined) => audioConnection(settings, DEFAULT_TTS_MODEL, TTS_KEY_ID);
export const dictationConnection = (settings: AudioEndpointSettings | undefined) => audioConnection(settings, DEFAULT_DICTATION_MODEL, STT_KEY_ID);
