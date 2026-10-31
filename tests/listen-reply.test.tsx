/**
 * Autoplay across a real session (Settings → TTS): a SessionModel drives
 * projectView, rendered with the chat's grouped-message shape — one
 * container per view message, keyed by its id, with the chat's source
 * markers and real answer/problem cards — over a real ListenController.
 * The answer to a dock question is the question call's tool result, so
 * the teacher's reply continues the EXISTING group: autoplay must find it
 * there by source, while everything already in the group stays history.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import React from "react";
import type { Root } from "react-dom/client";
import { SessionModel } from "../components/session-core";
import { AnsweredCard } from "../components/answered-card";
import { ProblemCard } from "../components/practice-cards";
import { listenSourceProps } from "../components/listen/speech-dom";
import type { ListenController as Controller } from "../components/listen/listen-controller";
import { textPartMessageId, type ArtifactPartProps, type LhMessage, type LhViewMessage, type LhViewPart, type QuestionAnswerData } from "../src/core";
import { newAnswerResult, newUserMessage } from "../src/core/native-messages";
import { buildAnswer } from "../src/core/question-core";
import { FakeAudio, replaceProperties } from "./helpers/browser";

const dom = parseHTML("<!doctype html><html><body></body></html>");

let audio: FakeAudio;
let speechRequests = 0;
let restore: (() => void)[] = [];
let ListenController: typeof import("../components/listen/listen-controller").ListenController;
let startAutoplayTurn: typeof import("../components/listen/listen-controller").startAutoplayTurn;
let createRoot: typeof import("react-dom/client").createRoot;
let flushSync: typeof import("react-dom").flushSync;
before(async () => {
	restore = [replaceProperties(globalThis, {
		React,
		window: dom.window,
		document: dom.document,
		Node: dom.window.Node,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		MutationObserver: dom.window.MutationObserver,
		localStorage: { getItem: () => null, setItem: () => {} },
		requestAnimationFrame: (): number => 1,
		cancelAnimationFrame: (): void => {},
		Audio: class extends FakeAudio {
			constructor() {
				super();
				audio = this;
			}
		},
		// Only the player's speech requests use the global fetch; the
		// session's server is injected per test.
		fetch: async () => {
			speechRequests++;
			return new Response(new Blob(["mp3"]));
		},
	}), replaceProperties(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => {} })];
	({ ListenController, startAutoplayTurn } = await import("../components/listen/listen-controller"));
	({ createRoot } = await import("react-dom/client"));
	({ flushSync } = await import("react-dom"));
});
after(async () => {
	await tick(50); // the cards' last effects run against the fake page
	for (const undo of restore) undo();
});

// ── the page: the chat's grouped-message shape ──────────────────────────────

const QUESTION_PARTS = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"]);

function Part({ part, pi }: { part: LhViewPart; pi: number }) {
	if (part.type === "text") {
		const sourceId = textPartMessageId(part.id);
		return (
			<div data-source-message-id={sourceId ?? undefined} {...listenSourceProps("text", part.id)}>
				{(part.text ?? "").split("\n\n").map((t, i) => (
					<p key={i}>{t}</p>
				))}
			</div>
		);
	}
	if (part.type === "reasoning") return <div data-listen-skip="">{part.text}</div>;
	if (part.type === "step-start") return pi > 0 ? <hr /> : null;
	if (QUESTION_PARTS.has(part.type)) {
		if (part.state !== "output-available") return null;
		return (
			<div className="contents" {...listenSourceProps("answer", part.toolCallId)}>
				<AnsweredCard answer={part.output as QuestionAnswerData} input={part.input} />
			</div>
		);
	}
	if (part.type === "tool-problem") {
		return (
			<div className="contents" {...listenSourceProps("call", part.toolCallId)}>
				<ProblemCard part={part as ArtifactPartProps["part"]} />
			</div>
		);
	}
	return null;
}

/** The dock: the pending question, else the active problem. */
function Dock({ messages }: { messages: LhViewMessage[] }) {
	const parts = messages.flatMap((m) => m.parts);
	const question = parts.findLast((p) => QUESTION_PARTS.has(p.type) && p.state === "input-available");
	if (question) return <div data-listen-block="Question">{(question.input as { question: string }).question}</div>;
	const problem = parts.findLast((p) => p.type === "tool-problem");
	if (!problem) return null;
	return (
		<div data-listen-block="Problem" data-listen-problem={problem.toolCallId}>
			{(problem.input as { statement: string }).statement}
		</div>
	);
}

function Page({ messages }: { messages: LhViewMessage[] }) {
	return (
		<>
			<div data-listen-root="transcript">
				{messages.map((m) =>
					m.role === "user" ? (
						<div key={m.id} data-listen-yours="">
							<div data-listen-block="You">{m.parts.map((p) => p.text).join("\n")}</div>
						</div>
					) : (
						<div key={m.id} data-testid="group">
							{m.parts.map((part, pi) => (
								<Part key={part.id ?? `${part.type}-${part.toolCallId ?? pi}`} part={part} pi={pi} />
							))}
						</div>
					),
				)}
			</div>
			<div data-listen-root="dock">
				<Dock messages={messages} />
			</div>
		</>
	);
}

