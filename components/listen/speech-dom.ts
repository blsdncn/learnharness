/**
 * LISTEN BLOCKS (listen wave, 2026-10-26): which pieces of the rendered
 * page are listenable, in what order, and what they say.
 *
 * A ROOT (`data-listen-root`) bounds "read from here": the transcript is
 * one root, the dock another — playback continues through the blocks that
 * follow inside the same root. One crossing, opt-in ("Read the question",
 * Settings → TTS): reading that started in the transcript continues into
 * the dock (adjacentAcross).
 *
 * A BLOCK is the smallest reading unit (owner ruling: paragraph-level):
 * - prose: every paragraph, list item, heading, quote, or display equation
 *   rendered from markdown — the LEAF-most one, so a loose list item reads
 *   paragraph by paragraph and a paragraph holding inline math stays whole;
 * - atomic: any element marked `data-listen-block="<label>"` (card sections
 *   — the question, your answer, the correct answer…). Everything inside
 *   an atomic block is that one block; the label names it in the player.
 * - a table ROW (owner ruling: row by row, with headers): the header row
 *   reads as-is, every other row pairs each cell with its column header —
 *   "Stage: Validate. What it accomplishes: Compare…".
 * Anything under `data-listen-skip` (reasoning, the plan) is never a block,
 * nor is anything in a collapsed <details> (a tool card's details, a
 * research brief) — it isn't on screen; opened, it reads like the rest.
 *
 * What a block SAYS: its text in reading order with math as TeX (KaTeX
 * keeps the source in its MathML annotation; the server speaks it), minus
 * buttons, code blocks, and drawings.
 */

import type { SpeechPart } from "@/src/core";

export const LISTEN_ROOT_ATTR = "data-listen-root";
export const LISTEN_BLOCK_ATTR = "data-listen-block";
export const LISTEN_SKIP_ATTR = "data-listen-skip";
/** Read only by a read started inside it, even open (the research and
 *  PDF briefs); reads from elsewhere, autoplay included, pass over it. */
export const LISTEN_ASIDE_ATTR = "data-listen-aside";
/** The learner's own rows (your message, answer card, thinking): never
 *  where an autoplayed reply starts. */
export const LISTEN_YOURS_ATTR = "data-listen-yours";
/** Fired on the document as reading crosses from the transcript into the
 *  dock: the chat opens a folded dock when no scroll is needed. */
export const LISTEN_ENTER_DOCK_EVENT = "lh:listen-enter-dock";

const PROSE = "p, li, h1, h2, h3, h4, h5, h6, blockquote, .katex-display";
/** Prose that makes its container a non-leaf (display math does not: a
 *  paragraph holding display math still reads as one paragraph). */
const NESTED_PROSE = "p, li, h1, h2, h3, h4, h5, h6, blockquote, tr";
/** What a list item holds that reads as blocks of its own. */
const LI_NESTED = "ul, ol, table";
// Buttons are NOT unspoken: the dock's options are buttons, and icon-only
// buttons (copy, expand) carry no text anyway.
/** Elements whose edges are pauses between words, not glue. */
const BOUNDARY = "p, div, li, ul, ol, button, h1, h2, h3, h4, h5, h6, blockquote, table, tr, td, th, figure, figcaption, .katex-display";
const UNSPOKEN = "pre, svg, canvas, img, video, audio, input, textarea, select, script, style, [aria-hidden='true']";

function inRoot(el: Element, root: Element): boolean {
	return root.contains(el) && !el.closest(`[${LISTEN_SKIP_ATTR}]`) && !isCollapsed(el);
}

/** Is `el` inside a collapsed <details> (and not in its summary, which
 *  stays on screen)? */
export function isCollapsed(el: Element): boolean {
	for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
		if (d.hasAttribute("open")) continue;
		const summary = [...d.children].find((c) => c.matches("summary"));
		if (!summary?.contains(el)) return true;
	}
	return false;
}

/** The listenable block containing `target` inside `root`, or null. */
export function blockFor(target: Element, root: Element): Element | null {
	const atomic = target.closest(`[${LISTEN_BLOCK_ATTR}]`);
	if (atomic && inRoot(atomic, root)) return atomic;
	const row = target.closest("tr");
	if (row && inRoot(row, root)) return hasSpeech(row) ? row : null;
	let el = target.closest(PROSE);
	while (el && inRoot(el, root)) {
		const inlineMath = el.matches(".katex-display") && el.parentElement?.closest("p, li") && root.contains(el.parentElement);
		if (!inlineMath && !containsProse(el) && hasSpeech(el)) return el;
		el = el.parentElement?.closest(PROSE) ?? null;
	}
	return null;
}

/** Every block in `root`, in document order. */
export function blocksIn(root: Element): Element[] {
	const out: Element[] = [];
	for (const el of root.querySelectorAll(`${PROSE}, tr, [${LISTEN_BLOCK_ATTR}]`)) {
		if (blockFor(el, root) === el) out.push(el);
	}
	return out;
}

