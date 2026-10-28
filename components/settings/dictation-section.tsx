"use client";

/**
 * Settings → Dictation: Deepgram (streams while you record; its key lives
 * in Providers) or an OpenAI-compatible endpoint (transcribes on stop).
 * The OpenAI-compatible key row is shared with TTS; server and model sit
 * under Advanced connection (the model picker lists the server's /models).
 */

import { ChevronRight } from "lucide-react";
import { DEFAULT_DICTATION_MODEL, OPENAI_DICTATION_BASE_URL, resolveSettings, type DictationProvider, type DictationSettings } from "@/src/core";
import { CommitInput, SettingsRow } from "./controls";
import { AudioKeyRow } from "./audio-key-row";
import { ModelCombobox } from "./model-combobox";

const FIELD_ROW = "flex-col items-stretch gap-2 @xl/dictation:flex-row @xl/dictation:items-center @xl/dictation:gap-4";
const CONTROL = "w-full @xl/dictation:w-80 @xl/dictation:shrink-0";

export function DictationSection({ provider, dictation, onProviderChange, onConnectionChange, onOpenKey }: {
	provider: DictationProvider;
	dictation: DictationSettings | undefined;
	onProviderChange: (provider: DictationProvider) => void;
	onConnectionChange: (patch: Partial<DictationSettings>) => void;
	onOpenKey: (id: string) => void;
}) {
	const connection = resolveSettings({ version: 1, dictation }).dictation;
	return (
		<div className="@container/dictation flex flex-col gap-3">
			<SettingsRow
				label="Provider"
				hint={provider === "deepgram" ? "Streams while you record" : "Transcribes after you stop recording"}
				testid="dictation-row-provider"
				className={FIELD_ROW}
			>
				<select aria-label="Dictation provider" data-testid="dictation-provider" value={provider}
					onChange={(event) => onProviderChange(event.target.value as DictationProvider)}
					className="h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs @xl/dictation:w-48">
					<option value="deepgram">Deepgram</option>
					<option value="openai">OpenAI-compatible</option>
				</select>
			</SettingsRow>
			{provider === "deepgram" ? (
				<SettingsRow label="API key" hint="Saved in Providers" testid="dictation-row-key" className={FIELD_ROW}>
					<button type="button" onClick={() => onOpenKey("DEEPGRAM_API_KEY")} className="h-7 shrink-0 self-start whitespace-nowrap rounded-sm border border-border px-2 font-ui text-xs text-muted-foreground hover:text-foreground @xl/dictation:self-auto">Manage in Providers</button>
				</SettingsRow>
			) : (
				<>
					<AudioKeyRow
						keySource={connection.keySource}
						customKeyId="STT_API_KEY"
						onKeySourceChange={(keySource) => onConnectionChange({ keySource })}
						onOpenKey={onOpenKey}
						testid="dictation-row-key"
					/>
					<details className="group border-t border-border/60 pt-3" data-testid="dictation-advanced-connection">
						<summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
							<ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open:rotate-90" />Advanced connection
						</summary>
						<div className="mt-3 flex flex-col gap-3">
							<SettingsRow label="Server" hint="Base URL including /v1" className={FIELD_ROW}>
								<CommitInput value={dictation?.baseUrl ?? ""} placeholder={OPENAI_DICTATION_BASE_URL} ariaLabel="dictation server base URL" testid="input-dictation-base-url" className={CONTROL}
									onCommit={(baseUrl) => onConnectionChange({ baseUrl: baseUrl || undefined })} />
							</SettingsRow>
							<SettingsRow label="Model" className={FIELD_ROW}>
								<ModelCombobox value={dictation?.model ?? ""} defaultModel={DEFAULT_DICTATION_MODEL} endpoint="/api/stt/openai/models" section="dictation"
									ariaLabel="dictation model" testid="input-dictation-model" className={CONTROL} onCommit={(model) => onConnectionChange({ model: model || undefined })} />
							</SettingsRow>
						</div>
					</details>
				</>
			)}
		</div>
	);
}