// ── the session ──────────────────────────────────────────────────────────────

const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };

function assistant(id: string, content: unknown[]): LhMessage {
	return { id, role: "assistant", content, stopReason: "stop", usage, timestamp: 0, provider: "openrouter", model: "test" } as unknown as LhMessage;
}
const text = (t: string) => ({ type: "text", text: t });
const quizCall = (id: string, question: string) => ({ type: "toolCall", id, name: "quiz", arguments: { question } });

const OPTIONS = [
	{ label: "Bandwidth", value: "a" },
	{ label: "Latency", value: "b" },
];
function quizAnswer(id: string, question: string, explanation?: string): QuestionAnswerData {
	return buildAnswer({ id, kind: "quiz", question, mode: "single-select", options: OPTIONS, correctIndices: [1], explanation, createdAt: "fixture" }, { values: ["a"] }, "quiz");
}

/** The reply's turn on the wire: one streamed assistant message. */
function replyStream(content: unknown[]): string {
	const message = { role: "assistant", content, stopReason: "stop", usage, provider: "openrouter", model: "test" };
	return [
		{ type: "message_start", message: { ...message, content: [] } },
		{ type: "message_update", message, assistantMessageEvent: { type: "text", textDelta: "" } },
		{ type: "message_end", message },
	]
		.map((e) => `data: ${JSON.stringify(e)}\n\n`)
		.concat("data: [DONE]\n\n")
		.join("");
}

interface Server {
	post?: () => Response;
	/** The reply streamed once the answer is accepted. */
	reply?: unknown[];
	/** Resolves when the reply may stream. */
	gate?: Promise<void>;
}

let host: HTMLDivElement;
let root: Root;
let controller: Controller;
let session: SessionModel;

