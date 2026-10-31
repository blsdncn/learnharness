/**
 * Follow mode and autoplay (Settings → TTS). While a turn is live only
 * finished transcript blocks are read — a block is finished once another
 * follows it, or the turn ends — and a read that catches up waits instead
 * of stopping. Autoplay reads the reply to a turn the learner started,
 * from its first finished block past their own rows; it never interrupts.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConcludeCard, ThinkingCard } from "../components/practice-cards";
import { AnsweredCard } from "../components/answered-card";
import { ProbeDoneCard } from "../components/artifacts/probe-done-card";
import { buildAnswer } from "../src/core/question-core";
import { FakeAudio, replaceProperties } from "./helpers/browser";

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");

let audio: FakeAudio;
let restore: (() => void)[] = [];
before(() => {
	restore = [
		replaceProperties(globalThis, {
			React,
			document,
			Node: window.Node,
			Element: window.Element,
			Event: window.Event,
			MutationObserver: window.MutationObserver,
			localStorage: { getItem: () => null, setItem: () => {} },
			Audio: class extends FakeAudio {
				constructor() {
					super();
					audio = this;
				}
			},
			fetch: async () => new Response(new Blob(["mp3"])),
		}),
		replaceProperties(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => {} }),
	];
});
after(() => {
	for (const undo of restore) undo();
});

const { ListenController } = await import("../components/listen/listen-controller.ts");
const { setDictationActive } = await import("../components/dictation-state.ts");
type Controller = InstanceType<typeof ListenController>;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let mutations be noticed (50ms throttle) and a clip start playing. */
const settle = async () => {
	await tick(80);
	for (let i = 0; i < 5; i++) await tick();
};
const $ = (id: string) => document.getElementById(id)!;
const transcript = () => document.querySelector('[data-listen-root="transcript"]')!;
function add(html: string) {
	transcript().insertAdjacentHTML("beforeend", html);
}
const at = (c: Controller) => {
	const s = c.getSnapshot();
	return s.status === "playing" || s.status === "loading" ? s.block?.id : s.status;
};

let controller: Controller;
beforeEach(() => {
	document.body.innerHTML = `<div data-listen-root="transcript"><p id="old">Earlier reply.</p></div><div data-listen-root="dock"></div>`;
	controller?.stop();
	controller = new ListenController();
	setDictationActive(false);
});

