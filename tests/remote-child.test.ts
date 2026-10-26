import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { isDirectDesktopCall } from "../src/server/remote-admin.ts";

const require = createRequire(import.meta.url);
const { attachRemoteChild } = require("../electron/remote-child.cjs");

const ENV: { LH_DESKTOP_SERVER: string; LH_DESKTOP_API_SECRET: string } = { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "a".repeat(64) };
const headers = (extra: Record<string, string> = {}) =>
	new Headers({ "x-learnharness-desktop": ENV.LH_DESKTOP_API_SECRET, ...extra });

class FakeChild extends EventEmitter {
	connected = true;
	sent: unknown[] = [];
	send(value: unknown, done?: (error?: Error) => void) {
		this.sent.push(value);
		done?.();
	}
	request(message: unknown) {
		this.emit("message", message);
	}
}

describe("laptop-local pairing relay", () => {
	it("relays pair mints and nothing else, with malformed callers ignored", async () => {
		const calls: unknown[] = [];
		const child = new FakeChild();
		const remoteAccess = { control: async (command: unknown) => ({ ...(command as object), pairingUrl: "https://phone.test/x#grant=g" }) };
		const relay = attachRemoteChild(child, remoteAccess);
		child.request({ channel: "lh:remote-admin", id: "a", op: "pair" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(child.sent.length, 1);
		const reply = child.sent[0] as Record<string, unknown>;
		assert.equal(reply.ok, true);
		assert.equal((reply.value as Record<string, unknown>).pairingUrl, "https://phone.test/x#grant=g");
		child.request({ channel: "lh:remote-admin", id: "b", op: "status" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((child.sent[1] as Record<string, unknown>).ok, false);
		const before = child.sent.length;
		child.request({ channel: "lh:remote-admin", op: "pair" });
		child.request({ channel: "other", id: "c", op: "pair" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(child.sent.length, before, "id-less and foreign channels are ignored");
		assert.deepEqual(calls, []);
		relay.dispose();
		child.request({ channel: "lh:remote-admin", id: "d", op: "pair" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(child.sent.length, before, "disposed relay stops handling");
	});
});

describe("laptop-local mint guard", () => {
	it("allows direct loopback callers and refuses everyone else", () => {
		assert.equal(isDirectDesktopCall(headers(), ENV), true);
		assert.equal(isDirectDesktopCall(new Headers(), ENV), false, "no capability");
		assert.equal(
			isDirectDesktopCall(headers({ "x-forwarded-host": "learn.test.ts.net:8443" }), ENV),
			false,
			"gateway-proxied callers (paired phones) can never mint",
		);
		assert.equal(
			isDirectDesktopCall(headers({ forwarded: "for=10.0.0.1" }), ENV),
			false,
			"forwarded callers can never mint",
		);
		assert.equal(
			isDirectDesktopCall(new Headers({ "x-learnharness-desktop": "wrong" }), ENV),
			false,
			"wrong secret",
		);
	});
});
