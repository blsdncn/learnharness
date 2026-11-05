import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, statSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

const require = createRequire(import.meta.url);

test("headless host protects its backend and local administration, pairs/revokes, and remembers disable across restart", { skip: process.platform === "win32" ? "The headless host requires Unix sockets." : false }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "lh-headless-"));
	const previous = { ...process.env };
	const socketPath = join(directory, "control.sock");
	const listener = net.createServer().listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = (listener.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	process.env.LH_REMOTE_STATE_DIR = directory;
	process.env.LH_REMOTE_CONTROL_SOCKET = socketPath;
	process.env.PORT = String(port);
	const { serve, parseCommand, runCommand } = require("../scripts/remote-headless.cjs");
	const { createRemoteAccess } = require("../electron/remote-access.cjs");
	const backend = join(directory, "backend.cjs");
	writeFileSync(backend, `
const http = require('node:http');
const waiting = new Map();
process.on('message', m => { const res=waiting.get(m.id); if(res) {waiting.delete(m.id);res.end(JSON.stringify(m.value));} });
http.createServer((req,res) => {
 res.setHeader('content-type','application/json');
 if(req.headers['x-learnharness-desktop'] !== process.env.LH_DESKTOP_API_SECRET) {res.statusCode=403;return res.end('{}');}
 if(req.url === '/api/remote/pair') {
  if(req.headers['x-forwarded-proto']==='https'){res.statusCode=403;return res.end('{}');}
  waiting.set('test-pair',res);process.send({channel:'lh:remote-admin',id:'test-pair',op:'pair'});return;
 }
 res.end(JSON.stringify({ready:true}));
}).listen(Number(process.env.PORT),process.env.HOSTNAME);
`);
	let target = "";
	const origin = "https://headless.test.ts.net:8443";
	const createRemote = (options: Record<string, unknown>) => createRemoteAccess({ ...options, tailscale: { start: async (value: string) => { target = value; return origin; }, stop: async () => {} } });
	let host: Awaited<ReturnType<typeof serve>>;
	t.after(async () => {
		await host?.shutdown();
		for (const key of ["LH_REMOTE_STATE_DIR", "LH_REMOTE_CONTROL_SOCKET", "PORT"]) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(directory, { recursive: true, force: true });
	});
	const gateway = (route: string, headers: Record<string, string> = {}, body?: object) => new Promise<{ status: number; body: string }>((resolve, reject) => {
		const request = http.request(new URL(route, target), { method: body ? "POST" : "GET", headers: { host: new URL(origin).host, "x-forwarded-proto": "https", ...headers } }, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode!, body }));
		});
		request.on("error", reject);
		request.end(body ? JSON.stringify(body) : undefined);
	});
	assert.throws(() => parseCommand(["revoke"]), /Usage/);
	assert.throws(() => parseCommand(["revoke", 42]), /Usage/);
	assert.throws(() => parseCommand(["status", "unexpected"]), /Usage/);
	host = await serve({ serverEntry: backend, createRemote });
	assert.equal(statSync(socketPath).mode & 0o777, 0o600);
	assert.equal((await fetch(host.upstream + "/api/settings")).status, 403);
	assert.equal((await runCommand({ op: "status" })).enabled, true);
	const chatgpt = await runCommand({ op: "chatgpt-status" });
	assert.equal(chatgpt.available, true);
	assert.equal(chatgpt.allowBackgroundUse, true);
	assert.deepEqual(chatgpt.accounts, []);
	assert.equal("authorizationUrl" in chatgpt, false);
	await assert.rejects(runCommand({ op: "chatgpt-complete", callback: "http://127.0.0.1:99/auth/callback?code=synthetic" }), /No ChatGPT sign-in/);
	assert.equal((await gateway("/api/settings")).status, 401);
	const pair = await runCommand({ op: "pair" });
	const grant = new URLSearchParams(new URL(pair.pairingUrl).hash.slice(1)).get("grant");
	const paired = await gateway("/_lh/remote/pair", { origin, "content-type": "application/json" }, { grant });
	assert.equal(paired.status, 200);
	const logged = t.mock.method(console, "log", () => {});
	assert.equal((await gateway("/_lh/remote/pair", { origin, "content-type": "application/json" }, { grant })).status, 401);
	const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
	logged.mock.restore();
	assert.ok(lines.includes("remote pairing rejected: no-pending"), "pairing rejection reasons reach the service journal");
	assert.equal(lines.some((line) => line.includes(grant!)), false, "the journal never receives the grant");
	const headers = { "x-learnharness-remote": JSON.parse(paired.body).token };
	assert.equal((await gateway("/api/settings", headers)).status, 200);
	assert.equal((await gateway("/api/remote/pair", { ...headers, origin }, {})).status, 403);
	const id = (await runCommand({ op: "status" })).devices[0].id;
	await host.shutdown();
	assert.equal(existsSync(socketPath), false);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/api/settings`));
	host = await serve({ serverEntry: backend, createRemote });
	assert.equal((await gateway("/api/settings", headers)).status, 200, "pairing survives supervisor/backend restart");
	await runCommand({ op: "revoke", id });
	assert.equal((await gateway("/api/settings", headers)).status, 401);
	await assert.rejects(runCommand({ op: "unrecognized" }), /Usage/);
	assert.equal((await runCommand({ op: "disable" })).enabled, false);
	await host.shutdown();
	host = await serve({ serverEntry: backend, createRemote });
	assert.equal((await runCommand({ op: "status" })).enabled, false, "an explicit disable survives restart");
	assert.equal((await runCommand({ op: "enable" })).enabled, true);
	await assert.rejects(serve({ serverEntry: backend, createRemote }), /already exists/);
	await host.shutdown();
	chmodSync(directory, 0o755);
	await assert.rejects(serve({ serverEntry: backend, createRemote }), /private directory/);
	chmodSync(directory, 0o700);
});
