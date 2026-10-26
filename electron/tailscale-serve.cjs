"use strict";

const { execFile } = require("node:child_process");
const PORT = 8443;

/** Own one HTTPS listener, never reset Serve or overwrite another service. */
function createTailscaleServe({ run, socket = process.env.LH_TAILSCALE_SOCKET } = {}) {
	const execute = run ?? ((args) => new Promise((resolve, reject) => {
		const env = {};
		for (const key of ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR", "LOCALAPPDATA", "SystemRoot", "WINDIR"])
			if (process.env[key]) env[key] = process.env[key];
		execFile("tailscale", [...(socket ? [`--socket=${socket}`] : []), ...args],
			{ timeout: 25_000, maxBuffer: 1024 * 1024, windowsHide: true, env },
			(error, stdout) => error ? reject(new Error("Tailscale is unavailable. Start Tailscale, sign in, and enable HTTPS certificates for your tailnet, then retry.")) : resolve(stdout));
	}));
	const configuration = async () => JSON.parse(await execute(["serve", "status", "--json"]) || "{}");
	let owned = null;
	return {
		async start(target, previousTarget) {
			const status = JSON.parse(await execute(["status", "--json"]));
			const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
			if (status.BackendState !== "Running" || !/^[a-z0-9.-]+\.ts\.net$/i.test(dnsName ?? ""))
				throw new Error("Connect this laptop to Tailscale, then enable remote access again.");
			const host = `${dnsName}:${PORT}`;
			const config = await configuration();
			const web = config.Web?.[host];
			const current = web?.Handlers?.["/"]?.Proxy;
			const sameTarget = current === target || (previousTarget && current === previousTarget);
			if (config.AllowFunnel?.[host]) throw new Error("Tailscale port 8443 has public Funnel enabled. Disable that listener or use another Tailscale service before enabling private LearnHarness access.");
			if ((web || config.TCP?.[PORT]) && (!sameTarget || Object.keys(web?.Handlers ?? {}).length !== 1))
				throw new Error("Tailscale HTTPS port 8443 already serves another app. LearnHarness left that service unchanged.");
			await execute(["serve", "--bg", `--https=${PORT}`, "--yes", target]);
			owned = { host, target };
			return `https://${host}`;
		},
		async stop() {
			if (!owned) return;
			const config = await configuration();
			if (config.Web?.[owned.host]?.Handlers?.["/"]?.Proxy === owned.target)
				await execute(["serve", `--https=${PORT}`, "--set-path=/", "off"]);
			owned = null;
		},
	};
}

module.exports = { createTailscaleServe };
