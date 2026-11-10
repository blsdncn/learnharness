import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const { localPort, startLocalServer } = createRequire(import.meta.url)("../electron/local-host.cjs");

test("both the CLI flag and environment option route to hosting without creating a window", () => {
	const mainFile = new URL("../electron/main.cjs", import.meta.url);
	const mainRequire = createRequire(mainFile);
	for (const [argv, env] of [[["--local-host"], {}], [[], { LH_LOCAL_HOST: "1" }]] as const) {
		let hosted = false;
		let name;
		const app = {
			setName(value: string) { name = value; },
			requestSingleInstanceLock: () => true, on() {},
			getPath: () => "/fixture", exit() { assert.fail("unexpected exit"); },
		};
		runInNewContext(readFileSync(mainFile, "utf8"), {
			require(id: string) {
				if (id === "electron") return { app };
				if (id === "../package.json") return { lhLocalBuild: true };
				if (id === "./local-host.cjs") return { async runLocalHost() { hosted = true; } };
				return mainRequire(id);
			},
			process: { argv, env, resourcesPath: "/fixture/resources", on() {} },
		});
		assert.equal(hosted, true);
		assert.equal(name, "LearnHarness Local");
	}
});

async function unusedPort() {
	const probe = net.createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const port = (probe.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

test("localhost port defaults, override, and invalid configuration", () => {
	assert.equal(localPort({}), 3000);
	assert.equal(localPort({ LH_LOCAL_PORT: "3145" }), 3145);
	for (const value of ["", "0", "65536", "3.5", "abc", "-1"]) {
		assert.throws(() => localPort({ LH_LOCAL_PORT: value }), /LH_LOCAL_PORT/);
	}
});

test("local server uses loopback and the isolated web owner, and releases its port on stop", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "lh-local-host-"));
	const serverEntry = path.join(root, "server.cjs");
	writeFileSync(serverEntry, `const http = require('node:http');
http.createServer((req, res) => res.end(JSON.stringify({
host: process.env.HOSTNAME, data: process.env.LH_DATA_DIR, auth: process.env.LH_AUTH_FILE,
desktop: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET,
dev: process.env.LH_DEV_URL
}))).listen(Number(process.env.PORT), process.env.HOSTNAME);`);
	const port = await unusedPort();
	let server;
	try {
		server = await startLocalServer({
			serverEntry, profile: path.join(root, "profile"), port, log() {},
			env: { ...process.env, LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "fixture", LH_DEV_URL: "http://fixture" },
		});
		const response = await fetch(server.url);
		assert.deepEqual(await response.json(), {
			host: "127.0.0.1", data: path.join(root, "profile", "data"), auth: path.join(root, "profile", "auth.json"),
		});
		await assert.rejects(startLocalServer({ serverEntry, profile: root, port }), /Set LH_LOCAL_PORT/);
		await server.stop();
		await server.stop();
		await assert.rejects(fetch(server.url));
	} finally {
		await server?.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed startup and cancellation stop the owned process", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "lh-local-failure-"));
	try {
		const serverEntry = path.join(root, "server.cjs");
		writeFileSync(serverEntry, "process.exit(17)");
		await assert.rejects(startLocalServer({ serverEntry, profile: root, port: await unusedPort(), log() {} }), /code=17/);
		writeFileSync(serverEntry, "setInterval(() => {}, 1000)");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 250);
		try {
			await assert.rejects(startLocalServer({ serverEntry, profile: root, port: await unusedPort(), signal: controller.signal, log() {} }), /abort/i);
		} finally { clearTimeout(timer); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});
