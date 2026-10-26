"use client";

import { useEffect, useRef, useState } from "react";
import type { CodexStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";

export const CODEX_NOTICE = "Use your ChatGPT/Codex subscription, not an OpenAI API key. LearnHarness stores its own credentials in an unencrypted local file on this device and sends lesson context and tool results to OpenAI. Teaching and background work both count toward your plan limits. No API-key fallback is used.";
const empty: CodexStatus = { available: false, pending: false, connected: false, manualCode: false, error: null };
const FAILURE = "The Codex connection could not be changed. Try again.";
function isStatus(value: unknown): value is CodexStatus {
	if (!value || typeof value !== "object") return false;
	const status = value as CodexStatus;
	return [status.available, status.pending, status.connected, status.manualCode].every((field) => typeof field === "boolean") && (status.error === null || typeof status.error === "string");
}

/** The same sign-in surface is available during setup and in Providers.
 * OAuth itself lives in main; this module only sees safe status. */
export function CodexConnection() {
	const [status, setStatus] = useState(empty);
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const connected = useRef(false);
	const mounted = useRef(false);
	const sequence = useRef(0);
	const receive = useRef<(value: unknown) => void>(() => {});
	receive.current = (value) => {
		if (!mounted.current) return;
		if (!isStatus(value)) { setError(FAILURE); return; }
		setStatus(value);
		if (value.connected !== connected.current) {
			connected.current = value.connected;
			notifySettingsSaved("keys");
			if (value.connected) { setExpanded(false); setCode(""); }
		}
	};
	useEffect(() => {
		mounted.current = true;
		const bridge = window.lh?.codex;
		const refresh = async () => {
			const request = ++sequence.current;
			try {
				const value = await bridge?.status();
				if (value && mounted.current && request === sequence.current) receive.current(value);
			} catch { if (mounted.current && request === sequence.current) setError(FAILURE); }
		};
		void refresh();
		const off = bridge?.onChange(() => void refresh());
		return () => { mounted.current = false; sequence.current++; off?.(); };
	}, []);
	async function action(op: "login" | "cancel" | "disconnect" | "submit") {
		const bridge = window.lh?.codex;
		if (!bridge || busy) return;
		setBusy(true); setError(null);
		const request = ++sequence.current;
		try {
			const result = op === "submit" ? await bridge.submit(code.trim()) : await bridge[op]();
			if (!mounted.current) return;
			// A status event may overtake the login acknowledgement.
			if (request === sequence.current) receive.current(result);
			else {
				const refresh = ++sequence.current;
				const current = await bridge.status();
				if (mounted.current && refresh === sequence.current) receive.current(current);
			}
			if (op === "submit") setCode("");
		} catch { if (mounted.current) setError(FAILURE); }
		finally { if (mounted.current) setBusy(false); }
	}
	return <div className="flex flex-col gap-3 py-2" data-testid="codex-connection">
		<div className="flex flex-wrap items-center gap-3">
			<span className="font-ui text-xs text-foreground">OpenAI Codex (subscription)</span>
			{status.connected && <span className="text-xs text-muted-foreground">Connected · ChatGPT plan</span>}
			{status.connected ? <Button type="button" size="xs" variant="ghost" disabled={busy || status.pending} onClick={() => {
				if (window.confirm("Disconnect Codex? This removes LearnHarness's local credentials, not your subscription.")) void action("disconnect");
			}}>Disconnect</Button> : !expanded && !status.pending && <Button type="button" size="sm" variant="outline" disabled={!status.available || busy} onClick={() => setExpanded(true)}>Sign in with Codex subscription</Button>}
		</div>
		{(expanded || status.pending) && <div className="flex flex-col gap-3 rounded-sm border border-border p-3">
			<p className="text-xs leading-relaxed text-muted-foreground">{CODEX_NOTICE}</p>
			{status.pending ? <>
				<p role="status" className="text-xs text-foreground">Waiting for OpenAI sign-in in your browser…</p>
				{status.manualCode && <label className="flex flex-col gap-2 text-xs text-muted-foreground">If the browser cannot return to the app, paste the final redirect URL here.
					<input type="password" autoComplete="off" aria-label="Codex redirect URL" value={code} onChange={(event) => setCode(event.target.value)} className="h-8 rounded-sm border border-border bg-background px-2 text-foreground" />
					<Button type="button" size="sm" variant="outline" disabled={busy || !code.trim()} onClick={() => void action("submit")}>Complete sign-in</Button>
				</label>}
				<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void action("cancel")}>Cancel sign-in</Button>
			</> : <div className="flex gap-2">
				<Button type="button" size="sm" variant="outline" disabled={busy || !status.available} onClick={() => void action("login")}>Continue to OpenAI</Button>
				<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setExpanded(false)}>Cancel</Button>
			</div>}
		</div>}
		{!status.available && <p className="text-xs text-muted-foreground">Subscription sign-in is available in the packaged desktop app.</p>}
		{(error || status.error) && <p role="alert" className="text-xs text-red-400">{error || status.error}</p>}
	</div>;
}
