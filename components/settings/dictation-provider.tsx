"use client";

/**
 * Providers → Dictation's provider choice: Deepgram (streams while you
 * record) or OpenAI (transcribes on stop — OpenAI by default, or a custom
 * endpoint under its Advanced).
 */

import type { DictationProvider } from "@/src/core";
import { SettingsRow } from "./controls";

export function DictationProviderRow({ provider, onChange }: {
	provider: DictationProvider;
	onChange: (provider: DictationProvider) => void;
}) {
	return (
		<SettingsRow
			label="Provider"
			hint={provider === "deepgram" ? "Streams while you record" : "Transcribes after you stop recording"}
			testid="dictation-row-provider"
		>
			<select aria-label="Dictation provider" data-testid="dictation-provider" value={provider}
				onChange={(event) => onChange(event.target.value as DictationProvider)}
				className="h-7 w-40 rounded-sm border border-border bg-background px-1.5 font-ui text-xs">
				<option value="deepgram">Deepgram</option>
				<option value="openai">OpenAI</option>
			</select>
		</SettingsRow>
	);
}
