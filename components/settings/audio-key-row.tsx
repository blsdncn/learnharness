"use client";

/**
 * The API-key row shared by Settings → TTS and → Dictation (OpenAI-
 * compatible), on two rows: "API key" with a Provider | Custom switch,
 * then that source's key full width — flipping swaps only the second row.
 *
 * Provider: a picker over the provider keys saved in Providers, with
 * OpenAI (the default) always listed. Keys are referenced by env var,
 * never copied. A missing selected key turns red and its hint deep-links
 * Providers with that provider's paste field open.
 *
 * Custom: the section's own key as a Providers-style key row (masked
 * status, read-only). Clicking turns that row into its inline editor —
 * Save / Cancel / Delete; nothing is written until Save. No key = no
 * authentication.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { CUSTOM_AUDIO_KEY, DEFAULT_AUDIO_KEY_SOURCE, type AuthKeyStatus } from "@/src/core";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { SettingsRow } from "./controls";
import { keyStatusLine, type ProviderKeyInfo } from "./keys-section";
import { ProviderMenuList } from "./model-menu";

const OPENAI: ProviderKeyInfo = { id: "openai", envVar: DEFAULT_AUDIO_KEY_SOURCE, label: "OpenAI" };
const LINK = "underline-offset-2 hover:underline";

export function AudioKeyRow({
	keySource,
	customKeyId,
	onKeySourceChange,
	onOpenKey,
	testid,
}: {
	keySource: string;
	/** TTS_API_KEY or STT_API_KEY — the section's own custom key. */
	customKeyId: string;
	onKeySourceChange: (source: string) => void;
	/** Open Providers on this key (its paste field when it isn't saved). */
	onOpenKey: (id: string) => void;
	testid: string;
}) {
	const [keys, setKeys] = useState<AuthKeyStatus[] | null>(null);
	const [providers, setProviders] = useState<ProviderKeyInfo[]>([]);
	const [tick, setTick] = useState(0);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);
	/** Switching back to Provider restores the last pick (this mount only). */
	const lastProvider = useRef(keySource === CUSTOM_AUDIO_KEY ? DEFAULT_AUDIO_KEY_SOURCE : keySource);
	if (keySource !== CUSTOM_AUDIO_KEY) lastProvider.current = keySource;
	useSettingsSaved((section) => {
		if (section === "keys") setTick((t) => t + 1);
	});

	useEffect(() => {
		let live = true;
		void fetch("/api/keys", { cache: "no-store" })
			.then(async (res) => {
				if (!res.ok) throw new Error();
				const body = (await res.json()) as { keys: AuthKeyStatus[]; providers?: ProviderKeyInfo[] };
				if (!live) return;
				setKeys(body.keys);
				setProviders(body.providers ?? []);
			})
			.catch(() => live && setError("Could not load key status"));
		return () => {
			live = false;
		};
	}, [tick]);

	// Escape closes the picker or the editor without closing the dialog
	// (document capture phase, the Providers editor's pattern).
	useEffect(() => {
		if (!open && !editing) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
			setEditing(false);
			setDraft("");
		};
		if (open) document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, editing]);

	const custom = keySource === CUSTOM_AUDIO_KEY;
	const status = (id: string) => keys?.find((k) => k.id === id);
	const customKey = status(customKeyId);
	const envOwned = customKey?.source === "env";
	const catalog = providers.some((p) => p.envVar === OPENAI.envVar) ? providers : [OPENAI, ...providers];
	// One entry per env var (Moonshot / Moonshot CN share one key): saved
	// keys, plus OpenAI always, so the default can be picked again.
	const choices = catalog.filter(
		(p, i) =>
			catalog.findIndex((q) => q.envVar === p.envVar) === i &&
			(p.envVar === OPENAI.envVar || status(p.envVar)?.present),
	);
	const labelOf = (envVar: string) => catalog.find((p) => p.envVar === envVar)?.label ?? envVar;
	const missing = !custom && keys !== null && !status(keySource)?.present;
	const preview = (id: string) => {
		const s = status(id);
		return s?.present ? keyStatusLine(s) : "not set";
	};

	const choose = (source: string) => {
		setOpen(false);
		setEditing(false);
		setDraft("");
		setError(null);
		if (source !== keySource) onKeySourceChange(source);
	};

	const writeKey = async (value: string | null) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/keys/${customKeyId}`, value === null
				? { method: "DELETE" }
				: { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
			const body = (await res.json().catch(() => ({}))) as { status?: AuthKeyStatus; error?: string };
			if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
			setKeys((current) => [
				...(current ?? []).filter((k) => k.id !== customKeyId),
				...(body.status ? [body.status] : []),
			]);
			setEditing(false);
			setDraft("");
			notifySettingsSaved("keys");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not save the key");
		} finally {
			setBusy(false);
		}
	};

	const hint = custom ? (
		envOwned ? "Set by the environment" : customKey?.present ? "Your own key for this server" : "Optional — no key is sent when unset"
	) : missing ? (
		<button type="button" data-testid={`${testid}-missing`} onClick={() => onOpenKey(keySource)} className={`text-left text-destructive ${LINK}`}>
			No {labelOf(keySource)} API key · Add in Providers →
		</button>
	) : (
		`Uses your ${labelOf(keySource)} key from Providers`
	);

	const segment = (value: "provider" | "custom", label: string) => {
		const active = value === "custom" ? custom : !custom;
		return (
			<button
				type="button"
				role="radio"
				aria-checked={active}
				data-testid={`${testid}-source-${value}`}
				disabled={busy}
				onClick={() => !active && choose(value === "custom" ? CUSTOM_AUDIO_KEY : lastProvider.current)}
				className={cn(
					"h-6 rounded-[3px] px-2 font-ui text-xs transition-colors",
					active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
				)}
			>
				{label}
			</button>
		);
	};

	// Row 1: label, hint, switch. Row 2 (full width): the source's key —
	// the provider picker, or a Providers-style custom key row that turns
	// into its own inline editor. Flipping the switch swaps row 2 only.
	return (
		<div data-testid={testid} className="flex flex-col gap-1.5">
			<SettingsRow label="API key" hint={hint}>
				<div role="radiogroup" aria-label="API key source" className="flex h-7 shrink-0 items-center rounded-sm border border-border/60 bg-muted/30 p-0.5">
					{segment("provider", "Provider")}
					{segment("custom", "Custom")}
				</div>
			</SettingsRow>
			<div ref={anchorRef} className="relative min-w-0">
				{!custom ? (
					<button
						type="button"
						aria-haspopup="listbox"
						aria-expanded={open}
						aria-invalid={missing || undefined}
						data-testid={`${testid}-provider`}
						title={missing ? `No ${labelOf(keySource)} API key configured` : undefined}
						disabled={keys === null}
						onClick={() => setOpen((v) => !v)}
						className={cn(
							"flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-sm border bg-background px-1.5 font-ui text-xs",
							missing ? "border-destructive text-destructive" : "border-border text-foreground",
						)}
					>
						<span className="truncate">{labelOf(keySource)}</span>
						<span className="flex shrink-0 items-center gap-2">
							<span className={cn("font-mono text-[11px]", missing ? "text-destructive" : "text-muted-foreground")}>{preview(keySource)}</span>
							<ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
						</span>
					</button>
				) : editing && !envOwned ? (
					<div className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
						<span className="shrink-0 font-ui text-xs text-foreground">Custom key</span>
						<input
							type="password"
							value={draft}
							onChange={(e) => setDraft(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && draft.trim()) void writeKey(draft.trim());
							}}
							placeholder="Paste key…"
							aria-label="Custom API key"
							data-testid={`${testid}-input`}
							disabled={busy}
							autoFocus
							autoComplete="off"
							spellCheck={false}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
						/>
						<button type="button" data-testid={`${testid}-save`} disabled={busy || !draft.trim()} onClick={() => void writeKey(draft.trim())}
							className={`shrink-0 text-xs text-foreground ${LINK} disabled:text-muted-foreground/40 disabled:no-underline`}>
							Save
						</button>
						<button type="button" data-testid={`${testid}-cancel`} disabled={busy} onClick={() => { setEditing(false); setDraft(""); setError(null); }}
							className={`shrink-0 text-xs text-muted-foreground/70 hover:text-foreground ${LINK}`}>
							Cancel
						</button>
						{customKey?.present && customKey.source === "file" && (
							<button type="button" data-testid={`${testid}-delete`} disabled={busy} onClick={() => void writeKey(null)}
								className={`shrink-0 text-xs text-muted-foreground/70 hover:text-red-500 ${LINK}`}>
								Delete
							</button>
						)}
					</div>
				) : (
					<button
						type="button"
						aria-expanded={false}
						data-testid={`${testid}-custom`}
						disabled={envOwned || keys === null}
						onClick={() => { setEditing(true); setDraft(""); setError(null); }}
						className={cn(
							"flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left",
							envOwned ? "cursor-default opacity-40" : "cursor-pointer transition-colors hover:bg-accent/50",
						)}
					>
						<span className="font-ui text-xs text-foreground">Custom key</span>
						<span data-testid={`${testid}-custom-status`} className="font-mono text-[11px] text-muted-foreground">
							{customKey?.present ? keyStatusLine(customKey) : "not set"}
						</span>
					</button>
				)}
				{open && !custom && (
					<MenuShell
						anchorRef={anchorRef}
						testid={`${testid}-menu`}
						preferredSide="down"
						align="left"
						menuClass="flex w-72 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
					>
						<ProviderMenuList providers={choices} detail={(p) => preview(p.envVar)} onPick={(p) => choose(p.envVar)} />
					</MenuShell>
				)}
			</div>
			{error && <p role="alert" data-testid={`${testid}-error`} className="text-xs text-red-500">{error}</p>}
		</div>
	);
}
