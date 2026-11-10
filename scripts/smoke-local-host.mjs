/** Isolated AppImage regression for desktop-only 403s versus browser hosting.
 * Requires a graphical session (or Xvfb); no credentials or model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const image = path.resolve(process.argv[2] ?? "dist/LearnHarness-Local-0.5.0-x86_64.AppImage");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-appimage-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "xdg-open"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$LH_BROWSER_OPEN_LOG"\n', { mode: 0o755 });

async function listen(server) {
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	return server.address().port;
}
async function freePort() {
	const server = net.createServer();
	const port = await listen(server);
	await new Promise(resolve => server.close(resolve));
	return port;
}
async function until(check) {
	const deadline = Date.now() + 45000;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("AppImage smoke timed out");
		await delay(100);
	}
}

try {
	for (const mode of ["desktop", "flag", "env"]) {
		const home = path.join(root, mode);
		fs.mkdirSync(home);
		const port = await freePort();
		const debugPort = await freePort();
		const env = {
			...probeEnv(process.env, home), PATH: `${bin}:${process.env.PATH}`,
			APPIMAGE_EXTRACT_AND_RUN: "1", LH_LOCAL_PORT: String(port),
			LH_LOCAL_HOST: mode === "env" ? "1" : "0", LH_BROWSER_OPEN_LOG: path.join(home, "opened-url"),
		};
		let output = "";
		const child = spawn(image, ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`, ...(mode === "flag" ? ["--local-host"] : [])], { env });
		const exited = once(child, "exit");
		child.stdout.on("data", data => { output = (output + data).slice(-32000); });
		child.stderr.on("data", data => { output = (output + data).slice(-32000); });
		let inspector, browser, forward;
		const sockets = new Set();
		try {
			const url = await until(() => {
				assert.equal(child.exitCode, null, output);
				assert.equal(child.signalCode, null, output);
				return output.match(mode === "desktop" ? /server up: (http:\/\/127\.0\.0\.1:\d+)/ : /Localhost ready: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
			});
			const endpoint = await until(async () => {
				try { return (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; }
				catch { return null; }
			});
			inspector = await puppeteer.connect({ browserWSEndpoint: endpoint });
			if (mode === "desktop") {
				await until(async () => (await inspector.pages()).length > 0);
				assert.equal((await fetch(`${url}/api/settings`)).status, 403);
			} else {
				assert.equal((await inspector.pages()).length, 0, "hosting must create no Electron window");
				// TCP forwarding preserves the browser's Host and Origin, like SSH -L.
				forward = net.createServer(socket => {
					const upstream = net.connect(Number(new URL(url).port), "127.0.0.1");
					for (const owned of [socket, upstream]) { sockets.add(owned); owned.on("error", () => owned.destroy()); owned.on("close", () => sockets.delete(owned)); }
					socket.pipe(upstream).pipe(socket);
				});
				const forwardedPort = await listen(forward);
				const origin = `http://127.0.0.1:${forwardedPort}`;
				browser = await puppeteer.launch({
					executablePath: process.env.LH_TEST_CHROME, headless: true, env,
					userDataDir: path.join(home, "browser"), args: ["--no-sandbox", "--disable-gpu", "--disable-background-networking"],
				});
				const page = await browser.newPage();
				await page.setRequestInterception(true);
				page.on("request", request => request.url().startsWith(`${origin}/`) || request.url().startsWith("data:") ? request.continue() : request.abort());
				assert.equal((await page.goto(origin, { waitUntil: "networkidle2" })).status(), 200);
				const statuses = await page.evaluate(async () => {
					const result = {};
					for (const route of ["graph", "models", "settings", "subscriptions"]) {
						result[route] = (await fetch(`/api/${route}`, { headers: { "x-learnharness-subscriptions": "1" } })).status;
					}
					result.write = (await fetch("/api/settings/general", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status;
					return result;
				});
				assert.deepEqual(statuses, { graph: 200, models: 200, settings: 200, subscriptions: 200, write: 200 });
				await until(() => fs.existsSync(env.LH_BROWSER_OPEN_LOG));
				assert.equal(new URL(fs.readFileSync(env.LH_BROWSER_OPEN_LOG, "utf8").trim()).href, new URL(url).href);
				console.log(`[smoke-local-host] ${mode}: no window; browser through TCP forwarding: ${JSON.stringify(statuses)}; automatic browser URL correct`);
			}
			if (mode === "desktop") await inspector.close();
			else child.kill("SIGTERM");
			const [code, signal] = await Promise.race([exited, delay(10000).then(() => { throw new Error("AppImage did not stop"); })]);
			assert.ok(code === 0 || (code === null && signal === "SIGTERM"), output);
			await until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
			console.log(`[smoke-local-host] ${mode}: passed; server stopped with AppImage`);
		} catch (error) { throw new Error(`${mode}: ${error.message}\n${output}`, { cause: error }); }
		finally {
			await browser?.close();
			if (child.exitCode === null && child.signalCode === null) {
				if (mode === "desktop" && inspector?.connected) await inspector.close().catch(() => {});
				else child.kill("SIGTERM");
				await Promise.race([exited, delay(5000)]);
			}
			inspector?.disconnect();
			for (const socket of sockets) socket.destroy();
			if (forward) await new Promise(resolve => forward.close(resolve));
			if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
		}
	}
} finally { fs.rmSync(root, { recursive: true, force: true }); }
