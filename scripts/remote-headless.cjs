#!/usr/bin/env node
"use strict";

// The headless host owns the same private backend and pairing gateway as
// Electron. Administrative commands use a user-only Unix socket, never HTTP.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { fork } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { createRemoteAccess } = require("../electron/remote-access.cjs");
const { attachRemoteChild } = require("../electron/remote-child.cjs");
const { attachChatGPTChild } = require("../electron/chatgpt-ipc.cjs");
const { attachSubscriptionChild } = require("../electron/subscription-ipc.cjs");
const { createHeadlessChatGPT } = require("./headless-chatgpt.cjs");

const root = path.resolve(__dirname, "..");
const stateDir = process.env.LH_REMOTE_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "learnharness");
const socketPath = process.env.LH_REMOTE_CONTROL_SOCKET || path.join(process.env.XDG_RUNTIME_DIR || stateDir, "learnharness-remote", "control.sock");

function parseCommand(args) {
	const [op, id, ...extra] = args;
	if (["chatgpt-status", "chatgpt-login", "chatgpt-cancel", "chatgpt-complete", "chatgpt-models"].includes(op)) {
		if (extra.length || (op === "chatgpt-login" ? id !== undefined && typeof id !== "string" : id !== undefined)) throw new Error("Unexpected ChatGPT command arguments.");
		return { op, ...(id ? { id } : {}) };
	}
	if (!["status", "pair", "enable", "disable", "revoke"].includes(op) || extra.length || (op === "revoke" ? typeof id !== "string" || !id : id !== undefined))
		throw new Error("Usage: remote-headless.cjs serve | status | pair | enable | disable | revoke <device-id>");
	return { op, ...(id ? { id } : {}) };
}

function privateDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077))
		throw new Error(`A private directory owned by this user is required: ${directory}`);
}

async function runCommand(command) {
	return new Promise((resolve, reject) => {
		const request = http.request({ socketPath, path: "/control", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += chunk; });
			response.on("error", reject);
			response.on("end", () => {
				try {
					const value = JSON.parse(body);
					if (response.statusCode !== 200) reject(new Error(value.error || "Local control request failed."));
					else resolve(value);
				} catch (error) { reject(error); }
			});
		});
		request.setTimeout(50_000, () => request.destroy(new Error("Local control request timed out.")));
		request.on("error", reject);
		request.end(JSON.stringify(command));
	});
}

