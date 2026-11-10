"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

function localPort(env = process.env) {
	const value = env.LH_LOCAL_PORT ?? "3000";
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
		throw new Error("LH_LOCAL_PORT must be an integer between 1 and 65535.");
	}
	return Number(value);
}

async function checkPort(port) {
	await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", (error) => reject(new Error(`Cannot host on 127.0.0.1:${port}: ${error.code}. Set LH_LOCAL_PORT to another port.`)));
		probe.listen(port, "127.0.0.1", () => probe.close(resolve));
	});
}

function responds(url) {
	return new Promise((resolve) => {
		const request = http.get(url, (response) => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.on("error", () => resolve(false));
		request.setTimeout(1000, () => request.destroy());
	});
}

/** Uses v0.5.0's existing web credential owner, never the desktop IPC owner.
 * The packaged Electron executable still provides Node and the demo helper. */
async function startLocalServer({ serverEntry, profile, port, signal, log = console.log, runtime = process.execPath, env = process.env }) {
	await checkPort(port);
	signal?.throwIfAborted();
	fs.mkdirSync(profile, { recursive: true });
	const childEnv = {
		...env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production",
		HOSTNAME: "127.0.0.1", PORT: String(port),
		LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json"),
	};
	delete childEnv.LH_DESKTOP_SERVER;
	delete childEnv.LH_DESKTOP_API_SECRET;
	delete childEnv.LH_DEV_URL;
	const child = spawn(runtime, [serverEntry], {
		cwd: path.dirname(serverEntry), env: childEnv, stdio: ["ignore", "pipe", "pipe"],
	});
	let failure;
	child.once("error", (error) => { failure = error; });
	child.once("exit", (code, exitSignal) => {
		failure = new Error(`Local server exited (code=${code}, signal=${exitSignal}).`);
	});
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (data) => log(data.toString().trimEnd()));
	}
	let stopping;
	const stop = () => stopping ??= new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		child.once("exit", () => { clearTimeout(timer); resolve(); });
		child.kill("SIGTERM");
	});
	const abort = () => { void stop(); };
	signal?.addEventListener("abort", abort, { once: true });
	child.once("exit", () => signal?.removeEventListener("abort", abort));
	const url = `http://127.0.0.1:${port}`;
	try {
		const deadline = Date.now() + 30000;
		for (;;) {
			signal?.throwIfAborted();
			if (failure) throw failure;
			if (await responds(url)) {
				signal?.throwIfAborted();
				if (failure) throw failure;
				return { child, url, stop };
			}
			if (Date.now() >= deadline) throw new Error(`Local server did not become ready at ${url}.`);
			await delay(100, undefined, { signal });
		}
	} catch (error) {
		await stop();
		throw error;
	}
}

async function runLocalHost({ app, shell, serverEntry, log }) {
	const port = localPort();
	if (process.env.LH_DEV_URL) throw new Error("--local-host requires the packaged server; unset LH_DEV_URL.");
	const lifetime = new AbortController();
	let server;
	let startup;
	let quitting = false;
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		quitting = true;
		lifetime.abort();
		Promise.resolve(startup).catch(() => undefined).then(() => server?.stop()).finally(() => app.quit());
	});
	const quit = () => app.quit();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, quit);
	// AppImage's extract-and-run runtime forks a supervisor for temporary
	// payload cleanup. It does not forward termination to Electron. Stop if
	// that supervisor disappears, covering Ctrl+C/SIGTERM of the AppImage PID.
	if (process.env.APPIMAGE_EXTRACT_AND_RUN === "1") {
		const supervisor = process.ppid;
		const watch = setInterval(() => { if (process.ppid !== supervisor) quit(); }, 250);
		watch.unref();
		app.once("will-quit", () => clearInterval(watch));
	}
	// Last-resort cleanup for synchronous exit paths.
	process.on("exit", () => server?.child.kill("SIGTERM"));
	await app.whenReady();
	startup = startLocalServer({
		serverEntry, profile: app.getPath("userData"), port, signal: lifetime.signal, log,
	});
	try { server = await startup; }
	catch (error) {
		if (lifetime.signal.aborted) return;
		throw error;
	}
	server.child.once("exit", () => { if (!quitting) app.exit(1); });
	log(`Localhost ready: ${server.url} — stop the AppImage process to stop hosting.`);
	try { await shell.openExternal(server.url); }
	catch (error) { log(`Could not open the browser: ${error.message}. Open ${server.url} manually.`); }
}

module.exports = { localPort, startLocalServer, runLocalHost };
