import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);
const { createRemoteAccess } = require("../electron/remote-access.cjs");
const { createTailscaleServe } = require("../electron/tailscale-serve.cjs");
const origin = "https://learn.test.ts.net:8443";
const capability = "a".repeat(64);

async function fixture(t: TestContext, storage = fs) {
	const directory = mkdtempSync(join(tmpdir(), "lh-remote-"));
	const received: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const backend = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		received.push({ url: req.url, headers: req.headers, body });
		if (req.url === "/api/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: ready\n\n");
		} else res.end("same desktop backend");
	});
	backend.listen(0, "127.0.0.1");
	await once(backend, "listening");
	let target = "", stopped = 0;
	let time = Date.now();
	const statePath = join(directory, "remote-access.json");
	const tailscale = { start: async (url: string) => { target = url; return origin; }, stop: async () => { stopped++; } };
	const create = () => createRemoteAccess({ upstream: `http://127.0.0.1:${(backend.address() as import("node:net").AddressInfo).port}`, desktopSecret: capability, statePath, tailscale, now: () => time, storage });
	const remote = create();
	t.after(async () => {
		await remote.shutdown();
		backend.closeAllConnections();
		await new Promise<void>((resolve) => backend.close(() => resolve()));
		rmSync(directory, { recursive: true, force: true });
	});
	async function request(path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
		return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
			const req = http.request(new URL(path, target), {
				method: options.method ?? "GET",
				headers: { host: new URL(origin).host, "x-forwarded-proto": "https", ...options.headers },
			}, (res) => {
				let body = "";
				res.on("data", (chunk) => body += chunk);
				res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
			});
			req.on("error", reject);
			req.end(options.body);
		});
	}
	async function pair() {
		const link = await remote.control({ op: "pair" });
		const grant = new URLSearchParams(new URL(link.pairingUrl).hash.slice(1)).get("grant");
		const response = await request("/_lh/remote/pair", { method: "POST", headers: { origin, "content-type": "application/json", "user-agent": "iPhone" }, body: JSON.stringify({ grant }) });
		assert.equal(response.status, 200);
		const token = JSON.parse(response.body).token as string;
		return { token, grant, response };
	}
	return { remote, create, request, pair, received, statePath, backend, target: () => target, advance: (ms: number) => { time += ms; }, stopped: () => stopped };
}

test("remote ingress is opt-in, protects pages and APIs, and rejects untrusted origins", async (t) => {
	const f = await fixture(t);
	assert.equal(f.remote.status().enabled, false);
	assert.equal((await f.remote.control({ op: "pair" })).pairingUrl, undefined);
	assert.equal((await f.remote.control({ op: "enable" })).enabled, true);
	assert.match((await f.request("/")).body, /Connect this device/);
	assert.equal((await f.request("/api/chats")).status, 401);
	assert.equal((await f.request("/", { headers: { host: "evil.invalid" } })).status, 403);
	assert.equal((await f.request("/", { headers: { "x-forwarded-proto": "http" } })).status, 403);
	assert.equal((await f.request("/_lh/remote/pair", { method: "POST", headers: { origin: "https://evil.invalid" } })).status, 403);
	assert.equal(f.received.length, 0);
});

test("pairing is single-use, credentials are origin-bound, and proxy forwards to the same backend with server-only capability", async (t) => {
	const f = await fixture(t);
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	assert.equal(paired.response.headers["set-cookie"], undefined);
	const stored = readFileSync(f.statePath, "utf8");
	assert.equal(stored.includes(paired.token), false);
	assert.equal(stored.includes(paired.grant!), false);
	assert.equal(stored.includes(capability), false);
	assert.equal(JSON.stringify(f.remote.status()).includes('"hash"'), false);
	const replay = await f.request("/_lh/remote/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ grant: paired.grant }) });
	assert.equal(replay.status, 401);
	const response = await f.request("/api/chat?resume=1", { method: "POST", headers: { origin, "x-learnharness-remote": paired.token, "x-learnharness-desktop": "forged", "x-forwarded-host": "evil.invalid", "content-type": "application/json" }, body: '{"prompt":"test"}' });
	assert.equal(response.body, "same desktop backend");
	assert.equal(response.headers["cache-control"], "no-store");
	assert.equal(f.received[0]!.headers["x-learnharness-desktop"], capability);
	assert.equal(f.received[0]!.headers.cookie, undefined);
	assert.equal(f.received[0]!.headers["x-learnharness-remote"], undefined);
	assert.equal(f.received[0]!.headers["x-forwarded-host"], new URL(origin).host);
	assert.equal(f.received[0]!.url, "/api/chat?resume=1");
	assert.equal(f.received[0]!.body, '{"prompt":"test"}');
	await f.request("/chat/new", { headers: { "x-learnharness-remote": paired.token, "x-learnharness-desktop": "forged" } });
	assert.equal(f.received[1]!.headers["x-learnharness-desktop"], undefined);
	assert.equal((await f.request("/api/chat", { method: "POST", headers: { "x-learnharness-remote": paired.token } })).status, 403);
	assert.equal((await f.request("/_lh/remote/enable", { method: "POST", headers: { origin, "x-learnharness-remote": paired.token } })).status, 404);
});

test("revocation survives failed configuration writes and restart; cleanup still runs when disable cannot save", async (t) => {
	let failing = false;
	const f = await fixture(t, { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
		if (failing) throw new Error("storage unavailable");
		return fs.renameSync(...args);
	} });
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	failing = true;
	const revoked = await f.remote.control({ op: "revoke", id: f.remote.status().devices[0].id });
	assert.equal(revoked.enabled, false);
	assert(revoked.error);
	assert(f.stopped() >= 1);
	failing = false;
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.control({ op: "enable" });
	assert.equal(restarted.status().devices.length, 0);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
	failing = true;
	const stoppedBeforeDisable = f.stopped();
	const disabled = await restarted.control({ op: "disable" });
	assert.equal(disabled.enabled, false);
	assert(disabled.error);
	assert(f.stopped() > stoppedBeforeDisable);
});

