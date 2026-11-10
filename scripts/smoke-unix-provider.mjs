/** Synthetic UDS provider against the production server or an actual AppImage.
 * No ambient credentials, personal records, real models, or external services. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { responseFrames } from "./responses-fixture.mjs";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-uds-smoke-"));
const socketPath = path.join(home, "provider.sock");
const appIndex = process.argv.indexOf("--appimage");
const image = appIndex < 0 ? undefined : path.resolve(process.argv[appIndex + 1]);
const apiIndex = process.argv.indexOf("--api");
const api = apiIndex < 0 ? "openai-completions" : process.argv[apiIndex + 1];
assert.ok(["openai-completions", "openai-responses"].includes(api), "Unsupported --api choice");
const unix = !process.argv.includes("--tcp");
let tcpRequests = 0, discoveries = 0, generations = 0;
const decoy = http.createServer((_req, res) => { tcpRequests++; res.writeHead(500); res.end("TCP must never be used"); });
const fixture = http.createServer(async (req, res) => {
	assert.equal(req.headers.authorization, "Bearer synthetic-socket-key");
	if (req.url === "/v1/models" && req.method === "GET") {
		discoveries++;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", context_length: 131072, max_output_tokens: 4096 }] }));
		return;
	}
	assert.equal(req.url, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions"); assert.equal(req.method, "POST");
	const chunks = []; for await (const chunk of req) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	// Model the reported gateway: reject chunked requests instead of silently
	// accepting Node's automatically decoded body in this synthetic server.
	if (unix && (req.headers["transfer-encoding"] || !req.headers["content-length"])) {
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "missing model for request" })); return;
	}
	if (unix) assert.equal(Number(req.headers["content-length"]), bytes.length);
	const payload = JSON.parse(bytes.toString("utf8"));
	assert.ok(Array.isArray(api === "openai-responses" ? payload.input : payload.messages));
	assert.equal(JSON.parse(bytes.toString("utf8")).model, "gpt-5.6-luna"); generations++;
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (api === "openai-responses") { res.end(responseFrames().join("")); return; }
	res.write(`data: ${JSON.stringify({ id: "offline-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "socket fixture response" }, finish_reason: null }] })}\n\n`);
	res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
});
async function listen(server, address) { server.listen(address); await once(server, "listening"); return server.address(); }
async function until(check) {
	const deadline = Date.now() + 45000;
	for (;;) { const result = await check(); if (result) return result; if (Date.now() > deadline) throw new Error("UDS smoke timed out"); await delay(100); }
}

let running;
let backendOutput = "";
try {
	const decoyPort = (await listen(decoy, { host: "127.0.0.1", port: 0 })).port;
	const fixtureAddress = await listen(fixture, unix ? socketPath : { host: "127.0.0.1", port: 0 });
	const baseUrl = `http://127.0.0.1:${unix ? decoyPort : fixtureAddress.port}/v1`;
	const reserve = net.createServer();
	const port = (await listen(reserve, { host: "127.0.0.1", port: 0 })).port;
	await new Promise(resolve => reserve.close(resolve));
	const origin = `http://127.0.0.1:${port}`;
	const bin = path.join(home, "bin"); fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const env = { ...probeEnv(process.env, home), PATH: `${bin}:${process.env.PATH}`, HOSTNAME: "127.0.0.1", PORT: String(port), LH_LOCAL_HOST: "1", LH_LOCAL_PORT: String(port), APPIMAGE_EXTRACT_AND_RUN: "1" };
	delete env.LH_DESKTOP_SERVER; delete env.LH_DESKTOP_API_SECRET;
	async function start() {
		let output = "";
		const args = image ? ["--no-sandbox", "--disable-gpu"] : [path.resolve(".next/standalone/server.js")];
		const child = spawn(image ?? process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		const exited = once(child, "exit");
		for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-12000); backendOutput = output; });
		running = { child, exited };
		await until(async () => {
			assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output);
			try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; }
		});
	}
	async function stop() {
		const { child, exited } = running;
		child.kill("SIGTERM"); await exited;
		await until(async () => { try { await fetch(origin, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
		running = undefined;
	}
	async function request(route, method = "GET", body, extra = {}) {
		console.log(`[smoke-unix-provider] ${method} ${route}`);
		const response = await fetch(origin + route, { method, headers: { origin, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) }).catch(error => { throw new Error(`${method} ${route}: ${error.message}\n${backendOutput}`, { cause: error }); });
		assert.equal(response.status, 200, `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`);
		return response;
	}
	async function generate() {
		const { id } = await (await request("/api/chats", "POST", { title: "Synthetic socket verification" })).json();
		await request("/api/chat", "POST", { chatId: id, input: { type: "text", text: "Synthetic transport test: héllo 🌙 世界" } });
		await until(async () => {
			const record = await (await request(`/api/chats/${id}`)).json();
			if (record.turnInFlight) return false;
			assert.ok(JSON.stringify(record.messages).includes("socket fixture response"), JSON.stringify(record));
			return true;
		});
	}
	await start();
	const revision = (await request("/api/custom-provider")).headers.get("etag");
	await request("/api/custom-provider", "POST", { api, baseUrl, ...(unix ? { socketPath } : {}), authMode: "apiKey", key: "synthetic-socket-key" }, { "if-match": revision });
	await request("/api/settings/models", "PUT", { strong: { model: { provider: "custom", id: "gpt-5.6-luna" } } });
	await generate(); await stop(); await start();
	const restored = await (await request("/api/custom-provider")).json();
	assert.equal(restored.api, api); assert.equal(restored.socketPath, unix ? socketPath : undefined); assert.equal(restored.keyPresent, true);
	await generate(); await stop();
	assert.equal(tcpRequests, 0); assert.equal(discoveries, 1); assert.ok(generations >= 2);
	if (unix) assert.ok(fs.statSync(socketPath).isSocket());
	console.log(`[smoke-unix-provider] ${image ? "AppImage" : "standalone"}: ${api} discovery and chat generation over ${unix ? "AF_UNIX with fixed Content-Length" : "TCP"}; restart retained socket/key; ${generations} synthetic generations; zero TCP requests; clean shutdown`);
} finally {
	if (running && running.child.exitCode === null && running.child.signalCode === null) { running.child.kill("SIGKILL"); await running.exited; }
	for (const server of [fixture, decoy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	fs.rmSync(home, { recursive: true, force: true });
}
