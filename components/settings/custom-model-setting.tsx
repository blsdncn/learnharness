"use client";

/**
 * The model the TTS custom endpoint uses: the endpoint's Connect
 * stores its model list (discovered + typed), and this row picks one — the
 * audio counterpart of the Strong / Cheap / Vision rows, over the same
 * searchable menu machine (SearchMenuList in the shared MenuShell).
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CustomModel } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { SettingsMenuTrigger, SettingsRow } from "./controls";
import { SearchMenuList } from "./search-menu-list";

export function CustomModelSetting({ models, value, onPick, hint, testid, ariaLabel }: {
	/** The endpoint's models; undefined while its status loads. */
	models: readonly CustomModel[] | undefined;
	value: string | undefined;
	onPick: (id: string) => void;
	hint?: ReactNode;
	/** Prefixes the row, trigger, menu and option ids. */
	testid: string;
	ariaLabel: string;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const disabled = !models?.length;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest(`[data-testid="${testid}-menu"]`)) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, testid]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};

	return <SettingsRow label="Model" hint={hint} testid={`${testid}-row`}>
		<SettingsMenuTrigger
			ref={triggerRef}
			value={value ?? "Choose a model"}
			unavailable={value === undefined}
			data-testid={testid}
			aria-label={`${ariaLabel}: ${value ?? "none"}`}
			aria-expanded={open}
			disabled={disabled}
			onKeyDown={(event) => { if (open) closeOnEscape(event); }}
			onClick={() => setOpen((v) => !v)}
			className="min-w-20 max-w-[65%]"
		/>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid={`${testid}-menu`}
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				<SearchMenuList
					items={models}
					itemKey={(m) => m.id}
					searchTerms={(m) => [m.id]}
					compare={(a, b) => a.id.localeCompare(b.id)}
					isSelected={(m) => m.id === value}
					onPick={(m) => { onPick(m.id); setOpen(false); triggerRef.current?.focus(); }}
					searchTestid={`${testid}-search`}
					listTestid={`${testid}-list`}
					optionTestid={(m) => `${testid}-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
					ariaLabel={`Search ${ariaLabel.toLowerCase()}s`}
					placeholder="Search models…"
					empty="No models match."
					renderItem={(m) => <span className="font-mono text-card-foreground">{m.id}</span>}
				/>
			</div>
		</MenuShell>}
	</SettingsRow>;
}
