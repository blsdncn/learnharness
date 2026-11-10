import { Agent, fetch as socketFetch, type RequestInit as UndiciRequestInit } from "undici";
import { normalizeBaseUrl, normalizeSocketPath } from "../core/settings.ts";

/** Request-scoped dispatcher: no process-wide fetch mutation or idle pools
 * after a provider is replaced. close() waits for the streaming body to end. */
export function unixSocketFetch(socketPath: string, baseUrl: string): typeof fetch {
	if (process.platform === "win32") throw new Error("Unix socket endpoints require Linux or macOS.");
	if (!normalizeSocketPath(socketPath)) throw new Error("Unix socket path must be an absolute filesystem path.");
	const base = normalizeBaseUrl(baseUrl);
	if (!base || !base.startsWith("http:")) throw new Error("Unix socket endpoints require an http:// base URL.");
	const origin = new URL(base).origin;
	return async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== origin) throw new Error("Unix socket request does not match the configured endpoint.");
		const dispatcher = new Agent({ connect: { socketPath } });
		try {
			// Next's global fetch wrapper can discard the dispatcher. Use Undici
			// directly, passing scalar headers/body rather than a foreign Request.
			// Its standard Response interface is consumed by the existing SDK.
			return await socketFetch(request.url, {
				method: request.method, headers: Array.from(request.headers),
				body: request.body as UndiciRequestInit["body"], duplex: "half",
				signal: request.signal, dispatcher, redirect: "manual",
			}) as unknown as Response;
		} finally {
			// Do not await here: callers must be able to consume/cancel the body.
			void dispatcher.close().catch(() => dispatcher.destroy());
		}
	};
}
