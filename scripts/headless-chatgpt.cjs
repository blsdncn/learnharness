"use strict";

const path = require("node:path");
const { createChatGPT, fileStore } = require("../electron/chatgpt.cjs");

function callbackTarget(authorize, value) {
	let url;
	try { url = new URL(value); } catch { throw new Error("Invalid callback URL."); }
	const expected = new URL(authorize.searchParams.get("redirect_uri"));
	if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || !expected.port || expected.pathname !== "/auth/callback" ||
		url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash || value.length > 8192)
		throw new Error("Callback must match this pending sign-in's loopback address.");
	for (const key of ["state", "code", "client_id", "error"]) if (url.searchParams.getAll(key).length > 1) throw new Error("Ambiguous callback parameters.");
	if (url.searchParams.get("state") !== authorize.searchParams.get("state") || !(url.searchParams.get("code") || url.searchParams.get("error")))
		throw new Error("Callback does not match the pending sign-in.");
	return url;
}

function createHeadlessChatGPT({ directory, onChange, factory = createChatGPT, submit = fetch }) {
	let authorization;
	const connection = factory({
		store: fileStore(path.join(directory, "chatgpt-credentials.json")),
		timeoutMs: 10 * 60_000,
		onChange,
		openExternal: async (value) => {
			const url = new URL(value);
			if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.username || url.password || url.hash)
				throw new Error("Invalid ChatGPT authorization endpoint.");
			authorization = url;
		},
	});
	return {
		connection,
		async login(id) {
			if ((await connection.status()).pending) throw new Error("A ChatGPT sign-in is already pending.");
			authorization = undefined;
			const status = await connection.login(id);
			return { ...status, ...(status.pending && authorization ? { authorizationUrl: authorization.toString() } : {}) };
		},
		async complete(value) {
			if (!authorization || !(await connection.status()).pending) throw new Error("No ChatGPT sign-in is pending. Start a new sign-in.");
			const target = callbackTarget(authorization, value);
			authorization = undefined;
			// Forward only to the exact loopback listener owned by this attempt.
			// The existing OAuth owner still performs state, PKCE, ID-token,
			// identity and scope validation before it persists any credentials.
			const response = await submit(target, { redirect: "error", signal: AbortSignal.timeout(15_000) });
			await response.body?.cancel();
			if (!response.ok) throw new Error("The pending callback could not be accepted. Start a new sign-in.");
			const deadline = Date.now() + 35_000;
			while (Date.now() < deadline) {
				const status = await connection.status();
				if (!status.pending) return status;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			return connection.status();
		},
		cancel() { authorization = undefined; return connection.cancelLogin(); },
	};
}

module.exports = { createHeadlessChatGPT, callbackTarget };
