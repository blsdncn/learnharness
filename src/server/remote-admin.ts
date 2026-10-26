import { randomUUID } from "node:crypto";
import { desktopAPIAuthorized } from "./desktop-access.ts";

/**
 * Laptop-local pairing mint, callable from the desktop server child.
 *
 * Trust boundary (same as the desktop secret itself): the packaged Electron
 * shell spawns this server on loopback with a per-launch secret, and the
 * remote gateway proxies /api with that secret re-attached — so the secret
 * alone cannot tell laptop-local callers from paired phones. The Tailscale
 * gateway unconditionally stamps proxied requests with `x-forwarded-host`;
 * direct loopback callers never carry it. Minting requires a direct call.
 * Revocation and disable stay laptop-UI-only; no remote surface changes.
 */
export function isDirectDesktopCall(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
	if (!desktopAPIAuthorized(headers, env)) return false;
	if (headers.get("x-forwarded-host") || headers.get("forwarded")) return false;
	return true;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
let counter = 0;
let listening = false;

function connected(): boolean {
	return (
		process.env.LH_DESKTOP_SERVER === "1" &&
		(process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 &&
		typeof process.send === "function" &&
		process.connected === true
	);
}

function listenOnce(): void {
	if (listening) return;
	listening = true;
	process.on("message", (raw: unknown) => {
		const m = raw as { channel?: string; id?: string; op?: string; ok?: boolean; value?: unknown; error?: string } | null;
		if (!connected() || m?.channel !== "lh:remote-admin" || typeof m.id !== "string") return;
		const call = pending.get(m.id);
		if (!call) return;
		clearTimeout(call.timer);
		pending.delete(m.id);
		if (m.ok === true) call.resolve(m.value);
		else call.reject(new Error(m.error ?? "Remote pairing failed."));
	});
	process.on("disconnect", () => {
		for (const call of pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error("The desktop connection closed."));
		}
		pending.clear();
	});
}

/** Mint a one-time pairing link through the desktop shell. Laptop-local only; see above. */
export function requestRemotePair(timeoutMs = 15000): Promise<{ pairingUrl?: string; pairingExpiresAt?: number; error?: string } & Record<string, unknown>> {
	if (!connected()) return Promise.reject(new Error("Remote pairing is available only in the desktop app with a private server connection."));
	listenOnce();
	return new Promise((resolve, reject) => {
		const id = `${process.pid}:${++counter}:${randomUUID()}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("The desktop connection timed out."));
		}, timeoutMs);
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
		process.send!({ channel: "lh:remote-admin", id, op: "pair" }, (error) => {
			if (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(new Error("The desktop connection closed."));
			}
		});
	});
}
