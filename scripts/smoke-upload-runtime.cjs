"use strict";

// A real production server behind the real pairing gateway; only Tailscale
// transport is simulated. Temporary profiles, no account keys or inference.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { once } = require("node:events");

(async () => {
	const root = path.resolve(__dirname, "..");
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lh-upload-runtime-"));
	const reservation = net.createServer().listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = reservation.address().port;
	await new Promise((resolve) => reservation.close(resolve));
	Object.assign(process.env, {
		PORT: String(port), LH_REMOTE_STATE_DIR: temporary,
		LH_REMOTE_CONTROL_SOCKET: path.join(temporary, "control.sock"),
		LH_DATA_DIR: path.join(temporary, "data"), LH_AUTH_FILE: path.join(temporary, "auth.json"), LH_IGNORE_ENV_KEYS: "1",
	});
	const { serve, runCommand } = require(path.join(root, "scripts/remote-headless.cjs"));
	const { createRemoteAccess } = require(path.join(root, "electron/remote-access.cjs"));
	const origin = "https://upload-smoke.test.ts.net:8443";
	let target, host;
	const options = { createRemote: (config) => createRemoteAccess({ ...config,
		tailscale: { start: async (url) => { target = url; return origin; }, stop: async () => {} } }) };
	const request = (route, headers = {}, body) => new Promise((resolve, reject) => {
		const req = http.request(new URL(route, target), { method: body ? "POST" : "GET",
			headers: { host: new URL(origin).host, "x-forwarded-proto": "https", ...(body ? { "content-length": body.length } : {}), ...headers } }, (res) => {
			let text = "";
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
			res.on("error", reject);
		});
		req.on("error", reject); req.end(body);
	});
	const multipart = async (files) => {
		const form = new FormData();
		for (const file of files) form.append("files", file);
		const encoded = new Response(form);
		return { type: encoded.headers.get("content-type"), bytes: Buffer.from(await encoded.arrayBuffer()) };
	};
	try {
		host = await serve(options);
		const small = await multipart([new File(["%PDF-1.4\n\u0000\u00ff"], "lecture.pdf"), new File(["personal notes"], "notes.md")]);
		assert.equal((await fetch(host.upstream + "/api/attachments", { method: "POST", body: "untrusted" })).status, 403);
		assert.equal((await request("/api/attachments", { origin, "content-type": small.type }, small.bytes)).status, 401);
		const link = await runCommand({ op: "pair" });
		const grant = new URLSearchParams(new URL(link.pairingUrl).hash.slice(1)).get("grant");
		const paired = await request("/_lh/remote/pair", { origin, "content-type": "application/json" }, Buffer.from(JSON.stringify({ grant })));
		assert.equal(paired.status, 200);
		const auth = { origin, "x-learnharness-remote": paired.body.token };
		assert.equal((await request("/api/attachments", { ...auth, origin: "https://evil.invalid", "content-type": small.type }, small.bytes)).status, 403);
		const uploaded = await request("/api/attachments", { ...auth, "content-type": small.type }, small.bytes);
		assert.equal(uploaded.status, 200);
		assert.equal(fs.readFileSync(uploaded.body.paths[0], "utf8"), "%PDF-1.4\n\u0000\u00ff");
		assert.equal(fs.readFileSync(uploaded.body.paths[1], "utf8"), "personal notes");
		const later = await request("/api/attachments", { ...auth, "content-type": small.type }, small.bytes);
		assert.equal(later.status, 200);
		assert.notEqual(later.body.paths[0], uploaded.body.paths[0]);
		const large = await multipart([new File([new Uint8Array(25 * 1024 * 1024)], "large.bin")]);
		const allowed = await request("/api/attachments", { ...auth, "content-type": large.type }, large.bytes);
		assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
		assert.equal(fs.statSync(allowed.body.paths[0]).size, 25 * 1024 * 1024);
		const oversized = await multipart([new File([new Uint8Array(25 * 1024 * 1024 + 1)], "too-large.bin")]);
		assert.equal((await request("/api/attachments", { ...auth, "content-type": oversized.type }, oversized.bytes)).status, 413);
		const settingsFile = path.join(temporary, "data/settings.json");
		const restricted = JSON.stringify({ agent: { fileAccess: { restricted: true, folders: [] } } });
		fs.writeFileSync(settingsFile, restricted);
		assert.equal((await request("/api/attachments", { ...auth, "content-type": small.type }, small.bytes)).status, 403);
		assert.equal(fs.readFileSync(settingsFile, "utf8"), restricted);
		fs.writeFileSync(settingsFile, "{}");
		await host.shutdown(); host = await serve(options);
		assert.equal((await request("/api/settings", auth)).status, 200);
		assert.equal(fs.readFileSync(uploaded.body.paths[1], "utf8"), "personal notes");
		assert.equal(fs.existsSync(path.join(temporary, "data/jobs")), false);
		assert.equal(fs.existsSync(path.join(temporary, "data/chats")), false);
		const status = await runCommand({ op: "status" });
		await runCommand({ op: "revoke", id: status.devices[0].id });
		assert.equal((await request("/api/attachments", { ...auth, "content-type": small.type }, small.bytes)).status, 401);
		console.log("PASS: production multipart bytes, 25 MiB boundary, oversized refusal, private durable files, no overwrite, unchanged restrictions, no session/job creation, restart persistence, authentication/origin/revocation through the real gateway. Tailscale transport simulated.");
	} finally {
		await host?.shutdown(); fs.rmSync(temporary, { recursive: true, force: true });
	}
})().catch((error) => { console.error(error); process.exitCode = 1; });
