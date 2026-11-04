import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { callbackTarget, createHeadlessChatGPT } = require("../scripts/headless-chatgpt.cjs");
const redirect = "http://127.0.0.1:34567/auth/callback";
const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
authorize.search = new URLSearchParams({ redirect_uri: redirect, state: "pending-test-state" }).toString();
const callback = `${redirect}?state=pending-test-state&code=synthetic-code&client_id=oaiapp_synthetic`;

test("manual callbacks are pinned to the exact pending loopback address and state", () => {
	assert.equal(callbackTarget(authorize, callback).toString(), callback);
	for (const value of [
		callback.replace("127.0.0.1", "localhost"),
		callback.replace("127.0.0.1", "10.0.0.1"),
		callback.replace(":34567", ":34568"),
		callback.replace("http:", "https:"),
		callback.replace("/auth/callback", "/other"),
		callback.replace("pending-test-state", "other-state"),
		callback + "&code=second-code",
		callback + "&state=second-state",
		callback + "&client_id=other-client",
		callback + "#fragment",
		callback.replace("127.0.0.1", "user:password@127.0.0.1"),
	]) assert.throws(() => callbackTarget(authorize, value));
});

test("manual handoff is one-use and leaves verification and storage in the existing OAuth owner", async () => {
	let pending = false, submissions = 0, closed = false;
	let ownerOptions: { openExternal: (value: string) => Promise<void>; timeoutMs: number };
	const facade = createHeadlessChatGPT({
		directory: "/unused-test-directory",
		factory: (options: typeof ownerOptions) => {
			ownerOptions = options;
			return {
				status: async () => ({ available: true, pending, allowBackgroundUse: true, accounts: [] }),
				login: async () => { pending = true; await options.openExternal(authorize.toString()); return { pending }; },
				cancelLogin: () => { pending = false; return { pending }; },
				close: () => { closed = true; },
			};
		},
		submit: async (target: URL, options: { redirect: string }) => {
			submissions++;
			assert.equal(target.toString(), callback);
			assert.equal(options.redirect, "error");
			pending = false;
			return new Response("Return to LearnHarness.");
		},
	});
	await assert.rejects(facade.complete(callback), /No ChatGPT sign-in/);
	const start = await facade.login();
	assert.equal(start.authorizationUrl, authorize.toString());
	assert.equal(ownerOptions!.timeoutMs, 600000);
	await assert.rejects(facade.login(), /already pending/);
	await assert.rejects(facade.complete(callback.replace("127.0.0.1", "10.0.0.1")), /loopback/);
	assert.equal(submissions, 0);
	assert.equal((await facade.complete(callback)).pending, false);
	assert.equal(submissions, 1);
	await assert.rejects(facade.complete(callback), /No ChatGPT sign-in/);
	await facade.login();
	facade.cancel();
	await assert.rejects(facade.complete(callback), /No ChatGPT sign-in/);
	facade.connection.close();
	assert.equal(closed, true);
});