async function serve({ createRemote = createRemoteAccess, createChat = createHeadlessChatGPT, serverEntry = path.join(root, ".next/standalone/server.js") } = {}) {
	if (process.platform === "win32") throw new Error("The headless launcher requires Unix sockets.");
	privateDirectory(stateDir);
	privateDirectory(path.dirname(socketPath));
	// Never unlink a socket belonging to another live service. systemd owns
	// RuntimeDirectory and removes stale sockets after a failed process exits.
	if (fs.existsSync(socketPath)) throw new Error(`Control socket already exists: ${socketPath}`);
	if (!fs.existsSync(serverEntry)) throw new Error("Build the standalone server first: npm run build && node scripts/build-server.mjs");
	const port = Number(process.env.PORT || 3000);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
	const upstream = `http://127.0.0.1:${port}`;
	const desktopSecret = randomBytes(32).toString("hex");
	const statePath = path.join(stateDir, "remote-access.json");
	let desired = true;
	if (fs.existsSync(statePath)) desired = JSON.parse(fs.readFileSync(statePath, "utf8")).enabled === true;
	const remote = createRemote({ upstream, desktopSecret, statePath });
	let child, relay, chatRelay, nativeRelay, chat, control, retry;
	let ownsSocket = false;
	let stopping;
	const shutdown = () => stopping ||= (async () => {
		clearInterval(retry);
		const deadline = setTimeout(() => process.exit(1), 30_000);
		deadline.unref();
		control?.close();
		control?.closeAllConnections();
		relay?.dispose();
		chatRelay?.dispose();
		nativeRelay?.dispose();
		chat?.connection.close();
		try { await remote.shutdown(); }
		finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			if (ownsSocket) fs.rmSync(socketPath, { force: true });
			process.removeListener("SIGTERM", onSignal);
			process.removeListener("SIGINT", onSignal);
			clearTimeout(deadline);
		}
	})();
	const onSignal = () => { void shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	try {
		chat = createChat({ directory: stateDir, onChange: (packet) => chatRelay?.send(packet) });
		await chat.connection.status();
		child = fork(serverEntry, [], {
			execArgv: [],
			cwd: path.dirname(serverEntry),
			env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
				LH_DATA_DIR: process.env.LH_DATA_DIR || path.join(root, "data"),
				LH_AUTH_FILE: process.env.LH_AUTH_FILE || path.join(root, "auth.json"),
				LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: desktopSecret },
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		child.on("error", (error) => { console.error(`Backend: ${error.message}`); process.exitCode = 1; onSignal(); });
		child.on("exit", () => {
			if (!stopping) { console.error("Backend exited; stopping the remote gateway."); process.exitCode = 1; onSignal(); }
		});
		relay = attachRemoteChild(child, remote);
		chatRelay = attachChatGPTChild(child, chat.connection);
		// Other desktop subscriptions remain unavailable, with an immediate
		// reply rather than making the model catalog wait for an IPC timeout.
		nativeRelay = attachSubscriptionChild(child, null);
		const deadline = Date.now() + 60_000;
		let ready = false;
		while (!stopping && Date.now() < deadline) {
			try {
				// A capability check prevents accidentally adopting an unrelated
				// server already listening on this port after the child failed.
				const response = await fetch(`${upstream}/api/settings`, { headers: { "x-learnharness-desktop": desktopSecret }, signal: AbortSignal.timeout(2000) });
				await response.body?.cancel();
				if (response.ok) { ready = true; break; }
			} catch { /* The child may still be booting. */ }
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (stopping) { await stopping; return; }
		if (!ready) throw new Error("Backend did not become ready within 60 seconds.");
		control = http.createServer(async (request, response) => {
			const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
			if (request.method !== "POST" || request.url !== "/control") return reply(404, { error: "Unknown local operation." });
			try {
				let body = "";
				for await (const chunk of request) {
					body += chunk;
					if (Buffer.byteLength(body) > 12_288) return reply(413, { error: "Local command too large." });
				}
				const raw = JSON.parse(body);
				const command = parseCommand([raw.op, ...(raw.id === undefined ? [] : [raw.id])]);
				if (command.op === "chatgpt-status") return reply(200, await chat.connection.status());
				if (command.op === "chatgpt-models") return reply(200, await chat.connection.models());
				if (command.op === "chatgpt-login") return reply(200, await chat.login(command.id));
				if (command.op === "chatgpt-cancel") return reply(200, chat.cancel());
				if (command.op === "chatgpt-complete") {
					if (typeof raw.callback !== "string") return reply(400, { error: "A callback URL is required through private input." });
					return reply(200, await chat.complete(raw.callback));
				}
				if (command.op === "enable") desired = true;
				if (command.op === "disable") desired = false;
				reply(200, await remote.control(command));
			} catch (error) { reply(400, { error: error.message }); }
		});
		control.requestTimeout = 10_000;
		await new Promise((resolve, reject) => { control.once("error", reject); control.listen(socketPath, resolve); });
		ownsSocket = true;
		fs.chmodSync(socketPath, 0o600);
		if (stopping) {
			control.close();
			await stopping;
			fs.rmSync(socketPath, { force: true });
			return;
		}
		const enable = async () => {
			if (!desired || stopping || remote.status().enabled) return;
			const status = await remote.control({ op: "enable" });
			if (status.error) console.error(`Remote access waiting: ${status.error}`);
			else console.log(`Private remote access ready: ${status.url}`);
		};
		await enable();
		if (stopping) { await stopping; return; }
		retry = setInterval(() => { void enable().catch((error) => console.error(error.message)); }, 30_000);
		console.log(`Local administration ready: ${socketPath}`);
		return { remote, shutdown, socketPath, upstream };
	} catch (error) { await shutdown(); throw error; }
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const operation = args.length === 1 && args[0] === "serve" ? serve() : Promise.resolve().then(async () => {
		const command = parseCommand(args);
		if (command.op === "chatgpt-complete") {
			if (process.stdin.isTTY) throw new Error("Provide the callback URL on stdin through a private file; never pass it as an argument.");
			let input = "";
			for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) throw new Error("Callback input too large."); }
			command.callback = input.trim();
		}
		return runCommand(command);
	}).then((value) => {
		console.log(JSON.stringify(value, null, 2));
		if (value.error) process.exitCode = 1;
	});
	operation.catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { serve, parseCommand, runCommand };