/** The block after (dir 1) or before (dir -1) `block` in its root. A block
 *  that re-rendered away is located by document position. */
export function adjacentBlock(block: Element, root: Element, dir: 1 | -1): Element | null {
	const all = blocksIn(root);
	const at = all.indexOf(block);
	if (at >= 0) return all[at + dir] ?? null;
	if (!block.isConnected) return null;
	const following = all.filter((b) => block.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
	return dir === 1 ? (following[0] ?? null) : (all[all.length - following.length - 1] ?? null);
}

/** adjacentBlock for a read that started in `start`, with "Read the
 *  question" on: past the transcript's end into the dock's first block,
 *  and Previous from there back to the transcript's last. Never from the
 *  dock up into the transcript. */
export function adjacentAcross(block: Element, start: Element, dir: 1 | -1): Element | null {
	const root = rootOf(block) ?? start;
	const near = adjacentBlock(block, root, dir);
	if (near || start.getAttribute(LISTEN_ROOT_ATTR) !== "transcript") return near;
	if (dir === 1 && root === start) {
		const dock = dockRoot(start.ownerDocument);
		return dock ? (blocksIn(dock)[0] ?? null) : null;
	}
	if (dir === -1 && root !== start && start.isConnected) return blocksIn(start).at(-1) ?? null;
	return null;
}

export function dockRoot(doc: Document): Element | null {
	return doc.querySelector(`[${LISTEN_ROOT_ATTR}="dock"]`);
}

export function rootOf(block: Element): Element | null {
	return block.closest(`[${LISTEN_ROOT_ATTR}]`);
}

/** The player's name for a block. */
export function blockLabel(block: Element): string {
	return block.getAttribute(LISTEN_BLOCK_ATTR) || "Reading";
}

function texOf(katexEl: Element): string | null {
	return katexEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
}

/** What the block says, as /api/tts/openai parts (adjacent text merged). */
export function speechParts(block: Element): SpeechPart[] {
	const parts: SpeechPart[] = [];
	const text = (value: string) => {
		const last = parts.at(-1);
		if (last && "text" in last) last.text += value;
		else parts.push({ text: value });
	};
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			text(node.textContent ?? "");
			return;
		}
		if (!(node instanceof Element) || node.matches(UNSPOKEN) || node.matches(`[${LISTEN_SKIP_ATTR}]`)) return;
		// A nested list or table inside a list item is its own run of blocks.
		if (node !== block && node.matches(LI_NESTED) && block.matches("li")) return;
		if (node.matches("tr")) return row(node);
		if (node.matches(".katex")) {
			const tex = texOf(node);
			if (tex) parts.push({ tex });
			else text(node.querySelector(".katex-html")?.textContent ?? "");
			return;
		}
		if (node.matches("br")) {
			text(" ");
			return;
		}
		for (const child of node.childNodes) walk(child);
		if (node !== block && node.matches(BOUNDARY)) text(" ");
	};
	/** End a phrase with `mark` — a cell that already ends a sentence keeps its own. */
	const end = (mark: ":" | ".") => {
		const last = parts.at(-1);
		if (last && "text" in last) {
			last.text = last.text.trimEnd();
			if (mark === "." && /[.!?:;]$/.test(last.text)) return text(" ");
		}
		text(`${mark} `);
	};
	const row = (tr: Element) => {
		const headers = columnHeaders(tr);
		const cells = [...tr.children].filter((c) => c.matches("td, th"));
		cells.forEach((cell, i) => {
			if (!hasSpeech(cell)) return;
			const header = headers?.[i];
			if (header && hasSpeech(header)) {
				for (const child of header.childNodes) walk(child);
				end(":");
			}
			for (const child of cell.childNodes) walk(child);
			end(".");
		});
	};
	walk(block);
	return parts.filter((p) => ("text" in p ? p.text.trim() : p.tex.trim()));
}

/** The header cells a body row's cells are read under; null for the
 *  header row itself, or a table without one. */
function columnHeaders(tr: Element): Element[] | null {
	if (tr.closest("thead")) return null;
	const table = tr.closest("table");
	const head = table?.querySelector("thead tr") ?? table?.querySelector("tr");
	if (!head || head === tr) return null;
	const cells = [...head.children].filter((c) => c.matches("th"));
	return cells.length > 0 ? cells : null;
}

/** Does `el` hold prose blocks of its own (so it is a container, not a
 *  block)? A list item's nested list or table doesn't count: those are
 *  their own blocks, and the item's own text still reads. */
function containsProse(el: Element): boolean {
	for (const inner of el.querySelectorAll(NESTED_PROSE)) {
		if (!el.matches("li")) return true;
		const list = inner.closest(LI_NESTED);
		if (!list || !el.contains(list)) return true;
	}
	return false;
}

function hasSpeech(el: Element): boolean {
	return (el.textContent ?? "").trim().length > 0;
}
