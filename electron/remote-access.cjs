"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { createTailscaleServe } = require("./tailscale-serve.cjs");
const { pairingPage } = require("./remote-pairing.cjs");
const { remoteWorker } = require("./remote-worker.cjs");

const PAIR_TTL = 5 * 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** The only remote ingress. It shares the live desktop server, never opens
 * the desktop capability to renderers, and authenticates pages AND APIs. */
function createRemoteAccess({ upstream, desktopSecret, statePath, tailscale = createTailscaleServe(), onChange = () => {}, now = Date.now, storage = fs }) {
	const backend = new URL(upstream);
	if (backend.hostname !== "127.0.0.1" || backend.protocol !== "http:" || !desktopSecret || desktopSecret.length < 64)
		throw new Error("Remote access requires the desktop's private loopback backend.");
	let saved = { enabled: false, target: null, devices: [] };
	try {
		const value = JSON.parse(storage.readFileSync(statePath, "utf8"));
		saved = { enabled: value.enabled === true, target: typeof value.target === "string" ? value.target : null,
			devices: Array.isArray(value.devices) ? value.devices.filter((d) =>
				d && typeof d.id === "string" && typeof d.label === "string" && d.label.length <= 120 &&
				typeof d.hash === "string" && /^[a-f0-9]{64}$/.test(d.hash) &&
				Number.isFinite(d.createdAt) && Number.isFinite(d.expiresAt) && d.expiresAt > now() &&
				d.expiresAt <= d.createdAt + SESSION_TTL) : [] };
	} catch (error) { if (error.code !== "ENOENT") throw new Error("Remote access settings could not be read."); }
	let server = null, origin = null, pairing = null, error = null;
	let attemptWindow = 0, attempts = 0;
	let serial = Promise.resolve();
	const active = new Set();
	const sockets = new Set();
	const status = () => ({ available: true, enabled: !!server && !!origin, url: origin, error,
		devices: saved.devices.filter((d) => d.expiresAt > now()).map(({ id, label, createdAt, expiresAt }) => ({ id, label, createdAt, expiresAt })) });
	const changed = () => onChange(status());
	const syncDirectory = () => {
		if (process.platform === "win32") return;
		const fd = storage.openSync(path.dirname(statePath), "r");
		try { storage.fsyncSync(fd); } finally { storage.closeSync(fd); }
	};
	const persist = () => {
		storage.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
		const temporary = `${statePath}.${randomUUID()}.tmp`;
		let fd;
		try {
			fd = storage.openSync(temporary, "wx", 0o600);
			// Only non-reversible token hashes and safe device metadata are
			// durable. Acknowledge pairing/revocation only after the commit.
			storage.writeFileSync(fd, JSON.stringify(saved));
			storage.fsyncSync(fd);
			storage.closeSync(fd);
			fd = undefined;
			storage.renameSync(temporary, statePath);
			syncDirectory();
		} finally {
			if (fd !== undefined) storage.closeSync(fd);
			try { storage.unlinkSync(temporary); } catch { /* renamed */ }
		}
	};
	const json = (res, code, body) => {
		res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(JSON.stringify(body));
	};
	const sessionFor = (req) => {
		const token = req.headers["x-learnharness-remote"];
		return typeof token === "string" && /^[\w-]{43}$/.test(token) ? saved.devices.find((d) => d.hash === hash(token) && d.expiresAt > now()) : null;
	};
	const clearActive = (id) => {
		for (const entry of active) if (!id || entry.id === id) {
			entry.request.destroy();
			entry.response.destroy();
		}
	};
	const closeListener = () => {
		pairing = null;
		origin = null;
		clearActive();
		for (const socket of sockets) socket.destroy();
		server?.close();
		server = null;
	};
	const persistenceFailure = async () => {
		// Do not leave a previous grant set ready to return after restart.
		// Unlink works on disk-full/rename failures; direct replacement also
		// covers a writable file in a directory that cannot accept renames.
		closeListener();
		saved.enabled = false;
		saved.devices = [];
		let invalidated = false;
		try { storage.unlinkSync(statePath); syncDirectory(); invalidated = true; }
		catch (cause) {
			if (cause.code === "ENOENT") invalidated = true;
			else try {
				const fd = storage.openSync(statePath, "w", 0o600);
				try { storage.writeFileSync(fd, JSON.stringify(saved)); storage.fsyncSync(fd); syncDirectory(); invalidated = true; }
				finally { storage.closeSync(fd); }
			} catch { /* The error below explicitly reports undurable revocation. */ }
		}
		await tailscale.stop().catch(() => {});
		error = invalidated
			? "Changes could not be saved. Remote access was disabled. Fix laptop storage, then enable access and pair your devices again."
			: "Access stopped, but revocation could not be saved. Previously saved devices may reconnect after restart. Repair laptop storage before restarting or enabling remote access.";
		changed();
	};
	async function handle(req, res) {
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		if (!origin || req.headers.host !== new URL(origin).host || req.headers["x-forwarded-proto"] !== "https")
			return json(res, 403, { error: "Use the private Tailscale HTTPS address." });
		if (!req.url?.startsWith("/") || req.url.startsWith("//") || /[\\\r\n]/.test(req.url)) return json(res, 400, { error: "Invalid request path." });
		const url = new URL(req.url, origin);
		if (url.pathname === "/_lh/remote/sw.js" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
			return res.end(remoteWorker);
		}
		const unsafe = !["GET", "HEAD"].includes(req.method);
		if (unsafe && (req.headers.origin !== origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")))
			return json(res, 403, { error: "Cross-origin requests are not allowed." });
		if (url.pathname === "/_lh/remote/pair" && req.method === "POST") {
			if (now() - attemptWindow > 60_000) { attempts = 0; attemptWindow = now(); }
			if (++attempts > 20) return json(res, 429, { error: "Try pairing again in a minute." });
			if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "JSON required." });
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (Buffer.byteLength(body) > 4096) return json(res, 413, { error: "Pairing request too large." });
			}
			let grant;
			try { grant = JSON.parse(body).grant; } catch { return json(res, 400, { error: "Invalid pairing request." }); }
			if (typeof grant !== "string" || grant.length !== 43 || !pairing || pairing.expiresAt <= now() || pairing.hash !== hash(grant))
				return json(res, 401, { error: "Pairing link expired or already used." });
			pairing = null;
			const token = secret();
			const agent = req.headers["user-agent"] ?? "";
			const label = /iPhone|iPad/i.test(agent) ? "iPhone / iPad" : /Android/i.test(agent) ? "Android" : "Web browser";
			const device = { id: randomUUID(), hash: hash(token), label, createdAt: now(), expiresAt: now() + SESSION_TTL };
			const previous = sessionFor(req);
			saved.devices = [...saved.devices.filter((d) => d.expiresAt > now() && d.id !== previous?.id), device];
			try { persist(); }
			catch { await persistenceFailure(); return; }
			if (previous) clearActive(previous.id);
			changed();
			return json(res, 200, { paired: true, token });
		}
		const device = sessionFor(req);
		if ((url.pathname === "/_lh/remote/pair" || !device) && ["GET", "HEAD"].includes(req.method) && !url.pathname.startsWith("/api/")) {
			const nonce = secret();
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
				"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; worker-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` });
			return res.end(req.method === "HEAD" ? "" : pairingPage(nonce));
		}
		if (!device) return json(res, 401, { error: "Pair this device from the laptop's Remote Access settings." });
		if (url.pathname === "/_lh/remote/logout" && req.method === "POST") {
			saved.devices = saved.devices.filter((d) => d.id !== device.id);
			try { persist(); }
			catch { await persistenceFailure(); return; }
			clearActive(device.id);
			changed();
			return json(res, 200, { paired: false });
		}
		if (url.pathname.startsWith("/_lh/remote/")) return json(res, 404, { error: "Unknown remote operation." });
		const headers = { ...req.headers };
		for (const name of [...hopHeaders, ...(req.headers.connection ?? "").split(",").map((v) => v.trim().toLowerCase())]) delete headers[name];
		for (const name of Object.keys(headers)) if (name.startsWith("x-learnharness-") || name.startsWith("x-forwarded-") || name === "forwarded") delete headers[name];
		headers.host = backend.host;
		delete headers.cookie;
		headers["x-forwarded-host"] = new URL(origin).host;
		headers["x-forwarded-proto"] = "https";
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) headers["x-learnharness-desktop"] = desktopSecret;
		const request = http.request(backend, { method: req.method, path: url.pathname + url.search, headers }, (response) => {
			const responseHeaders = { ...response.headers };
			for (const name of hopHeaders) delete responseHeaders[name];
			responseHeaders["cache-control"] = "no-store";
			res.writeHead(response.statusCode ?? 502, responseHeaders);
			response.pipe(res);
			response.on("error", () => res.destroy());
		});
		const entry = { id: device.id, request, response: res };
		active.add(entry);
		const expiry = setTimeout(() => { request.destroy(); res.destroy(); }, Math.min(2 ** 31 - 1, device.expiresAt - now()));
		expiry.unref();
		// Revocation and disconnect terminate both ends, including SSE subscriptions.
		res.on("close", () => { clearTimeout(expiry); active.delete(entry); request.destroy(); });
		req.on("aborted", () => request.destroy());
		request.on("error", () => { if (!res.headersSent) json(res, 502, { error: "The desktop backend is unavailable." }); else res.destroy(); });
		req.pipe(request);
	}
	const enable = async () => {
		if (server && origin) return;
		error = null;
		server = http.createServer((req, res) => void handle(req, res).catch(() => {
			if (!res.headersSent) json(res, 500, { error: "Remote request failed." }); else res.destroy();
		}));
		server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
		server.headersTimeout = 15_000;
		server.requestTimeout = 30_000;
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
			const target = `http://127.0.0.1:${server.address().port}`;
			origin = await tailscale.start(target, saved.target);
			const parsed = new URL(origin);
			if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".ts.net") || parsed.pathname !== "/" || parsed.username || parsed.password)
				throw new Error("Tailscale did not return a private HTTPS address.");
			saved.enabled = true;
			saved.target = target;
			persist();
		} catch (cause) {
			closeListener();
			await tailscale.stop().catch(() => {});
			throw cause;
		}
	};
	const control = (command) => {
		const operation = serial.then(async () => {
			try {
				switch (command?.op) {
					case "status": return status();
					case "enable": await enable(); break;
					case "disable":
						closeListener();
						saved.enabled = false;
						saved.devices = [];
						try { persist(); }
						catch { await persistenceFailure(); return status(); }
						await tailscale.stop();
						break;
					case "pair": {
						if (!origin) throw new Error("Enable remote access before pairing a device.");
						const grant = secret();
						pairing = { hash: hash(grant), expiresAt: now() + PAIR_TTL };
						return { ...status(), pairingUrl: `${origin}/_lh/remote/pair#grant=${grant}`, pairingExpiresAt: pairing.expiresAt };
					}
					case "revoke":
						if (typeof command.id !== "string") throw new Error("Choose a paired device to revoke.");
						saved.devices = saved.devices.filter((d) => d.id !== command.id);
						try { persist(); }
						catch { await persistenceFailure(); return status(); }
						clearActive(command.id);
						break;
					default: throw new Error("Unsupported remote access control.");
				}
				error = null;
			} catch (cause) { error = cause.message; }
			changed();
			return status();
		});
		serial = operation.catch(() => {});
		return operation;
	};
	return {
		control,
		status,
		restore: () => saved.enabled ? control({ op: "enable" }) : Promise.resolve(status()),
		async shutdown() { await serial; closeListener(); await tailscale.stop(); },
	};
}

module.exports = { createRemoteAccess };
