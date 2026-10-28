"use client";

/**
 * Where TTS / OpenAI dictation requests go, shared by Settings → TTS and
 * Providers → Dictation. By default OpenAI at a fixed model with the
 * OpenAI key from Providers: one status line, red with a link when that
 * key is missing. Advanced holds "Use custom endpoint" — the switch — and
 * the endpoint's Server, Model and own key, greyed until it's checked.
 * Unchecking keeps the values, so the endpoint can be switched back on.
 *
 * The custom key is a Providers-style row (masked status, read-only) that
 * turns into its inline editor on click — Save / Cancel / Delete; nothing
 * is written until Save. No key = no authentication.
 */

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { OPENAI_AUDIO_KEY_ID, type AudioEndpointSettings, type AuthKeyStatus } from "@/src/core";
import { cn } from "@/lib/utils";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { CommitInput, SettingsRow } from "./controls";
import { keyStatusLine } from "./keys-section";

const LINK = "underline-offset-2 hover:underline";
const FIELD_ROW = "flex-col items-stretch gap-2 @xl/endpoint:flex-row @xl/endpoint:items-center @xl/endpoint:gap-4";
const CONTROL = "w-full @xl/endpoint:w-64 @xl/endpoint:shrink-0";

export function AudioEndpoint({
	settings,
	defaultModel,
	customKeyId,
	onChange,
	onOpenKey,
	testid,
	openAIKeyLine = true,
}: {
	settings: AudioEndpointSettings | undefined;
	defaultModel: string;
	/** TTS_API_KEY or STT_API_KEY — the custom endpoint's own key. */
	customKeyId: string;
	onChange: (patch: AudioEndpointSettings) => void;
	/** Open Providers on a key (its paste field when it isn't saved). */
	onOpenKey: (id: string) => void;
	testid: string;
	/** false where the OpenAI key has its own row (Providers → Dictation). */
	openAIKeyLine?: boolean;
}) {
	const [keys, setKeys] = useState<AuthKeyStatus[] | null>(null);
	const [tick, setTick] = useState(0);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useSettingsSaved((section) => {
		if (section === "keys") setTick((t) => t + 1);
	});

	useEffect(() => {
		let live = true;
		void fetch("/api/keys", { cache: "no-store" })
			.then(async (res) => {
				if (!res.ok) throw new Error();
				const body = (await res.json()) as { keys: AuthKeyStatus[] };
				if (live) setKeys(body.keys);
			})
			.catch(() => live && setError("Could not load key status"));
		return () => {
			live = false;
		};
	}, [tick]);

	// Escape closes the key editor without closing the dialog (document
	// capture phase, the Providers editor's pattern).
	useEffect(() => {
		if (!editing) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setEditing(false);
			setDraft("");
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [editing]);

	const custom = settings?.customEndpoint ?? false;
	const status = (id: string) => keys?.find((k) => k.id === id);
	const openaiMissing = keys !== null && !status(OPENAI_AUDIO_KEY_ID)?.present;
	const customKey = status(customKeyId);
	const envOwned = customKey?.source === "env";

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

	return (
		<div data-testid={testid} className="@container/endpoint flex flex-col gap-3">
			{!custom && openAIKeyLine && (
				<SettingsRow
					label="API key"
					testid={`${testid}-openai`}
					hint={openaiMissing ? (
						<button type="button" data-testid={`${testid}-openai-missing`} onClick={() => onOpenKey(OPENAI_AUDIO_KEY_ID)} className={`text-left text-destructive ${LINK}`}>
							No OpenAI API key · Add in Providers →
						</button>
					) : (
						"Uses your OpenAI key from Providers"
					)}
				>
					{null}
				</SettingsRow>
			)}
			<details className="group" data-testid={`${testid}-advanced`}>
				<summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
					<ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open:rotate-90" />
					Advanced
				</summary>
				{/* A left rule, not a top border: top borders separate whole groups. */}
				<div className="mt-2 ml-1.5 flex flex-col gap-3 border-l border-border/60 pl-4">
					<label className="flex cursor-pointer items-center gap-2.5 py-1">
						<input
							type="checkbox"
							data-testid={`${testid}-custom`}
							checked={custom}
							onChange={(e) => onChange({ ...settings, customEndpoint: e.currentTarget.checked })}
							className="size-4 shrink-0 accent-primary"
						/>
						<span className="font-prose text-(length:--lh-prose-size)">Use custom endpoint</span>
					</label>
					<SettingsRow
						label="Server"
						hint={custom && !settings?.baseUrl
							? <span className="text-destructive">Required — OpenAI-compatible base URL, e.g. …/v1</span>
							: "OpenAI-compatible base URL, version segment included"}
						dimmed={!custom}
						className={FIELD_ROW}
					>
						<CommitInput
							value={settings?.baseUrl ?? ""}
							placeholder="http://127.0.0.1:8000/v1"
							ariaLabel="custom endpoint server URL"
							testid={`${testid}-base-url`}
							disabled={!custom}
							className={CONTROL}
							onCommit={(baseUrl) => onChange({ ...settings, baseUrl: baseUrl || undefined })}
						/>
					</SettingsRow>
					<SettingsRow label="Model" hint="Blank uses the default" dimmed={!custom} className={FIELD_ROW}>
						<CommitInput
							value={settings?.model ?? ""}
							placeholder={defaultModel}
							ariaLabel="custom endpoint model"
							testid={`${testid}-model`}
							disabled={!custom}
							className={CONTROL}
							onCommit={(model) => onChange({ ...settings, model: model || undefined })}
						/>
					</SettingsRow>
					<div className={cn("flex flex-col gap-1.5", !custom && "pointer-events-none opacity-40")}>
						<SettingsRow
							label="API key"
							hint={envOwned ? "Set by the environment" : customKey?.present ? "Sent only to this server" : "Optional — no key is sent when unset"}
						>
							{null}
						</SettingsRow>
						{editing && !envOwned ? (
							<div className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-key-editor`}>
								<input
									type="password"
									value={draft}
									onChange={(e) => setDraft(e.currentTarget.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && draft.trim()) void writeKey(draft.trim());
									}}
									placeholder="Paste key…"
									aria-label="Custom endpoint API key"
									data-testid={`${testid}-key-input`}
									disabled={busy}
									autoFocus
									autoComplete="off"
									spellCheck={false}
									className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
								/>
								<button type="button" data-testid={`${testid}-key-save`} disabled={busy || !draft.trim()} onClick={() => void writeKey(draft.trim())}
									className={`shrink-0 text-xs text-foreground ${LINK} disabled:text-muted-foreground/40 disabled:no-underline`}>
									Save
								</button>
								<button type="button" data-testid={`${testid}-key-cancel`} disabled={busy} onClick={() => { setEditing(false); setDraft(""); setError(null); }}
									className={`shrink-0 text-xs text-muted-foreground/70 hover:text-foreground ${LINK}`}>
									Cancel
								</button>
								{customKey?.present && customKey.source === "file" && (
									<button type="button" data-testid={`${testid}-key-delete`} disabled={busy} onClick={() => void writeKey(null)}
										className={`shrink-0 text-xs text-muted-foreground/70 hover:text-red-500 ${LINK}`}>
										Delete
									</button>
								)}
							</div>
						) : (
							<button
								type="button"
								aria-expanded={false}
								data-testid={`${testid}-key-row`}
								disabled={!custom || envOwned || keys === null}
								onClick={() => { setEditing(true); setDraft(""); setError(null); }}
								className={cn(
									"flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left",
									envOwned ? "cursor-default opacity-40" : "cursor-pointer transition-colors hover:bg-accent/50",
								)}
							>
								<span className="font-ui text-xs text-foreground">Key</span>
								<span data-testid={`${testid}-key-status`} className="font-mono text-[11px] text-muted-foreground">
									{customKey?.present ? keyStatusLine(customKey) : "not set"}
								</span>
							</button>
						)}
					</div>
					{error && <p role="alert" data-testid={`${testid}-error`} className="text-xs text-red-500">{error}</p>}
				</div>
			</details>
		</div>
	);
}
