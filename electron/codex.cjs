"use strict";

// Main-process-only adapter around Pi's public Codex OAuth provider. Tokens
// never cross renderer IPC/HTTP and never share a file with Pi or the Codex CLI.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const CHANNEL = "lh:codex";
const ERROR = "Codex connection failed. Try signing in again; no API-key fallback was used.";
const validCredential = (c) => c?.type === "oauth" && typeof c.access === "string" && !!c.access && !c.access.startsWith("sk-") && typeof c.refresh === "string" && !!c.refresh && Number.isFinite(c.expires) && typeof c.accountId === "string" && !!c.accountId;

function codexFileStore(file) {
	return {
		async read() {
			try {
				const record = JSON.parse(await fs.readFile(file, "utf8"));
				if (record.version !== 1 || (record.credential !== null && !validCredential(record.credential))) throw new Error("Invalid Codex credentials");
				return record.credential;
			} catch (error) { if (error.code === "ENOENT") return null; throw new Error("Codex credential storage is unavailable."); }
		},
		async write(credential) {
			if (credential !== null && !validCredential(credential)) throw new Error("Invalid Codex credentials");
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			const temp = `${file}.${randomUUID()}.tmp`;
			try {
				const handle = await fs.open(temp, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify({ version: 1, credential }) + "\n"); await handle.sync(); }
				finally { await handle.close(); }
				await fs.rename(temp, file);
			} finally { await fs.unlink(temp).catch(() => {}); }
		},
	};
}

function createCodex({ store, loadOAuth, openExternal, onChange = () => {}, timeoutMs = 180000 }) {
	let credential = null;
	let loaded;
	let pending = null;
	let manual = null;
	let error = null;
	let closed = false;
	let denied = false;
	let epoch = 0;
	let queue = Promise.resolve();
	const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
	const snapshot = () => ({ available: !closed && !denied, pending: !!pending, connected: !closed && !denied && !!credential, manualCode: !!manual, error });
	const state = () => ({ status: snapshot(), epoch });
	const notify = () => onChange({ channel: CHANNEL, kind: "state", ...state() });
	async function ready() {
		if (!loaded) loaded = store.read().then((value) => { credential = value; }).catch(() => { denied = true; error = "Codex credentials could not be read. Check local file access before reconnecting."; });
		await loaded;
	}
	async function save(value) {
		try { await store.write(value); credential = value; }
		catch { denied = true; epoch++; error = "Codex credentials could not be saved. No request was sent; check local file access."; notify(); throw new Error(ERROR); }
	}
	function cancelLogin() {
		if (pending) { pending.abort(); pending = null; manual = null; notify(); }
		return snapshot();
	}
	async function login() {
		await ready();
		if (closed || denied || pending) return snapshot();
		const controller = new AbortController();
		pending = controller; error = null; notify();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		void (async () => {
			try {
				const oauth = await loadOAuth();
				const result = await oauth.login({
					signal: controller.signal,
					prompt: async (prompt) => {
						if (prompt.type === "select") return "browser";
						if (prompt.type !== "manual_code") throw new Error(ERROR);
						return new Promise((resolve, reject) => {
							const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
							const finish = (value) => { signal.removeEventListener("abort", abort); if (manual?.finish === finish) manual = null; notify(); resolve(value); };
							const abort = () => { signal.removeEventListener("abort", abort); if (manual?.finish === finish) manual = null; notify(); reject(new Error("cancelled")); };
							manual = { finish };
							if (signal.aborted) abort(); else { signal.addEventListener("abort", abort, { once: true }); notify(); }
						});
					},
					notify: (event) => {
						if (event.type !== "auth_url" || controller.signal.aborted) return;
						const url = new URL(event.url);
						if (url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize" || url.username || url.password) throw new Error(ERROR);
						void Promise.resolve().then(() => openExternal(url.href)).catch(() => { error = "Could not open OpenAI sign-in in your browser."; controller.abort(); });
					},
				}, { agentName: "learnharness" });
				await serial(async () => {
					if (closed || controller.signal.aborted || pending !== controller || !validCredential(result)) throw new Error(ERROR);
					const previous = credential;
					await save(result);
					if (closed || controller.signal.aborted || pending !== controller) { await save(previous); return; }
					epoch++;
				});
			} catch { if (pending === controller) error = error || (controller.signal.aborted ? "Codex sign-in cancelled or timed out." : ERROR); }
			finally { clearTimeout(timer); if (pending === controller) { pending = null; manual = null; notify(); } }
		})();
		return snapshot();
	}
	async function lease(expectedEpoch) {
		await ready();
		return serial(async () => {
			if (closed || denied || !credential || expectedEpoch !== epoch) throw new Error(ERROR);
			const admitted = epoch;
			if (credential.expires <= Date.now() + 60000) {
				try {
					const next = await (await loadOAuth()).refresh(credential, AbortSignal.timeout(15000));
					if (!validCredential(next)) throw new Error(ERROR);
					await save(next);
				} catch { error = ERROR; notify(); throw new Error(ERROR); }
			}
			if (closed || denied || admitted !== epoch) throw new Error(ERROR);
			return { accessToken: credential.access, epoch };
		});
	}
	async function disconnect() {
		await ready(); cancelLogin(); epoch++; error = null; notify();
		await serial(async () => { await save(null); });
		notify(); return snapshot();
	}
	return {
		async status() { await ready(); return state(); }, login, cancelLogin, lease, disconnect,
		submit(value) { if (manual && typeof value === "string" && value.length <= 8192) manual.finish(value); return snapshot(); },
		close() { closed = true; epoch++; cancelLogin(); notify(); },
	};
}

function attachCodexChild(child, connection) {
	const send = (value) => { if (child.connected) child.send({ channel: CHANNEL, ...value }, () => {}); };
	const listener = async (message) => {
		if (message?.channel !== CHANNEL || typeof message.id !== "string" || message.id.length > 100) return;
		try {
			const value = message.op === "status" ? await connection.status() : message.op === "lease" && Number.isSafeInteger(message.epoch) ? await connection.lease(message.epoch) : null;
			if (!value) throw new Error(ERROR);
			send({ id: message.id, ok: true, value });
		} catch { send({ id: message.id, ok: false, error: ERROR }); }
	};
	child.on("message", listener);
	return { send, dispose: () => child.removeListener("message", listener) };
}
async function codexControl(command, connection) {
	try {
		if (command?.op === "status") return (await connection.status()).status;
		if (command?.op === "login") return await connection.login();
		if (command?.op === "cancel") return connection.cancelLogin();
		if (command?.op === "submit" && typeof command.value === "string") return connection.submit(command.value);
		if (command?.op === "disconnect") return await connection.disconnect();
	} catch { return { error: ERROR }; }
	return { error: "Unsupported Codex control." };
}
module.exports = { codexFileStore, createCodex, attachCodexChild, codexControl };
