"use client";

/**
 * Settings → Speech (listen wave, 2026-10-26): the OpenAI-compatible
 * text-to-speech endpoint the session's listen affordances read through.
 * Listening is opt-in. The key row picks a saved provider key (default
 * OpenAI) or a custom inline key; server and model sit under Advanced
 * (the model picker lists the server's /models).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { resolveSettings, type SpeechSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";
import { CommitInput, SettingsRow, Toggle } from "./controls";
import { AudioKeyRow } from "./audio-key-row";
import { ModelCombobox } from "./model-combobox";

const SAMPLE = "This is how LearnHarness will read to you.";
// Follow the content pane's width: the settings sidebar also takes space
// at tablet sizes, so a viewport breakpoint alone would still crowd fields.
const FIELD_ROW = "flex-col items-stretch gap-2 @xl/speech:flex-row @xl/speech:items-center @xl/speech:gap-4";

export function SpeechSection({
	speech,
	onSectionChange,
	onOpenKey,
}: {
	speech: SpeechSettings | undefined;
	onSectionChange: (next: SpeechSettings) => void;
	/** Open Providers on a key (its paste field when unsaved). */
	onOpenKey: (id: string) => void;
}) {
	const resolved = resolveSettings(speech === undefined ? null : { version: 1, speech }).speech;
	const [status, setStatus] = useState<{ configured: boolean } | null>(null);
	const sample = useRef<{ abort: AbortController; audio?: HTMLAudioElement; url?: string } | null>(null);
	const [tick, setTick] = useState(0);
	const [test, setTest] = useState<{ state: "idle" | "loading" | "playing" } | { state: "error"; message: string }>({
		state: "idle",
	});
	useSettingsSaved((section) => {
		if (section === "keys" || section === "speech") setTick((t) => t + 1);
	});

	useEffect(() => {
		let live = true;
		void (async () => {
			const response = (await fetch("/api/tts/openai")
				.then((r) => r.ok ? r.json() : null)
				.catch(() => null)) as { configured?: boolean } | null;
			if (!live) return;
			setStatus(response ? { configured: response.configured === true } : null);
		})();
		return () => {
			live = false;
		};
	}, [tick, resolved.baseUrl, resolved.enabled]);

	const stopSample = useCallback(() => {
		const current = sample.current;
		sample.current = null;
		current?.abort.abort();
		current?.audio?.pause();
		if (current?.url) URL.revokeObjectURL(current.url);
	}, []);
	useEffect(() => stopSample, [stopSample]);
	useEffect(() => {
		if (status?.configured === false) {
			stopSample();
			setTest({ state: "idle" });
		}
	}, [status?.configured, stopSample]);

	const playSample = async () => {
		stopSample();
		const current = { abort: new AbortController() } as NonNullable<typeof sample.current>;
		sample.current = current;
		setTest({ state: "loading" });
		try {
			const res = await fetch("/api/tts/openai", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ parts: [{ text: SAMPLE }] }),
				signal: current.abort.signal,
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(detail?.message ?? `HTTP ${res.status}`);
			}
			const blob = await res.blob();
			if (sample.current !== current) return;
			current.url = URL.createObjectURL(blob);
			const audio = current.audio = new Audio(current.url);
			audio.addEventListener("ended", () => {
				if (sample.current !== current) return;
				stopSample();
				setTest({ state: "idle" });
			});
			audio.addEventListener("error", () => {
				if (sample.current !== current) return;
				stopSample();
				setTest({ state: "error", message: "Could not play speech audio" });
			});
			await audio.play();
			if (sample.current === current) setTest({ state: "playing" });
		} catch (error) {
			if (sample.current !== current) return;
			stopSample();
			setTest({ state: "error", message: (error as Error).message });
		}
	};

	const commit = (key: "baseUrl" | "model" | "voice") => (value: string) => onSectionChange({ ...speech, [key]: value || undefined });

	return (
		<div className="@container/speech flex flex-col gap-3">
			<SettingsRow label="Listening" hint="Show reading controls" testid="speech-row-enabled">
				<Toggle
					checked={speech?.enabled ?? status?.configured ?? false}
					disabled={status === null}
					onChange={(enabled) => onSectionChange({ ...speech, enabled })}
					label="Listening"
				/>
			</SettingsRow>
			<SettingsRow
				label="Voice"
				hint="The server's voice id"
				testid="speech-row-voice"
				className={FIELD_ROW}
			>
				<CommitInput
					value={speech?.voice ?? ""}
					placeholder={resolved.voice}
					ariaLabel="speech voice"
					testid="input-speech-voice"
					className="w-full @xl/speech:w-40 @xl/speech:shrink-0"
					onCommit={commit("voice")}
				/>
			</SettingsRow>
			<SettingsRow
				label="Test"
				hint={test.state === "error" ? <span className="text-destructive">{test.message}</span> : `“${SAMPLE}”`}
				testid="speech-row-test"
				dimmed={!status?.configured}
				className={FIELD_ROW}
			>
				<button
					type="button"
					data-testid="speech-test"
					disabled={!status?.configured || test.state === "loading" || test.state === "playing"}
					onClick={() => void playSample()}
					className="h-7 shrink-0 self-start whitespace-nowrap rounded-sm border border-border px-2 font-ui text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed @xl/speech:self-auto"
				>
					{test.state === "loading" ? "Loading…" : test.state === "playing" ? "Playing…" : "Play sample"}
				</button>
			</SettingsRow>
			<AudioKeyRow
				keySource={resolved.keySource}
				customKeyId="TTS_API_KEY"
				onKeySourceChange={(keySource) => onSectionChange({ ...speech, keySource })}
				onOpenKey={onOpenKey}
				testid="speech-row-key"
			/>
			<details className="group border-t border-border/60 pt-3" data-testid="speech-advanced-connection">
				<summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
					<ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open:rotate-90" />
					Advanced connection
				</summary>
				<div className="mt-3 flex flex-col gap-3">
					<SettingsRow label="Server" hint="OpenAI-compatible base URL, version segment included" testid="speech-row-base-url" className={FIELD_ROW}>
						<CommitInput
							value={speech?.baseUrl ?? ""}
							placeholder={resolved.baseUrl}
							ariaLabel="speech server base URL"
							testid="input-speech-base-url"
							wide
							className="w-full @xl/speech:w-64 @xl/speech:shrink-0"
							onCommit={commit("baseUrl")}
						/>
					</SettingsRow>
					<SettingsRow label="Model" testid="speech-row-model" className={FIELD_ROW}>
						<ModelCombobox
							value={speech?.model ?? ""}
							defaultModel={resolveSettings(null).speech.model}
							endpoint="/api/tts/openai/models"
							section="speech"
							ariaLabel="speech model"
							testid="input-speech-model"
							className="w-full @xl/speech:w-64 @xl/speech:shrink-0"
							onCommit={commit("model")}
						/>
					</SettingsRow>
				</div>
			</details>
		</div>
	);
}