test("expired and replaced pairing links fail, and sessions expire", async (t) => {
	const f = await fixture(t);
	await f.remote.control({ op: "enable" });
	const expired = await f.remote.control({ op: "pair" });
	f.advance(5 * 60_000 + 1);
	const grant = new URLSearchParams(new URL(expired.pairingUrl).hash.slice(1)).get("grant");
	assert.equal((await f.request("/_lh/remote/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ grant }) })).status, 401);
	const old = await f.remote.control({ op: "pair" });
	const paired = await f.pair();
	const oldGrant = new URLSearchParams(new URL(old.pairingUrl).hash.slice(1)).get("grant");
	assert.equal((await f.request("/_lh/remote/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ grant: oldGrant }) })).status, 401);
	f.advance(30 * 24 * 60 * 60_000 + 1);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
	await f.remote.shutdown();
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.restore();
	assert.equal(restarted.status().devices.length, 0);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
});

test("paired devices survive desktop restart and durable revocation survives another restart", async (t) => {
	const f = await fixture(t);
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	const id = f.remote.status().devices[0].id;
	await f.remote.shutdown();
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.restore();
	assert.equal(restarted.status().devices.length, 1, "paired device should be remembered after restart");
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 200);
	await restarted.control({ op: "revoke", id });
	await restarted.shutdown();
	const again = f.create();
	t.after(() => again.shutdown());
	await again.restore();
	assert.equal(again.status().devices.length, 0);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
});

test("pairing is not acknowledged when its durable commit fails", async (t) => {
	let failing = false;
	const f = await fixture(t, { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
		if (failing) throw new Error("disk full");
		return fs.renameSync(...args);
	} });
	await f.remote.control({ op: "enable" });
	failing = true;
	await assert.rejects(() => f.pair());
	assert.equal(f.remote.status().devices.length, 0);
	assert.equal(f.remote.status().enabled, false);
	failing = false;
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.control({ op: "enable" });
	assert.equal(restarted.status().devices.length, 0);
});

test("revocation invalidates saved grants even when atomic rename and unlink are unavailable", async (t) => {
	let failing = false;
	const f = await fixture(t, { ...fs,
		renameSync: (...args: Parameters<typeof fs.renameSync>) => { if (failing) throw new Error("rename unavailable"); return fs.renameSync(...args); },
		unlinkSync: (file: fs.PathLike) => {
			if (failing && String(file).endsWith("remote-access.json")) throw Object.assign(new Error("unlink unavailable"), { code: "EACCES" });
			return fs.unlinkSync(file);
		},
	});
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	failing = true;
	const result = await f.remote.control({ op: "revoke", id: f.remote.status().devices[0].id });
	assert.equal(result.enabled, false);
	assert(result.error);
	failing = false;
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.control({ op: "enable" });
	assert.equal(restarted.status().devices.length, 0);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
});

test("failed invalidation reports that revocation could not be saved", async (t) => {
	let failing = false;
	const f = await fixture(t, { ...fs,
		renameSync: (...args: Parameters<typeof fs.renameSync>) => { if (failing) throw new Error("rename unavailable"); return fs.renameSync(...args); },
		unlinkSync: (file: fs.PathLike) => {
			if (failing && String(file).endsWith("remote-access.json")) throw Object.assign(new Error("unlink unavailable"), { code: "EACCES" });
			return fs.unlinkSync(file);
		},
		openSync: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			if (failing && flags === "w") throw new Error("file is read-only");
			return fs.openSync(file, flags, mode);
		}) as typeof fs.openSync,
	});
	await f.remote.control({ op: "enable" });
	await f.pair();
	failing = true;
	const result = await f.remote.control({ op: "revoke", id: f.remote.status().devices[0].id });
	assert.equal(result.enabled, false);
	assert.match(result.error, /revocation could not be saved/);
	assert.match(result.error, /may reconnect after restart/);
	assert.equal(JSON.parse(readFileSync(f.statePath, "utf8")).devices.length, 1);
});

test("emergency unlink flushes the parent directory and reports a failed flush", async (t) => {
	let failing = false, deleted = false, flushAfterDeletion = false;
	const directories = new Set<number>();
	const f = await fixture(t, { ...fs,
		openSync: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			const fd = fs.openSync(file, flags, mode);
			if (fs.fstatSync(fd).isDirectory()) directories.add(fd); else directories.delete(fd);
			return fd;
		}) as typeof fs.openSync,
		fsyncSync: (fd: number) => {
			if (failing && directories.has(fd)) {
				if (deleted) flushAfterDeletion = true;
				throw new Error("directory flush failed");
			}
			return fs.fsyncSync(fd);
		},
		unlinkSync: (file: fs.PathLike) => {
			fs.unlinkSync(file);
			if (String(file).endsWith("remote-access.json")) deleted = true;
		},
	});
	await f.remote.control({ op: "enable" });
	await f.pair();
	failing = true;
	const result = await f.remote.control({ op: "revoke", id: f.remote.status().devices[0].id });
	assert.equal(result.enabled, false);
	assert.equal(flushAfterDeletion, true);
	assert.match(result.error, /revocation could not be saved/);
});

