"use client";

/**
 * Settings → TTS (listen wave, 2026-10-26): the text-to-speech the
 * session's listen affordances read through. Listening is opt-in, and so
 * is reading on from the transcript into the dock's question, and
 * autoplaying replies. The provider (OpenAI, or the TTS custom endpoint)
 * is chosen in Providers → TTS; this page names it and links there.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSettings, type SpeechSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";
import { CommitInput, SettingsRow, Toggle } from "./controls";

/** GET /api/tts/openai's readiness fields this page reads. */
interface SpeechReadiness {
	configured: boolean;
	keyPresent: boolean;
	custom: boolean;
	baseUrl: string | null;
	model: string | null;
}

const SAMPLE = "This is how LearnHarness will read to you.";
// Follow the content pane's width: the settings sidebar also takes space
// at tablet sizes, so a viewport breakpoint alone would still crowd fields.
const FIELD_ROW = "flex-col items-stretch gap-2 @xl/speech:flex-row @xl/speech:items-center @xl/speech:gap-4";

export function SpeechSection({
	speech,
	onSectionChange,
	onOpenProviders,
}: {
	speech: SpeechSettings | undefined;
	onSectionChange: (next: SpeechSettings) => void;
	/** Open Providers (its TTS group holds the provider and endpoint). */
	onOpenProviders: () => void;
}) {
	const resolved = resolveSettings(speech === undefined ? null : { version: 1, speech }).speech;
	const [status, setStatus] = useState<SpeechReadiness | null>(null);
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
				.catch(() => null)) as Partial<SpeechReadiness> | null;
			if (!live) return;
			setStatus(response ? {
				configured: response.configured === true,
				keyPresent: response.keyPresent === true,
				custom: response.custom === true,
				baseUrl: response.baseUrl ?? null,
				model: response.model ?? null,
			} : null);
		})();
		return () => {
			live = false;
		};
	}, [tick, resolved.enabled]);

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

	const custom = speech?.provider === "custom";
	const problem = status === null ? null
		: !custom ? (status.keyPresent ? null : "No OpenAI API key")
		: !status.baseUrl ? "No custom endpoint connected"
		: !status.model ? "No model chosen"
		: !status.keyPresent ? "The endpoint needs reconnecting"
		: null;

	return (
		<div className="@container/speech flex flex-col gap-3">
			<SettingsRow
				label="Provider"
				testid="speech-row-provider"
				hint={<>
					{problem && <span data-testid="speech-provider-problem" className="text-destructive">{problem} · </span>}
					<button type="button" data-testid="speech-open-providers" onClick={onOpenProviders} className="text-left underline-offset-2 hover:underline">
						Change in Providers →
					</button>
				</>}
			>
				<span data-testid="speech-provider" className="font-ui text-xs text-muted-foreground">
					{custom ? `Custom endpoint${speech?.customModel ? ` · ${speech.customModel}` : ""}` : "OpenAI"}
				</span>
			</SettingsRow>
			<SettingsRow label="Listening" hint="Show reading controls" testid="speech-row-enabled">
				<Toggle
					checked={speech?.enabled ?? status?.configured ?? false}
					disabled={status === null}
					onChange={(enabled) => onSectionChange({ ...speech, enabled })}
					label="Listening"
				/>
			</SettingsRow>
			<SettingsRow label="Read the question" hint="Read from here continues into the open question or problem" testid="speech-row-read-question">
				<Toggle
					checked={speech?.readQuestion ?? false}
					onChange={(readQuestion) => onSectionChange({ ...speech, readQuestion })}
					label="Read the question"
				/>
			</SettingsRow>
			<SettingsRow label="Autoplay replies" hint="Read the agent's reply aloud as it arrives, for turns you start" testid="speech-row-autoplay">
				<Toggle
					checked={speech?.autoplay ?? false}
					onChange={(autoplay) => onSectionChange({ ...speech, autoplay })}
					label="Autoplay replies"
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
					onCommit={(voice) => onSectionChange({ ...speech, voice: voice || undefined })}
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
		</div>
	);
}
