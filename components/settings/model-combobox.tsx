"use client";

/**
 * The Model field of Settings → TTS / Dictation (OpenAI-compatible): a
 * typeable field (CommitInput's commit-on-blur/Enter contract) with a
 * chevron listing the saved server's models. The list is fetched the
 * first time it opens, again after the section or a key is saved, and
 * on refresh. Every id the server returns is shown, A–Z — /models has no
 * capability field to filter on. Typing filters the open list; a server
 * without /models still takes a typed id.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved, type SettingsSection } from "@/components/settings-signal";

type ModelList =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "ready"; models: string[] }
	| { state: "error"; message: string };

export function ModelCombobox({
	value,
	defaultModel,
	endpoint,
	section,
	onCommit,
	ariaLabel,
	testid,
	className,
}: {
	/** The stored model; "" = unset (the default). */
	value: string;
	defaultModel: string;
	/** GET → {models} | {message}. */
	endpoint: string;
	/** Saving this section (or a key) makes the fetched list stale. */
	section: SettingsSection;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid: string;
	className?: string;
}) {
	const [draft, setDraft] = useState(value);
	const [editing, setEditingState] = useState(false);
	// Read by onBlur: Escape's blur() runs it before React re-renders, so
	// the rendered `editing` would still say true and save the discarded text.
	const editingRef = useRef(false);
	const setEditing = (next: boolean) => {
		editingRef.current = next;
		setEditingState(next);
	};
	const [open, setOpen] = useState(false);
	const [list, setList] = useState<ModelList>({ state: "idle" });
	const [highlight, setHighlight] = useState<number | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const request = useRef<AbortController | null>(null);
	const openRef = useRef(open);
	openRef.current = open;

	const load = () => {
		request.current?.abort();
		const abort = (request.current = new AbortController());
		setList({ state: "loading" });
		void fetch(endpoint, { cache: "no-store", signal: abort.signal })
			.then(async (res) => {
				const body = (await res.json().catch(() => ({}))) as { models?: unknown; message?: string };
				if (abort.signal.aborted) return;
				if (res.ok && Array.isArray(body.models)) setList({ state: "ready", models: body.models.filter((m): m is string => typeof m === "string") });
				else setList({ state: "error", message: body.message ?? `Could not load models (${res.status})` });
			})
			.catch(() => !abort.signal.aborted && setList({ state: "error", message: "Could not load models" }));
	};
	useEffect(() => () => request.current?.abort(), []);

	// A saved server or key changes what /models answers: drop the list,
	// and re-fetch now if it's showing.
	useSettingsSaved((saved) => {
		if (saved !== section && saved !== "keys") return;
		if (openRef.current) load();
		else {
			request.current?.abort();
			setList({ state: "idle" });
		}
	});

	const show = () => {
		setOpen(true);
		setHighlight(null);
		if (list.state === "idle") load();
	};
	const close = () => {
		setOpen(false);
		setHighlight(null);
	};

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			close();
		};
		// Escape closes the list without closing the dialog (capture phase,
		// the key row's pattern); a second Escape reverts the typed text.
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open]);

	useEffect(() => {
		if (highlight === null) return;
		listRef.current?.querySelector(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const query = editing ? draft.trim().toLowerCase() : "";
	const models = list.state === "ready" ? list.models.filter((m) => m.toLowerCase().includes(query)) : [];

	const pick = (model: string) => {
		close();
		setEditing(false);
		if (model !== value) onCommit(model);
	};

	return (
		<div
			ref={anchorRef}
			className={cn(
				"relative flex h-7 min-w-0 items-center rounded-sm border border-border bg-background focus-within:border-muted-foreground/50",
				className,
			)}
		>
			<input
				ref={inputRef}
				type="text"
				value={editing ? draft : value}
				placeholder={defaultModel}
				aria-label={ariaLabel}
				role="combobox"
				aria-expanded={open}
				aria-autocomplete="list"
				data-testid={testid}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => {
					setEditing(true);
					setDraft(e.currentTarget.value);
					setHighlight(null);
				}}
				onBlur={() => {
					if (!editingRef.current) return;
					setEditing(false);
					const next = draft.trim();
					if (next !== value) onCommit(next);
				}}
				onKeyDown={(e) => {
					if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
						e.preventDefault();
						if (models.length === 0) return;
						setHighlight((i) =>
							e.key === "ArrowDown" ? Math.min((i ?? -1) + 1, models.length - 1) : Math.max((i ?? models.length) - 1, 0),
						);
					} else if (!open && e.key === "ArrowDown") {
						e.preventDefault();
						show();
					} else if (e.key === "Enter") {
						const chosen = open && highlight !== null ? models[highlight] : undefined;
						if (chosen) pick(chosen);
						else {
							close();
							e.currentTarget.blur();
						}
					} else if (e.key === "Escape") {
						setEditing(false);
						e.currentTarget.blur();
					}
				}}
				className="h-full min-w-0 flex-1 bg-transparent px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
			/>
			<button
				type="button"
				aria-label="Show models"
				aria-haspopup="listbox"
				aria-expanded={open}
				data-testid={`${testid}-toggle`}
				// Keep focus (and any typed filter) in the field.
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => (open ? close() : show())}
				className="flex h-full shrink-0 items-center px-1.5 text-muted-foreground hover:text-foreground"
			>
				<ChevronDown aria-hidden="true" className="size-3" />
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid={`${testid}-menu`}
					preferredSide="down"
					align="right"
					autoFocus={false}
					remeasureKey={`${list.state}:${models.length}`}
					menuClass="flex w-72 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
				>
					{/* mousedown would blur the field and commit the filter text first */}
					<div onMouseDown={(e) => e.preventDefault()} className="flex flex-col">
						<div className="mb-1 flex items-center justify-between gap-2 px-2 pb-1">
							<span className="text-muted-foreground">Models on this server</span>
							<button
								type="button"
								aria-label="Refresh models"
								title="Refresh models"
								data-testid={`${testid}-refresh`}
								disabled={list.state === "loading"}
								onClick={load}
								className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<RefreshCw aria-hidden="true" className={cn("size-3", list.state === "loading" && "animate-spin")} />
							</button>
						</div>
						{list.state === "loading" || list.state === "idle" ? (
							<p className="px-2 py-3 text-center text-muted-foreground">Loading models…</p>
						) : list.state === "error" ? (
							<p role="alert" data-testid={`${testid}-error`} className="px-2 py-2 text-destructive">{list.message}</p>
						) : models.length === 0 ? (
							<p className="px-2 py-3 text-center text-muted-foreground">
								{list.models.length === 0 ? "The server listed no models." : "No models match."}
							</p>
						) : (
							<ul ref={listRef} role="listbox" aria-label="Models" data-testid={`${testid}-list`} className="flex max-h-72 flex-col overflow-y-auto px-1">
								{models.map((model, i) => (
									<li key={model}>
										<button
											type="button"
											role="option"
											aria-selected={model === (value || defaultModel)}
											data-idx={i}
											data-testid={`${testid}-option`}
											title={model}
											onClick={() => pick(model)}
											className={cn(
												"flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted",
												i === highlight && "bg-accent/40 ring-1 ring-inset ring-border",
											)}
										>
											<span className={cn("truncate font-mono text-[11px]", model === (value || defaultModel) ? "text-foreground" : "text-card-foreground")}>{model}</span>
											{model === defaultModel && <span className="shrink-0 text-[11px] text-muted-foreground">default</span>}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</MenuShell>
			)}
		</div>
	);
}