test("browser logout remains revoked after desktop restart", async (t) => {
	const f = await fixture(t);
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	assert.equal((await f.request("/_lh/remote/logout", { method: "POST", headers: { origin, "x-learnharness-remote": paired.token } })).status, 200);
	await f.remote.shutdown();
	const restarted = f.create();
	t.after(() => restarted.shutdown());
	await restarted.restore();
	assert.equal(restarted.status().devices.length, 0);
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
});

test("revocation terminates active SSE and denies subsequent requests; disabling clears devices", async (t) => {
	const f = await fixture(t);
	await f.remote.control({ op: "enable" });
	const paired = await f.pair();
	const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
		const req = http.get(new URL("/api/events", f.target()), { headers: { host: new URL(origin).host, "x-forwarded-proto": "https", "x-learnharness-remote": paired.token } }, resolve);
		req.on("error", reject);
	});
	stream.on("error", () => {});
	const first = await once(stream, "data");
	assert.match(first[0].toString(), /data: ready/);
	const closed = new Promise<void>((resolve) => stream.once("close", resolve));
	await f.remote.control({ op: "revoke", id: f.remote.status().devices[0].id });
	await closed;
	assert.equal((await f.request("/api/chats", { headers: { "x-learnharness-remote": paired.token } })).status, 401);
	await f.pair();
	const disabled = await f.remote.control({ op: "disable" });
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.devices.length, 0);
	assert.equal(f.stopped(), 1);
});

test("Tailscale Serve preserves other services and refuses public Funnel", async () => {
	for (const config of [
		{ TCP: { "8443": { HTTPS: true } }, Web: { "learn.test.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } },
		{ AllowFunnel: { "learn.test.ts.net:8443": true } },
	]) {
		const calls: string[][] = [];
		const tailscale = createTailscaleServe({ run: async (args: string[]) => {
			calls.push(args);
			return JSON.stringify(args[0] === "status" ? { BackendState: "Running", Self: { DNSName: "learn.test.ts.net." } } : config);
		} });
		await assert.rejects(() => tailscale.start("http://127.0.0.1:4321"));
		assert.equal(calls.some((args) => args.includes("--bg")), false);
	}
	const calls: string[][] = [];
	let config = {};
	const tailscale = createTailscaleServe({ run: async (args: string[]) => {
		calls.push(args);
		if (args.includes("--bg")) config = { Web: { "learn.test.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4321" } } } } };
		return JSON.stringify(args[0] === "status" ? { BackendState: "Running", Self: { DNSName: "learn.test.ts.net." } } : config);
	} });
	assert.equal(await tailscale.start("http://127.0.0.1:4321"), origin);
	// A different app can add a route after startup. Remove only our root.
	(config as any).Web["learn.test.ts.net:8443"].Handlers["/other-app"] = { Proxy: "http://127.0.0.1:9999" };
	await tailscale.stop();
	assert.deepEqual(calls.at(-1), ["serve", "--https=8443", "--set-path=/", "off"]);
});