describe("follow mode", () => {
	it("never reads the block still being written; waits, then goes on as blocks finish", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("a"));
		await settle();
		assert.equal(at(controller), "a");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting", "b is still growing");
		assert.equal(controller.getSnapshot().label, "Waiting…");
		$("b").textContent = "Two, still streaming.";
		add(`<p id="c">Three</p>`);
		await settle();
		assert.equal(at(controller), "b", "b finished once c began");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "c", "the turn's end finishes the last block");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("Read from here on the block still being written waits until it's finished", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("b"));
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		$("b").textContent = "Two, still streaming.";
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting", "growing text alone doesn't finish it");
		add(`<p id="c">Three</p>`);
		await settle();
		assert.equal(at(controller), "b");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
	});

	it("Previous leaves a selected block still being written, without reading it early", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("b"));
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.prev();
		await settle();
		assert.equal(at(controller), "a", "Previous steps from the remembered selection");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting", "b is still unfinished");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "b");
	});

	it("Previous from a waiting selection a re-render replaced steps from its replacement", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two, still stre</p>`);
		controller.playFrom($("b"));
		await settle();
		const copy = document.createElement("p");
		copy.id = "b-copy";
		copy.textContent = "Two, still strea";
		$("b").replaceWith(copy);
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.prev();
		await settle();
		assert.equal(at(controller), "a");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "b-copy");
	});

	it("a block still being written when the turn ends is read then", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("b"));
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "b");
	});

	it("Next while caught up waits too", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("a"));
		await settle();
		controller.next();
		assert.equal(controller.getSnapshot().status, "waiting");
	});

	it("a wait the turn's end leaves with nothing to read stops", async () => {
		controller.setLive(true);
		add(`<p id="a">One.</p><p id="b">Two</p>`);
		controller.playFrom($("a"));
		await settle();
		$("b").remove();
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await tick(700);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("outside a turn, reading stops at the end as before", async () => {
		controller.playFrom($("old"));
		await settle();
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a block a re-render replaced is found again by position and text", async () => {
		add(`<p id="a">One.</p><p id="b">Two.</p>`);
		controller.playFrom($("a"));
		await settle();
		const copy = document.createElement("p");
		copy.textContent = "One.";
		$("a").replaceWith(copy);
		assert.equal(controller.activeBlock(), copy);
		audio.end();
		assert.equal(at(controller), "b");
	});
});

describe("Stop", () => {
	it("silences the element and cancels synthesis; a response landing afterwards never plays", async (t) => {
		// Each speech request lands only when the test says so — even after its abort.
		const requests: { text: string; signal: AbortSignal; land: () => void }[] = [];
		t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
			const { parts } = JSON.parse(String(init!.body)) as { parts: { text?: string }[] };
			requests.push({ text: parts.map((p) => p.text ?? "").join("").trim(), signal: init!.signal!, land: () => resolve(new Response(new Blob(["mp3"]))) });
		}));
		let clips = 0;
		t.mock.method(URL, "createObjectURL", (blob: Blob) => (blob.type === "audio/wav" ? "blob:unlock" : `blob:clip-${++clips}`));
		add(`<p id="a">One.</p><p id="b">Two.</p>`);
		controller.playFrom($("old"));
		requests[0]!.land();
		await settle();
		assert.equal(at(controller), "old");
		assert.deepEqual(requests.map((r) => r.text), ["Earlier reply.", "One."], "the next block prefetches while this one plays");
		controller.stop();
		assert.equal(audio.paused, true, "Stop pauses the clip that was playing");
		assert.equal(audio.src, "", "and releases it");
		assert.equal(requests[1]!.signal.aborted, true, "the prefetch is cancelled");

		controller.playFrom($("a"));
		controller.stop();
		assert.equal(requests[2]!.signal.aborted, true, "a clip still loading is cancelled");
		controller.playFrom($("b"));
		requests[2]!.land(); // the stopped read's response arrives anyway
		await settle();
		assert.equal(controller.getSnapshot().status, "loading", "still waiting for b's own clip");
		requests[3]!.land();
		await settle();
		assert.equal(at(controller), "b");
		assert.deepEqual(audio.played.filter((src) => src !== "blob:unlock"), ["blob:clip-1", "blob:clip-3"], "the stopped read's clip never played");
	});
});

describe("briefs", () => {
	const brief = (id: string) =>
		`<details open data-listen-aside=""><summary>Research complete</summary><p id="${id}-1">Finding one.</p><p id="${id}-2">Finding two.</p></details>`;

	it("a read from above passes over an open brief", async () => {
		add(`${brief("b")}<p id="after">After.</p>`);
		controller.playFrom($("old"));
		await settle();
		audio.end();
		assert.equal(at(controller), "after");
	});

	it("a read started inside one reads it, then continues past it, skipping other briefs", async () => {
		add(`${brief("b")}<p id="mid">Between.</p>${brief("c")}<p id="after">After.</p>`);
		controller.playFrom($("b-1"));
		await settle();
		audio.end();
		assert.equal(at(controller), "b-2");
		await settle();
		audio.end();
		assert.equal(at(controller), "mid");
		await settle();
		audio.end();
		assert.equal(at(controller), "after");
	});
});

describe("autoplay", () => {
	beforeEach(() => {
		controller.autoplay = true;
	});

	for (const initiallyOpen of [false, true]) {
		it(`toggling historical thinking ${initiallyOpen ? "closed" : "open"} cannot move the reply boundary`, async () => {
			const thinking = '<p>Earlier thought.</p><p>More earlier thinking.</p>';
			transcript().innerHTML = `<div id="history" data-listen-yours>${initiallyOpen ? thinking : ""}</div><p id="old">Earlier reply.</p><p>Its last paragraph.</p>`;
			controller.armAutoplay();
			controller.setLive(true);
			$("history").innerHTML = initiallyOpen ? "" : thinking;
			await settle();
			assert.equal(controller.getSnapshot().status, "idle", "changing history must not start an old reply");
			add('<div data-listen-yours><p>New message.</p></div><p id="new-reply">New reply.</p><p>Still streaming.</p>');
			await settle();
			assert.equal(at(controller), "new-reply", "the beginning of the new reply is not skipped");
		});
	}

	async function turn(reply: string) {
		controller.armAutoplay();
		controller.setLive(true);
		add(`<div data-listen-yours=""><div data-listen-block="You" id="you">My question</div></div>`);
		add(reply);
		await settle();
	}

	it("reads the reply from its first finished block, skipping your own row", async () => {
		await turn(`<p id="r1">Reply one.</p>`);
		assert.equal(controller.getSnapshot().status, "idle", "r1 is still being written");
		add(`<p id="r2">Reply two</p>`);
		await settle();
		assert.equal(at(controller), "r1");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "r2");
	});

	it("skips the research and PDF briefs even open", async () => {
		const brief = `<details open data-listen-aside=""><summary>Research complete</summary><p id="finding">A finding.</p></details>`;
		await turn(`${brief}<p id="r1">Reply one.</p><p id="r2">Reply two.</p>`);
		assert.equal(at(controller), "r1", "the reply starts past the brief");
		controller.prev();
		assert.equal(at(controller), "finding", "Previous explicitly enters the open brief");
	});

	it("Previous and Next step through answer cards, open briefs and probe assessments", async () => {
		await turn(`<p id="before">Feedback.</p>
			<div data-listen-yours data-listen-answer-card>
				<div id="question" data-listen-block="Question">Question.</div>
				<div id="options" data-listen-block="Options">A or B.</div>
				<div id="answer" data-listen-block="Your answer">My answer.</div>
				<details><summary>Hidden thinking</summary><p id="closed">Do not read.</p></details>
				<pre>Code is not spoken.</pre>
			</div>
			<details open data-listen-aside><summary>Research</summary><p id="brief-one">First finding.</p><p id="brief-two">Second finding.</p></details>
			<div data-listen-autoplay-skip><p id="probe">Assessment.</p></div>
			<p id="after">Next feedback.</p>`);
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "before");
		audio.end();
		await settle();
		assert.equal(at(controller), "after", "automatic advancement keeps its exclusions");
		for (const id of ["probe", "brief-two", "brief-one", "answer", "options", "question", "before"]) {
			controller.prev();
			assert.equal(at(controller), id);
		}
		for (const id of ["question", "options", "answer", "brief-one", "brief-two", "probe", "after"]) {
			controller.next();
			assert.equal(at(controller), id);
		}
	});

	it("Next remembers a manually selected answer block until streaming completes it", async () => {
		await turn('<p id="intro">Feedback.</p><div data-listen-yours data-listen-answer-card><p id="answer">Still being written.</p></div>');
		assert.equal(at(controller), "intro");
		controller.next();
		assert.equal(controller.getSnapshot().status, "waiting");
		add('<p id="later">Another paragraph.</p>');
		await settle();
		assert.equal(at(controller), "answer", "the explicit selection is not replaced by autoplay filtering");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "later");
	});

	it("Next can explicitly read the transcript problem and then its dock copy", async () => {
		controller.readQuestion = true;
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = '<div id="dock-problem" data-listen-block="Problem" data-listen-problem="p1">Problem.</div>';
		await turn('<p id="intro">Introduction.</p><div id="pose" data-listen-block="Problem" data-listen-problem="p1">Problem.</div>');
		controller.setLive(false);
		await settle();
		controller.next();
		assert.equal(at(controller), "pose");
		controller.next();
		assert.equal(at(controller), "dock-problem");
	});

	it("off: nothing plays", async () => {
		controller.autoplay = false;
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		controller.setLive(false);
		await tick(700);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("never interrupts: a reply that arrives while something reads is skipped", async () => {
		controller.playFrom($("old"));
		await settle();
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		assert.equal(at(controller), "old", "the read in progress is not interrupted");
		audio.end();
		await settle();
		assert.equal(at(controller), "you", "it just reads on through the transcript, as Read from here does");
	});

	it("dictation skips the reply", async () => {
		setDictationActive(true);
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a reply that is only a question reads the question with Read the question on", async () => {
		controller.readQuestion = true;
		await turn("");
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Question" id="dq">Pick one</div>`;
		controller.setLive(false);
		await tick(700);
		await settle();
		assert.equal(at(controller), "dq");
	});

	it("autoplay reads an active practice problem in the dock once", async () => {
		controller.readQuestion = true;
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Problem" data-listen-problem="p1" id="dq">Solve this problem.</div>`;
		await turn(`<div data-listen-block="Problem" data-listen-problem="p1" id="pose">Solve this problem.</div>`);
		controller.setLive(false);
		await tick(700);
		await settle();
		assert.equal(at(controller), "dq", "autoplay must start past the transcript copy");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("later practice feedback does not repeat the problem; explicit replay still works", async () => {
		controller.readQuestion = true;
		add(`<div data-listen-block="Problem" data-listen-problem="p1">Solve this problem.</div>`);
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Problem" data-listen-problem="p1" id="dq">Solve this problem.</div>`;
		await turn(`<p id="feedback">Try a different approach.</p>`);
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "feedback");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle", "the unchanged dock is not part of this reply");
		controller.playFrom($("dq"));
		await settle();
		assert.equal(at(controller), "dq", "the volume icon can replay the problem");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a practice turn without spoken feedback does not fall back to the old dock", async () => {
		controller.readQuestion = true;
		add(`<div data-listen-block="Problem" data-listen-problem="p1">Solve this problem.</div>`);
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Problem" data-listen-problem="p1" id="dq">Solve this problem.</div>`;
		await turn("");
		controller.setLive(false);
		await tick(700);
		await settle();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a new problem ID with the same wording is read after its introduction", async () => {
		controller.readQuestion = true;
		add(`<div data-listen-block="Problem" data-listen-problem="p1">Solve this problem.</div>`);
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Problem" data-listen-problem="p2" id="dq">Solve this problem.</div>`;
		await turn(`<p id="intro">Next problem.</p><div data-listen-block="Problem" data-listen-problem="p2">Solve this problem.</div>`);
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "intro");
		audio.end();
		await settle();
		assert.equal(at(controller), "dq");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("Stop forgets an armed autoplay: the reply that arrives later is not read", async () => {
		controller.playFrom($("old"));
		await settle();
		controller.armAutoplay();
		controller.setLive(true);
		controller.stop();
		add(`<p id="r1">Reply one.</p><p id="r2">Reply two.</p>`);
		await settle();
		controller.setLive(false);
		await tick(700);
		await settle();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("passes over a learner row that arrives while autoplay still plays; Previous may step back onto it", async () => {
		await turn(`<p id="r1">Reply one.</p><p id="r2">Reply two.</p>`);
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "r1");
		// The learner starts another turn while r1 plays: never interrupted.
		controller.armAutoplay();
		controller.setLive(true);
		add(`<div data-listen-yours=""><div data-listen-block="You" id="you2">Another question</div></div>`);
		add(`<div data-listen-yours=""><div data-listen-block="Thinking" id="think">My reasoning</div></div>`);
		add(`<p id="r3">Next reply.</p><p id="r4">More</p>`);
		await settle();
		assert.equal(at(controller), "r1");
		audio.end();
		await settle();
		assert.equal(at(controller), "r2");
		audio.end();
		await settle();
		assert.equal(at(controller), "r3", "the learner's own rows are passed over");
		controller.prev();
		assert.equal(at(controller), "think");
	});

	it("prose the reply appends after a docked problem is read before the dock", async () => {
		controller.readQuestion = true;
		document.querySelector('[data-listen-root="dock"]')!.innerHTML = `<div data-listen-block="Problem" data-listen-problem="p1" id="dq">Solve this problem.</div>`;
		await turn(`<p id="intro">Here is a problem.</p><div data-listen-block="Problem" data-listen-problem="p1" id="pose">Solve this problem.</div>`);
		assert.equal(at(controller), "intro");
		audio.end();
		assert.equal(controller.getSnapshot().status, "waiting", "the turn is still live");
		add(`<p id="late">One more hint.</p>`);
		await settle();
		assert.equal(controller.getSnapshot().status, "waiting");
		controller.setLive(false);
		await settle();
		assert.equal(at(controller), "late");
		audio.end();
		await settle();
		assert.equal(at(controller), "dq");
		audio.end();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	it("a refused send disarms", async () => {
		controller.armAutoplay();
		controller.disarmAutoplay();
		controller.setLive(true);
		add(`<p id="r1">Reply one.</p><p id="r2">Reply two</p>`);
		await settle();
		assert.equal(controller.getSnapshot().status, "idle");
	});

	for (const label of ["The answer", "Model solution"]) {
		const answer = `<div id="model" data-listen-block="${label}" data-listen-model-answer="">The model answer.</div>`;
		it(`autoplay skips ${label} automatically, while Previous and Next can select it`, async () => {
			await turn(`<p id="verdict">A helpful verdict.</p>${answer}<p id="feedback">Continue here.</p>`);
			controller.setLive(false);
			await settle();
			assert.equal(at(controller), "verdict");
			audio.end();
			await settle();
			assert.equal(at(controller), "feedback");
			controller.prev();
			assert.equal(at(controller), "model");
			controller.next();
			assert.equal(at(controller), "feedback");
			controller.prev();
			assert.equal(at(controller), "model");
			controller.prev();
			assert.equal(at(controller), "verdict");
		});
		it(`autoplay skips ${label} when it is the only reply block`, async () => {
			await turn(answer);
			controller.setLive(false);
			await tick(700);
			await settle();
			assert.equal(controller.getSnapshot().status, "idle");
		});
		it(`manual reading can start at ${label} and continue through it`, async () => {
			add(`<p id="verdict">A helpful verdict.</p>${answer}<p id="feedback">Continue here.</p>`);
			controller.playFrom($("model"));
			await settle();
			assert.equal(at(controller), "model");
			controller.stop();
			controller.playFrom($("verdict"));
			await settle();
			audio.end();
			await settle();
			assert.equal(at(controller), "model");
		});
		it(`autoplay skips a leading and trailing ${label} without skipping feedback`, async () => {
			await turn(`${answer.replace('id="model"', 'id="leading"')}<p id="feedback">Continue here.</p>${answer}`);
			controller.setLive(false);
			await settle();
			assert.equal(at(controller), "feedback");
			audio.end();
			assert.equal(controller.getSnapshot().status, "idle");
		});
	}
});

describe("actual rendered cards in autoplay", () => {
	/** The learner's thinking rows — the practice one, and the one an
	 *  answer card lifts above itself — are theirs: never autoplayed. */
	function practiceCard() {
		const thinking = renderToStaticMarkup(React.createElement(ThinkingCard, { data: { problemCallId: "problem_1", text: "Carry the one." } }));
		return thinking + concludeCard();
	}
	function concludeCard() {
		return renderToStaticMarkup(React.createElement(ConcludeCard, { part: {
			type: "tool-conclude", state: "output-available", toolCallId: "conclude_1",
			input: { outcome: "solved", verdict: "Correct addition credited." }, reveal: "2 + 3 = 5.",
		} }));
	}
	function teachingCard() {
		const answer = buildAnswer({
			id: "recall_1", kind: "explain", question: "Explain bandwidth-delay product.",
			mode: "text", options: [], committedAnswer: "Bandwidth times minimum RTT.",
			createdAt: "2026-10-29T00:00:00.000Z",
		}, { text: "My attempted answer.", readingThinking: "Reread the RTT definition." }, "recall");
		return renderToStaticMarkup(React.createElement(AnsweredCard, { answer }));
	}
	function probeCard() {
		return renderToStaticMarkup(React.createElement(ProbeDoneCard, { part: {
			state: "output-available", output: { ok: true },
			input: { assessment: {
				strands: [{ strand: "Bandwidth-delay product", assessment: "Floor established." }],
				summary: "Internal assessment summary.",
			} },
		} }));
	}
	async function readReply(html: string) {
		controller.autoplay = true;
		controller.armAutoplay();
		controller.setLive(true);
		add(html);
		controller.setLive(false);
		await settle();
		const spoken: string[] = [];
		for (let i = 0; i < 10 && controller.getSnapshot().status === "playing"; i++) {
			spoken.push(controller.getSnapshot().block!.textContent!.trim());
			audio.end();
			await settle();
		}
		assert.equal(controller.getSnapshot().status, "idle");
		return spoken;
	}
	for (const readModelAnswers of [false, true]) {
		for (const leadingProse of [false, true]) {
			const intro = leadingProse ? "New feedback." : "";
			const prefix = intro ? `<p>${intro}</p>` : "";
			it(`practice card: only the solution is optional (${readModelAnswers}), with preceding prose ${leadingProse}`, async () => {
				controller.readModelAnswers = readModelAnswers;
				const spoken = await readReply(`${prefix}${practiceCard()}<p>Separate assistant reply.</p>`);
				assert.deepEqual(spoken, [...(intro ? [intro] : []), ...(readModelAnswers ? ["2 + 3 = 5."] : []), "Separate assistant reply."]);
			});
			it(`teaching card: only the answer is optional (${readModelAnswers}); probe summary is skipped, with preceding prose ${leadingProse}`, async () => {
				controller.readModelAnswers = readModelAnswers;
				const spoken = await readReply(`${prefix}${teachingCard()}${probeCard()}<p>Separate assistant reply.</p>`);
				assert.deepEqual(spoken, [...(intro ? [intro] : []), ...(readModelAnswers ? ["The answer: Bandwidth times minimum RTT."] : []), "Separate assistant reply."]);
			});
		}
	}
	it("explicit reading still includes the practice verdict and solution", async () => {
		add(practiceCard());
		const verdict = transcript().querySelector('[data-listen-block="Verdict"]')!;
		controller.playFrom(verdict);
		await settle();
		assert.equal(controller.getSnapshot().block, verdict);
		audio.end();
		await settle();
		assert.equal(controller.getSnapshot().block?.textContent?.trim(), "2 + 3 = 5.");
	});
	it("explicit reading can start at the learner's thinking, the teaching answer or probe summary", async () => {
		add(practiceCard() + teachingCard() + probeCard());
		for (const block of [
			transcript().querySelector('[data-testid="thinking-card"] [data-listen-block]')!,
			transcript().querySelector('[data-testid="reading-thinking-block"] [data-listen-block]')!,
			transcript().querySelector('[data-listen-model-answer]')!,
			transcript().querySelector('[data-testid="probe-done-card"] p')!,
		]) {
			controller.playFrom(block);
			await settle();
			assert.equal(controller.getSnapshot().block, block);
			assert.equal(controller.getSnapshot().status, "playing");
			controller.stop();
		}
	});
});