/** Mount a session over `initial`, the chat's busy state driving follow mode. */
function mount(initial: LhMessage[], server: Server) {
	let record = initial;
	session = new SessionModel({
		chatId: "chat_x",
		initialMessages: initial,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/chat") {
				const res = server.post?.() ?? Response.json({ ok: true });
				if (res.ok) {
					const event = JSON.parse(String(init?.body)) as { input: { toolCallId: string; answer: unknown; type: string; text?: string } };
					record = [...record, event.input.type === "answer" ? newAnswerResult(event.input.toolCallId, "quiz", event.input.answer) : newUserMessage(event.input.text ?? "")];
				}
				return res;
			}
			if (url === "/api/chats/chat_x") return Response.json({ messages: record, turnInFlight: false });
			if (url === "/api/chats/chat_x/stream") {
				await server.gate;
				return new Response(server.reply ? replyStream(server.reply) : "data: [DONE]\n\n");
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch,
	});
	const render = () => {
		flushSync(() => root.render(<Page messages={session.getState().messages} />));
		controller.setLive(session.status === "submitted" || session.status === "streaming");
	};
	session.onChange = render;
	render();
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the turn finish, the dock settle, and a clip start. */
async function settle() {
	for (let i = 0; i < 5; i++) await tick();
	await tick(700);
	for (let i = 0; i < 5; i++) await tick();
}

/** What autoplay reads, block by block, until it stops. */
async function spoken(): Promise<string[]> {
	const out: string[] = [];
	for (let i = 0; i < 10 && controller.getSnapshot().status === "playing"; i++) {
		out.push(controller.getSnapshot().block!.textContent!.trim());
		audio.end();
		await settle();
	}
	assert.equal(controller.getSnapshot().status, "idle");
	return out;
}

const answer = (id: string, data: QuestionAnswerData) => startAutoplayTurn(controller, () => session.submitAnswer("quiz", id, data));

beforeEach(() => {
	document.body.innerHTML = "";
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	controller = new ListenController();
	controller.autoplay = true;
	speechRequests = 0;
});
afterEach(() => {
	controller.stop();
	flushSync(() => root.unmount());
});

// One group so far: an answered quiz (with its tucked Why), more teaching,
// and the quiz now waiting in the dock.
const Q0 = "Which one is a rate?";
const Q1 = "Which one is measured in bits per second?";
const history: LhMessage[] = [
	newUserMessage("Teach me about networks."),
	assistant("a0", [text("Bandwidth is a rate."), quizCall("q0", Q0)]),
	newAnswerResult("q0", "quiz", quizAnswer("q0", Q0, "A rate is per unit of time.")),
	assistant("a1", [text("Latency is a delay.\n\nNow another check."), quizCall("q1", Q1)]),
];

describe("autoplay of the reply to a dock answer", () => {
	it("reads the feedback the reply appends to the existing group, not the group's history", async () => {
		let release!: () => void;
		mount(history, { reply: [text("Right: bandwidth.\n\nNext, jitter.")], gate: new Promise((r) => (release = r)) });
		const group = document.querySelector('[data-testid="group"]')!;
		const accepted = answer("q1", quizAnswer("q1", Q1));
		await settle();
		assert.equal(controller.pendingAutoplay, true);
		// Opening the earlier card's Why while the reply is coming mounts a
		// new block inside history: it is not the reply.
		const why = [...document.querySelectorAll("button")].find((b) => b.textContent === "Why")!;
		why.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
		await settle();
		assert.ok(document.querySelector('[data-listen-block="Why"]'), "the Why section opened");
		assert.equal(controller.getSnapshot().status, "idle", "opening history must not start a read");
		release();
		assert.equal(await accepted, true);
		await settle();
		assert.equal(document.querySelector('[data-testid="group"]'), group, "the reply continued the same group");
		assert.deepEqual(await spoken(), ["Right: bandwidth.", "Next, jitter."]);
	});

	it("with Read the question on, reads the feedback, then the question the reply posed", async () => {
		controller.readQuestion = true;
		mount(history, { reply: [text("Right: bandwidth."), quizCall("q2", "And this one?")] });
		await answer("q1", quizAnswer("q1", Q1));
		await settle();
		assert.deepEqual(await spoken(), ["Right: bandwidth.", "And this one?"]);
	});

	it("a reply that is only a question falls back to the dock question", async () => {
		controller.readQuestion = true;
		mount(history, { reply: [quizCall("q2", "And this one?")] });
		await answer("q1", quizAnswer("q1", Q1));
		await settle();
		assert.deepEqual(await spoken(), ["And this one?"]);
	});

	for (const readModelAnswers of [false, true]) {
		it(`the answered explain card contributes only its committed answer, when opted in (${readModelAnswers})`, async () => {
			controller.readModelAnswers = readModelAnswers;
			const explain = "Explain the bandwidth-delay product.";
			mount([...history.slice(0, 3), assistant("a1", [text("Latency is a delay."), { type: "toolCall", id: "e1", name: "explain", arguments: { question: explain } }])], {
				reply: [text("Good explanation.")],
			});
			const data = buildAnswer({ id: "e1", kind: "explain", question: explain, mode: "text", options: [], committedAnswer: "Bandwidth times round-trip time.", createdAt: "fixture" }, { text: "My attempt." }, "explain");
			await startAutoplayTurn(controller, () => session.submitAnswer("explain", "e1", data));
			await settle();
			assert.deepEqual(await spoken(), [...(readModelAnswers ? ["The answer: Bandwidth times round-trip time."] : []), "Good explanation."]);
		});
	}

	it("a problem the reply poses inside the group is read once, from the dock", async () => {
		controller.readQuestion = true;
		mount(history, { reply: [text("Now try one."), { type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Add 2 and 3." } }] });
		await answer("q1", quizAnswer("q1", Q1));
		await settle();
		assert.ok(document.querySelector('[data-testid="problem-card"]'), "the transcript copy rendered in the group");
		assert.deepEqual(await spoken(), ["Now try one.", "Add 2 and 3."]);
	});

	it("a problem posed earlier in the group is not read again with later feedback", async () => {
		controller.readQuestion = true;
		const earlier: LhMessage[] = [
			newUserMessage("Teach me about networks."),
			assistant("a0", [text("Try this."), { type: "toolCall", id: "p0", name: "problem", arguments: { statement: "Add 2 and 3." } }, quizCall("q1", Q1)]),
		];
		mount(earlier, { reply: [text("Right: bandwidth.")] });
		assert.equal(document.querySelector('[data-listen-root="dock"] [data-listen-block]')?.textContent, Q1);
		await answer("q1", quizAnswer("q1", Q1));
		await settle();
		assert.equal(document.querySelector('[data-listen-root="dock"] [data-listen-problem]')?.getAttribute("data-listen-problem"), "p0", "the problem is docked again");
		assert.deepEqual(await spoken(), ["Right: bandwidth."]);
	});

	it("a text send's reply in new rows still reads past the learner's own row", async () => {
		mount(history.slice(0, 3), { reply: [text("Sure: jitter is variation.")] });
		await startAutoplayTurn(controller, () => session.send({ type: "text", text: "What is jitter?" }));
		await settle();
		assert.deepEqual(await spoken(), ["Sure: jitter is variation."]);
	});
});

describe("a refused answer", () => {
	it("disarms autoplay: the question still pending is not read, nor a later turn the learner didn't start", async () => {
		controller.readQuestion = true;
		mount(history, { post: () => new Response("refused", { status: 500 }) });
		const accepted = await answer("q1", quizAnswer("q1", Q1));
		assert.equal(accepted, false);
		assert.equal(session.status, "error");
		assert.equal(controller.pendingAutoplay, false, "Esc is not claimed by an idle arm");
		await settle();
		assert.equal(document.querySelector('[data-listen-root="dock"] [data-listen-block]')?.textContent, Q1, "the question is back in the dock");
		// A turn the learner didn't start (a wake) appends to the group.
		session.setMessages([...history, newAnswerResult("q1", "quiz", quizAnswer("q1", Q1)), assistant("a2", [text("Unrelated wake reply.")])]);
		await settle();
		assert.equal(controller.getSnapshot().status, "idle");
		assert.equal(speechRequests, 0, "nothing was synthesized");
	});
});
