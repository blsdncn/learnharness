import { Agent, fetch as socketFetch } from "undici";
import { normalizeBaseUrl, normalizeSocketPath } from "../core/settings.ts";

/** The SDK's finite JSON request must have a known byte length. A stream body
 * makes Undici use chunked encoding, which some socket gateways cannot decode.
 * Abort also cancels a stalled input stream before any connection is opened. */
async function bufferRequestBody(request: Request): Promise<Buffer | undefined> {
	if (!request.body) { request.signal.throwIfAborted(); return undefined; }
	const reader = request.body.getReader();
	const abort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		if (request.signal.aborted) { abort(); request.signal.throwIfAborted(); }
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (;;) {
			const { done, value } = await reader.read();
			request.signal.throwIfAborted();
			if (done) break;
			chunks.push(value); length += value.byteLength;
		}
		return Buffer.concat(chunks, length);
	} finally {
		request.signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

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
		const body = await bufferRequestBody(request);
		request.signal.throwIfAborted();
		const headers = new Headers(request.headers);
		headers.delete("transfer-encoding");
		headers.delete("content-length");
		if (body !== undefined) headers.set("content-length", String(body.byteLength));
		const dispatcher = new Agent({ connect: { socketPath } });
		try {
			// Next's global fetch wrapper can discard the dispatcher. Use Undici
			// directly, passing scalar headers/body rather than a foreign Request.
			// Its standard Response interface is consumed by the existing SDK.
			return await socketFetch(request.url, {
				method: request.method, headers: Array.from(headers), body,
				signal: request.signal, dispatcher, redirect: "manual",
			}) as unknown as Response;
		} finally {
			// Do not await here: callers must be able to consume/cancel the body.
			void dispatcher.close().catch(() => dispatcher.destroy());
		}
	};
}
