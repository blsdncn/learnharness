import type { Api, AssistantMessage, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { CodexStatus } from "../core/contracts/codex.ts";

const FAILURE = "Codex subscription request failed. Check your connection and plan limits, or sign in again. No API-key fallback was used.";
const unavailable = (): CodexStatus => ({ available: false, pending: false, connected: false, manualCode: false, error: null });
interface StateValue { status: CodexStatus; epoch: number }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Bridge {
	value: StateValue;
	counter: number;
	pending: Map<string, Pending>;
	controllers: Set<AbortController>;
}
const key = Symbol.for("lh.codex.bridge");
function desktopConnected() {
	return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && process.connected === true && typeof process.send === "function";
}
function accept(state: Bridge, value: StateValue) {
	if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < state.value.epoch || typeof value.status?.connected !== "boolean") return;
	if (value.epoch !== state.value.epoch || !value.status.connected) for (const controller of state.controllers) controller.abort();
	state.value = value;
}
function bridge(): Bridge {
	const global = globalThis as typeof globalThis & { [key]?: Bridge };
	if (!global[key]) {
		const state: Bridge = { value: { status: unavailable(), epoch: 0 }, counter: 0, pending: new Map(), controllers: new Set() };
		global[key] = state;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: string; kind?: string; id?: string; ok?: boolean; value: unknown } & StateValue;
			if (!desktopConnected() || message?.channel !== "lh:codex") return;
			if (message.kind === "state") accept(state, message);
			if (!message.id) return;
			const pending = state.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer); state.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value); else pending.reject(new Error(FAILURE));
		});
		process.on("disconnect", () => {
			state.value = { status: unavailable(), epoch: state.value.epoch + 1 };
			for (const controller of state.controllers) controller.abort();
			for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(FAILURE)); }
			state.pending.clear();
		});
	}
	return global[key];
}
function request<T>(op: "status" | "lease", epoch?: number): Promise<T> {
	const state = bridge();
	if (!desktopConnected()) return Promise.reject(new Error("Codex subscription sign-in requires the desktop app."));
	return new Promise<T>((resolve, reject) => {
		const id = `${process.pid}:${++state.counter}`;
		const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(FAILURE)); }, 45000);
		state.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
		process.send!({ channel: "lh:codex", id, op, epoch }, (error) => {
			if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error(FAILURE)); }
		});
	});
}
export function codexConnected(): boolean {
	return desktopConnected() && bridge().value.status.available && bridge().value.status.connected;
}
export async function refreshCodexConnection(): Promise<void> {
	if (!desktopConnected()) return;
	try { accept(bridge(), await request<StateValue>("status")); }
	catch { accept(bridge(), { status: unavailable(), epoch: bridge().value.epoch }); }
}

/** Native Pi transport, with a fresh main-process credential lease per call.
 * Never uses Models' ambient auth resolution, OpenAI API keys, or another provider. */
export const codexStream: StreamFunction<Api> = (model, context, options) => {
	const output = new AssistantMessageEventStream();
	void (async () => {
		let partial: AssistantMessage = {
			role: "assistant", api: model.api, provider: "openai-codex", model: model.id, content: [], stopReason: "error", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const controller = new AbortController();
		const state = bridge();
		try {
			await refreshCodexConnection();
			if (!codexConnected() || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") throw new Error(FAILURE);
			const epoch = state.value.epoch;
			state.controllers.add(controller);
			const lease = await request<{ accessToken: string; epoch: number }>("lease", epoch);
			if (lease.epoch !== epoch || state.value.epoch !== epoch || !codexConnected() || controller.signal.aborted || typeof lease.accessToken !== "string" || !lease.accessToken || lease.accessToken.startsWith("sk-")) throw new Error(FAILURE);
			const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
			const source = streamSimple({ ...model, api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", headers: undefined }, context, {
				...options, apiKey: lease.accessToken, signal,
			});
			for await (const event of source) {
				if (event.type === "error") throw new Error(FAILURE);
				partial = "partial" in event ? event.partial : event.message;
				output.push(event);
			}
		} catch {
			partial = { ...partial, stopReason: controller.signal.aborted || options?.signal?.aborted ? "aborted" : "error", errorMessage: FAILURE };
			output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
		} finally { state.controllers.delete(controller); output.end(); }
	})();
	return output;
};
