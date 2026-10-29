/** Custom-only credential composition. File credentials and their authorization
 * are read from the same atomic record, never a stale fill-gapped env copy. */
import { authEnvRecord } from "../core/auth-env.ts";
import { CHAT_ENDPOINT, customBindingMatches, type CustomAuthBinding, type CustomEndpointKind } from "../core/custom-provider-auth.ts";
import type { CustomProviderSettings } from "../core/settings.ts";
import { readCustomAuth, writeCustomAuth } from "../store/auth.ts";

export interface CustomAuthState {
	readable: boolean;
	binding?: CustomAuthBinding;
	key?: string;
	fileKey?: string;
	source: "env" | "file" | "none";
}
/** requiredConfig prevents even credential resolution until startup/runtime
 * authorization matches. Explicit UI inspection/probe authorization omits it. */
export function customAuthState(inspectKey = false, requiredConfig?: CustomProviderSettings, kind: CustomEndpointKind = CHAT_ENDPOINT): CustomAuthState {
	try {
		const snapshot = readCustomAuth(kind);
		const result: CustomAuthState = { readable: true, binding: snapshot.binding, source: "none" };
		if (!inspectKey || (requiredConfig && !customBindingMatches(requiredConfig, snapshot.binding))) return result;
		result.fileKey = snapshot.fileKey();
		const record = authEnvRecord();
		const envKey = process.env.LH_IGNORE_ENV_KEYS !== "1" && record.realEnv.has(kind.envVar) ? process.env[kind.envVar] : undefined;
		result.source = envKey !== undefined ? "env" : result.fileKey !== undefined ? "file" : "none";
		result.key = (envKey ?? result.fileKey)?.trim() || undefined;
		return result;
	} catch { return { readable: false, source: "none" }; }
}
export function customKeyAuthorized(cp: CustomProviderSettings | undefined, state: CustomAuthState): boolean {
	return cp?.authMode === "apiKey" && state.readable && customBindingMatches(cp, state.binding) && Boolean(state.key) && (state.source === "env" || state.binding?.fileKeyBaseUrl === cp?.baseUrl);
}
/** Reflect only after the atomic pair is committed. Runtime file resolution
 * does not rely on this compatibility mirror, including after a failed write. */
export function persistCustomAuth(binding: CustomAuthBinding | undefined, fileKey: string | undefined, kind: CustomEndpointKind = CHAT_ENDPOINT): void {
	writeCustomAuth(binding, fileKey, kind);
	const record = authEnvRecord();
	if (!record.realEnv.has(kind.envVar)) {
		if (fileKey === undefined) { delete process.env[kind.envVar]; record.fillGap.delete(kind.envVar); }
		else { process.env[kind.envVar] = fileKey; record.fillGap.add(kind.envVar); }
	}
}

/** The credential an audio endpoint may use for one request: the same gate
 *  the chat provider's publication applies — a configured URL, a matching
 *  durable binding, and for API-key mode a key authorized for that URL.
 *  Keyless never resolves a stored or environment key. */
export function customEndpointCredential(kind: CustomEndpointKind, cp: CustomProviderSettings | undefined): { ok: true; apiKey?: string } | { ok: false } {
	if (!cp?.baseUrl) return { ok: false };
	const auth = customAuthState(cp.authMode === "apiKey", cp, kind);
	if (!auth.readable || !customBindingMatches(cp, auth.binding)) return { ok: false };
	if (cp.authMode === "keyless") return { ok: true };
	return customKeyAuthorized(cp, auth) ? { ok: true, apiKey: auth.key } : { ok: false };
}
