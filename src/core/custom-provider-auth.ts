/** Private custom credential authorization; no credential-derived public value. */
import { normalizeBaseUrl, type CustomProviderSettings } from "./settings.ts";
import { CUSTOM_PROVIDER } from "./auth-keys.ts";
import { CUSTOM_TTS_KEY_ID } from "./audio-connection.ts";

export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";

/** One custom OpenAI-compatible endpoint: chat (the pi-ai provider), TTS. Each is a singleton with its own settings entry, its own key
 *  (auth.json entry + env var), and its own binding of that key to its URL. */
export interface CustomEndpointKind {
	/** Top-level settings key — never a PUT section. */
	settingsKey: "customProvider" | "customTtsProvider";
	envVar: string;
	/** The reserved auth.json entry binding the key to the endpoint. */
	binding: string;
}
export const CHAT_ENDPOINT: CustomEndpointKind = { settingsKey: "customProvider", envVar: CUSTOM_PROVIDER.envVar, binding: CUSTOM_AUTH_BINDING };
export const TTS_ENDPOINT: CustomEndpointKind = { settingsKey: "customTtsProvider", envVar: CUSTOM_TTS_KEY_ID, binding: "__learnharness_custom_tts_binding" };
export const CUSTOM_ENDPOINTS: readonly CustomEndpointKind[] = [CHAT_ENDPOINT, TTS_ENDPOINT];
/** A reserved binding entry: never a key, never shown or hand-edited. */
export const isCustomBindingName = (name: string) => CUSTOM_ENDPOINTS.some((k) => k.binding === name);
/** A custom endpoint's key: written only through its endpoint editor. */
export const isCustomKeyName = (name: string) => CUSTOM_ENDPOINTS.some((k) => k.envVar === name);
export interface CustomAuthBinding {
	version: 1;
	id: string;
	baseUrl?: string;
	authMode: "apiKey" | "keyless" | "disabled";
	/** A shadowed file key keeps its own destination when an env key moves. */
	fileKeyBaseUrl?: string;
}
export function parseCustomAuthBinding(value: unknown): CustomAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? JSON.parse(value) : undefined;
		if (!b || b.version !== 1 || typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) return;
		if (!["apiKey", "keyless", "disabled"].includes(b.authMode)) return;
		if (b.authMode !== "disabled" && b.baseUrl === undefined) return;
		if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl)) return;
		if (b.fileKeyBaseUrl !== undefined && (typeof b.fileKeyBaseUrl !== "string" || !b.fileKeyBaseUrl || normalizeBaseUrl(b.fileKeyBaseUrl) !== b.fileKeyBaseUrl)) return;
		return { version: 1, id: b.id, authMode: b.authMode, ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}), ...(b.fileKeyBaseUrl !== undefined ? { fileKeyBaseUrl: b.fileKeyBaseUrl } : {}) };
	} catch { return; }
}
export function customBindingMatches(cp: CustomProviderSettings | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(cp?.baseUrl && binding && binding.authMode !== "disabled" && cp.credentialBindingId === binding.id && cp.baseUrl === binding.baseUrl && cp.authMode === binding.authMode);
}
