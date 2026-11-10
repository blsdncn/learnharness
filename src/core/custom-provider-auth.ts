/** Private custom credential authorization; no credential-derived public value. */
import { normalizeBaseUrl, normalizeSocketPath, type CustomProviderSettings } from "./settings.ts";

export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";
export interface CustomAuthBinding {
	/** Socket-aware bindings use v2 so older builds cannot reinterpret them as TCP. */
	version: 1 | 2 | 3;
	/** Responses bindings use v3 so older builds cannot switch protocols. */
	api?: "openai-responses";
	id: string;
	baseUrl?: string;
	socketPath?: string;
	authMode: "apiKey" | "keyless" | "disabled";
	/** A shadowed file key keeps its own destination when an env key moves. */
	fileKeyBaseUrl?: string;
	fileKeySocketPath?: string;
}
export function parseCustomAuthBinding(value: unknown): CustomAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? JSON.parse(value) : undefined;
		if (!b || ![1, 2, 3].includes(b.version) || typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) return;
		if (b.version === 3 ? b.api !== "openai-responses" : b.api !== undefined) return;
		if (!["apiKey", "keyless", "disabled"].includes(b.authMode)) return;
		if (b.authMode !== "disabled" && b.baseUrl === undefined) return;
		if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl)) return;
		if (b.fileKeyBaseUrl !== undefined && (typeof b.fileKeyBaseUrl !== "string" || !b.fileKeyBaseUrl || normalizeBaseUrl(b.fileKeyBaseUrl) !== b.fileKeyBaseUrl)) return;
		for (const field of ["socketPath", "fileKeySocketPath"] as const) {
			if (b[field] !== undefined && (b.version < 2 || !normalizeSocketPath(b[field]) || !String(b[field === "socketPath" ? "baseUrl" : "fileKeyBaseUrl"]).startsWith("http:"))) return;
		}
		return { version: b.version, ...(b.api === "openai-responses" ? { api: b.api } : {}), id: b.id, authMode: b.authMode, ...(b.socketPath !== undefined ? { socketPath: b.socketPath } : {}), ...(b.fileKeySocketPath !== undefined ? { fileKeySocketPath: b.fileKeySocketPath } : {}), ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}), ...(b.fileKeyBaseUrl !== undefined ? { fileKeyBaseUrl: b.fileKeyBaseUrl } : {}) };
	} catch { return; }
}
export function customBindingMatches(cp: CustomProviderSettings | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(cp?.baseUrl && binding && binding.authMode !== "disabled" && cp.credentialBindingId === binding.id && cp.baseUrl === binding.baseUrl && (cp.api ?? "openai-completions") === (binding.api ?? "openai-completions") && cp.socketPath === binding.socketPath && cp.authMode === binding.authMode);
}
