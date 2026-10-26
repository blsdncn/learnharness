"use client";

import { useEffect, useRef, useState } from "react";
import type { RemoteAccessStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./controls.tsx";

const unavailable: RemoteAccessStatus = { available: false, enabled: false, url: null, error: null, devices: [] };

export function RemoteAccessSection() {
	const [status, setStatus] = useState(unavailable);
	const [busy, setBusy] = useState(false);
	const [pairing, setPairing] = useState<{ url: string; expiresAt: number } | null>(null);
	const [message, setMessage] = useState("");
	const mounted = useRef(false);
	// Request sequencing: concurrent pair/enable calls resolve in call
	// order server-side, but their responses can arrive out of order (or a
	// slow first response can land after a newer one). Only the latest
	// request may publish status/pairing — otherwise the screen can show a
	// superseded pairing link whose grant the server already replaced.
	const seq = useRef(0);
	useEffect(() => {
		mounted.current = true;
		const bridge = window.lh?.remote;
		const refresh = () => void bridge?.status().then((value) => { if (mounted.current) setStatus(value); }).catch(() => { if (mounted.current) setMessage("Remote access status could not be loaded."); });
		refresh();
		const off = bridge?.onChange(refresh);
		return () => { mounted.current = false; off?.(); };
	}, []);
	useEffect(() => {
		if (!pairing) return;
		const timeout = setTimeout(() => { setPairing(null); setMessage("Pairing link expired. Create a new link to pair another device."); }, Math.max(0, pairing.expiresAt - Date.now()));
		return () => clearTimeout(timeout);
	}, [pairing]);
	async function action(op: "enable" | "disable" | "pair" | "revoke", id?: string) {
		const bridge = window.lh?.remote;
		if (!bridge || busy) return;
		setBusy(true); setMessage("");
		if (op === "disable") setPairing(null);
		try {
			const mine = ++seq.current;
			const value = op === "revoke" ? await bridge.revoke(id!) : await bridge[op]();
			if (!mounted.current || mine !== seq.current) return;
			setStatus(value);
			if (value.pairingUrl && value.pairingExpiresAt) setPairing({ url: value.pairingUrl, expiresAt: value.pairingExpiresAt });
		} catch { if (mounted.current) setMessage("Remote access could not be changed. Try again."); }
		finally { if (mounted.current) setBusy(false); }
	}
	async function copy(value: string) {
		try { await navigator.clipboard.writeText(value); setMessage("Copied. Open the link on your phone while connected to Tailscale."); }
		catch { setMessage("Select and copy the link from the field."); }
	}
	return <SettingsSection title="Remote Access" testid="section-remote">
		<p className="font-prose text-sm text-muted-foreground">Use the full app on your phone through your private Tailscale network. Your laptop must stay awake with LearnHarness running.</p>
		{!status.available ? <p className="text-sm text-muted-foreground">Manage pairing and remote access in Settings → Remote Access on the laptop. Sign in to Codex on the laptop; connected models are available here.</p> : <>
			<p className="text-xs text-muted-foreground">Connect both devices to Tailscale and enable HTTPS certificates in your tailnet. Each device must also be paired below.</p>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="font-ui text-xs">{status.enabled ? "Private access enabled" : "Remote access off"}</span>
				<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void action(status.enabled ? "disable" : "enable")}>{busy ? "Working…" : status.enabled ? "Disable remote access" : "Enable remote access"}</Button>
			</div>
			{status.url && <label className="flex flex-col gap-2 text-xs text-muted-foreground">Private app address
				<input aria-label="Private app address" readOnly value={status.url} className="lh-input w-full min-w-0 rounded-sm border border-border bg-background p-2 text-foreground" />
			</label>}
			{status.enabled && <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void action("pair")}>Create one-time pairing link</Button>}
			{pairing && status.enabled && <div className="flex flex-col gap-2 rounded-sm border border-border p-3">
				<label className="flex flex-col gap-2 text-xs text-muted-foreground">Pairing link · expires in five minutes · keep private
					<input aria-label="One-time pairing link" readOnly value={pairing.url} className="lh-input w-full min-w-0 rounded-sm border border-border bg-background p-2 text-foreground" onFocus={(event) => event.target.select()} />
				</label>
				<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void copy(pairing.url)}>Copy pairing link</Button>
				<p className="text-xs text-muted-foreground">Creating a new link replaces the previous link. A paired device can read and change your app data and settings. Pairing is remembered across app restarts for 30 days, unless you revoke it or disable remote access.</p>
			</div>}
			<div className="mt-3 flex flex-col gap-3">
				<h3 className="font-ui text-xs uppercase tracking-wide">Paired devices</h3>
				{status.devices.length === 0 && <p className="text-xs text-muted-foreground">No paired devices.</p>}
				{status.devices.map((device) => <div key={device.id} className="flex items-center justify-between gap-3 border-t border-border py-2">
					<div className="min-w-0"><p className="font-prose text-sm">{device.label}</p><p className="text-xs text-muted-foreground">Paired {new Date(device.createdAt).toLocaleDateString()} · {device.id.slice(0, 8)}</p></div>
					<Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Revoke ${device.label} ${device.id.slice(0, 8)}`} onClick={() => void action("revoke", device.id)}>Revoke</Button>
				</div>)}
			</div>
		</>}
		{status.error && <p role="alert" className="text-sm text-red-400">{status.error}</p>}
		{message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
	</SettingsSection>;
}
