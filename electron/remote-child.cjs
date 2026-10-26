"use strict";

/**
 * Laptop-local pairing relay over the inherited Node child IPC (same
 * channel shape as chatgpt-ipc.cjs/codex.cjs — never a listening socket).
 *
 * Only `pair` is relayed: revocation and disable stay laptop-UI-only, and
 * minting stays laptop-local (see src/server/remote-admin.ts, which refuses
 * gateway-proxied callers outright). The HTTP route that feeds this relay
 * requires the per-launch desktop secret, exactly like every /api route.
 */
function attachRemoteChild(child, remoteAccess) {
	const send = (value) => {
		if (child.connected) child.send({ channel: "lh:remote-admin", ...value }, () => {});
	};
	const listener = async (message) => {
		if (!message || message.channel !== "lh:remote-admin" || typeof message.id !== "string" || message.id.length === 0 || message.id.length > 100) return;
		try {
			if (message.op !== "pair") throw new Error("Invalid private operation");
			const value = await remoteAccess.control({ op: "pair" });
			send({ id: message.id, op: message.op, ok: true, value });
		} catch (err) { send({ id: message.id, op: message.op, ok: false, error: err?.message ?? "Remote pairing failed." }); }
	};
	child.on("message", listener);
	return { send, dispose: () => child.removeListener("message", listener) };
}

module.exports = { attachRemoteChild };
