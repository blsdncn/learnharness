/** Synthetic authorized records, imported only after each test's isolated env. */
import { randomBytes } from "node:crypto";
import type { CustomProviderSettings } from "../../src/core/settings.ts";
import { persistCustomAuth } from "../../src/server/custom-provider-auth.ts";

export function authorizeFixture(cp: CustomProviderSettings, fileKey?: string): CustomProviderSettings {
	const id = randomBytes(16).toString("hex");
	persistCustomAuth({ version: cp.api === "openai-responses" ? 3 : cp.socketPath === undefined ? 1 : 2, ...(cp.api === "openai-responses" ? { api: cp.api } : {}), id, baseUrl: cp.baseUrl, ...(cp.socketPath === undefined ? {} : { socketPath: cp.socketPath }), authMode: cp.authMode ?? "keyless", ...(fileKey ? { fileKeyBaseUrl: cp.baseUrl, ...(cp.socketPath === undefined ? {} : { fileKeySocketPath: cp.socketPath }) } : {}) }, fileKey);
	return { ...cp, credentialBindingId: id };
}
