/** Synthetic authorized records, imported only after each test's isolated env. */
import { randomBytes } from "node:crypto";
import type { CustomProviderSettings } from "../../src/core/settings.ts";
import type { CustomEndpointKind } from "../../src/core/custom-provider-auth.ts";
import { persistCustomAuth } from "../../src/server/custom-provider-auth.ts";

/** `kind` defaults to the chat endpoint; TTS passes its own. */
export function authorizeFixture(cp: CustomProviderSettings, fileKey?: string, kind?: CustomEndpointKind): CustomProviderSettings {
	const id = randomBytes(16).toString("hex");
	persistCustomAuth({ version: 1, id, baseUrl: cp.baseUrl, authMode: cp.authMode ?? "keyless", ...(fileKey ? { fileKeyBaseUrl: cp.baseUrl } : {}) }, fileKey, kind);
	return { ...cp, credentialBindingId: id };
}
