import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import { revealDockOnFocus } from "../components/focus-hygiene.ts";
import type { TurnUsage } from "../src/core/contracts.ts";

// Mobile round: the chat must never pan sideways (the plan marginalia
// sits off-viewport while invisible), the stats row compacts below sm,
// and focusing a dock field nudges the dock into view for the keyboard.
// The sideways guard lives as plain CSS in app/globals.css (the
// overflow-x-clip utility never reached the shipped stylesheet), so the
// test pins the stylesheet rule itself.

function turn(): TurnUsage {
	return {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }],
	};
}

describe("mobile chat layout", () => {
	it("the stylesheet carries a shipped sideways-pan guard", () => {
		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /overflow-x:\s*clip/, "plain CSS, not a Tailwind utility");
		assert.match(css, /div\[role="log"\]/, "the conversation scroller is guarded directly");
	});

	it("the stats usage summary hides below sm but stays in the markup", () => {
		const html = renderToStaticMarkup(
			<StatsBar chatId="fixture" turns={[turn()]} contextTokens={83_000} />,
		);
		assert.match(html, /max-sm:hidden/, "phones get one uncrowded row");
		assert.match(html, /data-testid="stats-summary"/, "desktop markup unchanged");
	});

	it("focusing a dock field reveals the nearest dock without jumping", () => {
		const { document } = parseHTML(`<div data-testid="question-dock"><textarea></textarea></div>`);
		const field = document.querySelector("textarea") as unknown as {
			closest: (sel: string) => { scrollIntoView: (opts: { block: string }) => void } | null;
		};
		let seen: { block: string } | null = null;
		const dock = {
			scrollIntoView: (opts: { block: string }) => { seen = opts; },
		};
		field.closest = () => dock;
		revealDockOnFocus({ currentTarget: field as unknown as EventTarget });
		assert.deepEqual(seen, { block: "nearest" });
	});

	it("the focus reveal is a no-op without DOM APIs", () => {
		assert.doesNotThrow(() => revealDockOnFocus({ currentTarget: null }));
		assert.doesNotThrow(() => revealDockOnFocus({ currentTarget: {} as EventTarget }));
	});
});
