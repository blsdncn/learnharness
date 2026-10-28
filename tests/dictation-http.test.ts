import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { pcm16Wav } from "../src/core/dictation.ts";
import { transcribeOpenAIDictation } from "../src/server/openai-dictation.ts";

it("uploads a complete multipart WAV to an independent keyless compatible endpoint", async () => {
	const uploads: { path: string; auth: string | undefined; length: number; model: FormDataEntryValue | null; bytes: number[] }[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const form = await new Request("http://fixture/transcriptions", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: bytes }).formData();
		const audio = form.get("file") as File;
		uploads.push({ path: req.url!, auth: req.headers.authorization, length: Number(req.headers["content-length"]), model: form.get("model"), bytes: [...new Uint8Array(await audio.arrayBuffer()).slice(44)] });
		assert.equal(Number(req.headers["content-length"]), bytes.length);
		assert.equal(audio.name, "dictation.wav");
		assert.equal(audio.type, "audio/wav");
		assert.deepEqual([...form.keys()].sort(), ["file", "model"]);
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "Compatible transcription" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as { port: number };
		const response = await transcribeOpenAIDictation(new Request("http://app/api/stt/openai", { method: "POST", headers: { "content-type": "audio/wav" }, body: pcm16Wav([new Uint8Array([1, 2, 3, 4])]) }), {
			enabled: true, apiKey: undefined, keySource: "custom", baseUrl: `http://127.0.0.1:${port}/gateway/v1`, model: "independent-local-model",
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { text: "Compatible transcription" });
		assert.equal(uploads.length, 1);
		assert.equal(uploads[0]!.path, "/gateway/v1/audio/transcriptions");
		assert.equal(uploads[0]!.auth, undefined);
		assert.equal(uploads[0]!.model, "independent-local-model");
		assert.deepEqual(uploads[0]!.bytes, [1, 2, 3, 4]);
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("uses only the separate bearer key and redacts errors from a real compatible server", async () => {
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) { /* consume multipart */ }
		assert.equal(req.headers.authorization, "Bearer test-stt-only-credential");
		res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "test-stt-only-credential echoed by provider" }));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		const { port } = server.address() as { port: number };
		const response = await transcribeOpenAIDictation(new Request("http://app/api/stt/openai", { method: "POST", headers: { "content-type": "audio/wav" }, body: pcm16Wav([new Uint8Array([0, 1])]) }), {
			enabled: true, apiKey: "test-stt-only-credential", keySource: "custom", baseUrl: `http://127.0.0.1:${port}/v1`,
		});
		assert.equal(response.status, 502);
		assert.deepEqual(await response.json(), { message: "Transcription server answered 401." });
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("cancelling a recording upload closes its real provider request", async () => {
	let received!: () => void;
	let closed!: () => void;
	const arrived = new Promise<void>((resolve) => { received = resolve; });
	const disconnected = new Promise<void>((resolve) => { closed = resolve; });
	const server = createServer(async (req, res) => {
		res.on("close", closed);
		for await (const _chunk of req) { /* provider has the upload but has not answered */ }
		received();
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		const { port } = server.address() as { port: number };
		const controller = new AbortController();
		const pending = transcribeOpenAIDictation(new Request("http://app/api/stt/openai", { method: "POST", headers: { "content-type": "audio/wav" }, body: pcm16Wav([new Uint8Array([0, 1])]), signal: controller.signal }), {
			enabled: true, apiKey: undefined, keySource: "custom", baseUrl: `http://127.0.0.1:${port}/v1`,
		});
		await arrived; controller.abort();
		assert.equal((await pending).status, 502);
		await disconnected;
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
