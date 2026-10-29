/**
 * Listen blocks (listen wave, 2026-10-26): what counts as a block, the
 * read-from-here order, and what a block says — over markup shaped like
 * the real transcript (Streamdown prose, KaTeX with its TeX annotation,
 * card sections marked data-listen-block, reasoning marked skip).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const katex = (tex: string, display = false) => {
	const inner = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">${tex}</span></span>`;
	return display ? `<span class="katex-display">${inner}</span>` : inner;
};

const { document, window } = parseHTML(`<!doctype html><html><body>
<div data-listen-root="transcript">
  <p id="p1">A router forwards using its <strong>table</strong>.</p>
  <p id="p2">The prefix ${katex("10.1.0.0/16")} matches.</p>
  <div class="math math-display" id="dm">${katex("\\frac{a}{b}", true)}</div>
  <ul><li id="li1">First item<ul><li id="li2">Nested item</li></ul></li></ul>
  <div data-streamdown="table-wrapper"><div><button title="Copy table"><svg></svg></button></div><div class="overflow-x-auto"><table>
    <thead><tr id="th"><th>Stage</th><th>What it <strong>accomplishes</strong></th></tr></thead>
    <tbody><tr id="r1"><td><span>Identify Zoom traffic</span></td><td>Account for server-based routing.</td></tr>
    <tr id="r2"><td>Validate</td><td>Compare ${katex("1{,}000")} frames</td></tr>
    <tr id="r3"><td></td><td>   </td></tr></tbody>
  </table></div></div>
  <ul><li id="li3">Item with a table<table><tr id="r4h"><th>A</th></tr><tr id="r4"><td>a</td></tr></table></li></ul>
  <pre><code>const ignored = true;</code></pre>
  <div data-listen-skip=""><p id="reasoning">Hidden reasoning.</p></div>
  <div class="card">
    <div data-listen-block="Question" id="q"><p>Why the /24?</p></div>
    <div data-listen-block="Your answer" id="ya">“More specific.”</div>
    <button>Why</button>
    <div data-listen-block="The answer" id="ta"><span>The answer: </span><p>Longest prefix wins.</p><p>Always.</p></div>
  </div>
  <p id="empty">   </p>
</div>
<div data-listen-root="dock"><div data-listen-block="Question" id="dq">Pick one</div>
  <div data-listen-block="Options" id="opts"><button>Alpha</button><button>Beta</button></div></div>
</body></html>`);
Object.assign(globalThis, { Node: window.Node, Element: window.Element });

const { adjacentBlock, blockFor, blockLabel, blocksIn, isCollapsed, speechParts } = await import("../components/listen/speech-dom.ts");

const $ = (id: string) => document.getElementById(id)!;
const transcript = document.querySelector('[data-listen-root="transcript"]')!;
const dock = document.querySelector('[data-listen-root="dock"]')!;

describe("blocks", () => {
	it("paragraph-level prose, display math, and atomic card sections — in document order", () => {
		assert.deepEqual(
			blocksIn(transcript).map((b) => b.id || b.className),
			["p1", "p2", "katex-display", "li1", "li2", "th", "r1", "r2", "li3", "r4h", "r4", "q", "ya", "ta"],
		);
	});
	it("hovering anything inside a block finds that block", () => {
		assert.equal(blockFor(document.querySelector("#p1 strong")!, transcript), $("p1"));
		assert.equal(blockFor(document.querySelector("#p2 annotation")!, transcript), $("p2"), "inline math stays in its paragraph");
		assert.equal(blockFor(document.querySelector("#ta p")!, transcript), $("ta"), "atomic: the section, not its paragraph");
		assert.equal(blockFor(document.querySelector("#r1 span")!, transcript), $("r1"), "a table cell reads as its row");
		assert.equal(blockFor(document.querySelector("#r2 annotation")!, transcript), $("r2"));
	});
	it("skipped regions, code, and blank paragraphs are never blocks", () => {
		assert.equal(blockFor($("reasoning"), transcript), null);
		assert.equal(blockFor(document.querySelector("pre code")!, transcript), null);
		assert.equal(blockFor($("empty"), transcript), null);
		assert.equal(blockFor(document.querySelector("#r3 td")!, transcript), null, "an empty row");
	});
	it("read-from-here walks within its root only", () => {
		assert.equal(adjacentBlock($("ya"), transcript, 1), $("ta"));
		assert.equal(adjacentBlock($("ta"), transcript, 1), null, "never jumps into the dock");
		assert.equal(adjacentBlock($("p2"), transcript, -1), $("p1"));
		assert.equal(adjacentBlock($("dq"), dock, 1), $("opts"));
	});
	it("labels: the section's name, or Reading for prose", () => {
		assert.equal(blockLabel($("ta")), "The answer");
		assert.equal(blockLabel($("p1")), "Reading");
	});
});

describe("collapsed sections", () => {
	const { document: doc } = parseHTML(`<!doctype html><html><body><div data-listen-root="transcript">
	  <p id="before">Before.</p>
	  <details id="brief"><summary><p id="sum">Research complete</p></summary><p id="inside">Hidden finding.</p></details>
	  <p id="after">After.</p>
	</div></body></html>`);
	const root = doc.querySelector("[data-listen-root]")!;
	const ids = () => blocksIn(root).map((b) => b.id);
	it("collapsed: not a block, can't be started in, and reading passes over it", () => {
		assert.deepEqual(ids(), ["before", "sum", "after"], "the summary stays readable");
		assert.equal(blockFor(doc.getElementById("inside")!, root), null);
		assert.equal(adjacentBlock(doc.getElementById("sum")!, root, 1), doc.getElementById("after"));
		assert.equal(isCollapsed(doc.getElementById("inside")!), true);
		assert.equal(isCollapsed(doc.getElementById("sum")!), false);
	});
	it("opened: reads like the rest", () => {
		doc.getElementById("brief")!.setAttribute("open", "");
		assert.deepEqual(ids(), ["before", "sum", "inside", "after"]);
		assert.equal(blockFor(doc.getElementById("inside")!, root), doc.getElementById("inside"));
		doc.getElementById("brief")!.removeAttribute("open");
	});
});

describe("what a block says", () => {
	const flat = (el: Element) => speechParts(el).map((p) => ("text" in p ? p.text.replace(/\s+/g, " ").trim() : `[${p.tex}]`));
	it("prose text with inline emphasis", () => {
		assert.deepEqual(flat($("p1")), ["A router forwards using its table."]);
	});
	it("math as its TeX source, never the rendered glyphs twice", () => {
		assert.deepEqual(flat($("p2")), ["The prefix", "[10.1.0.0/16]", "matches."]);
		assert.deepEqual(flat(document.querySelector(".katex-display")!), ["[\\frac{a}{b}]"]);
	});
	it("a list item without its nested list (that is its own block)", () => {
		assert.deepEqual(flat($("li1")), ["First item"]);
	});
	it("an atomic section reads its label and every paragraph, with pauses between", () => {
		assert.deepEqual(flat($("ta")), ["The answer: Longest prefix wins. Always."]);
	});
	it("a table row pairs each cell with its column header; the header row reads as-is", () => {
		assert.deepEqual(flat($("th")), ["Stage. What it accomplishes."]);
		assert.deepEqual(flat($("r1")), ["Stage: Identify Zoom traffic. What it accomplishes: Account for server-based routing."]);
		assert.deepEqual(flat($("r2")), ["Stage: Validate. What it accomplishes: Compare", "[1{,}000]", "frames."]);
	});
	it("a list item holding a table reads its own text; the table's rows are their own blocks", () => {
		assert.deepEqual(flat($("li3")), ["Item with a table"]);
		assert.deepEqual(flat($("r4")), ["A: a."]);
	});
	it("dock options are buttons — spoken, each its own phrase", () => {
		assert.deepEqual(flat($("opts")), ["Alpha Beta"]);
	});
});
