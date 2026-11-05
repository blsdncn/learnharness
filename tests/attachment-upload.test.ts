import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { ATTACHMENT_SIZE_ERROR, MAX_ATTACHMENT_BODY_BYTES, MAX_ATTACHMENT_BYTES, validAttachmentName } from "../src/core/attachment-upload.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-attachment-upload-"));
const data = path.join(root, "data");
const secret = "a".repeat(64);
Object.assign(process.env, { LH_DATA_DIR: data, LH_AUTH_FILE: path.join(root, "auth.json"), LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret });
const { attachmentUploadResponse: upload } = await import("../src/server/attachment-upload.ts");
const { saveUploadedFiles } = await import("../src/store/uploads.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
await fs.mkdir(data);
await fs.writeFile(path.join(root, "auth.json"), "{}");
beforeEach(async () => {
	await fs.rm(path.join(data, "uploads"), { recursive: true, force: true });
	await fs.writeFile(path.join(data, "settings.json"), "{}");
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
function request(files: File[], headers: Record<string, string> = {}, signal?: AbortSignal) {
	const body = new FormData();
	for (const file of files) body.append("files", file);
	return new Request("http://localhost/api/attachments", { method: "POST", body, headers: { "x-learnharness-desktop": secret, ...headers }, signal });
}

it("keeps original names and bytes, duplicate names and later uploads without overwrites, with private modes", async () => {
	const body = await (await upload(request([new File(["first"], "notes one.md"), new File(["second"], "notes one.md")]))).json();
	const later = await (await upload(request([new File(["third"], "notes one.md")]))).json();
	const paths: string[] = [...body.paths, ...later.paths];
	assert.equal(new Set(paths).size, 3);
	for (const [i, p] of paths.entries()) {
		assert.equal(path.basename(p), "notes one.md");
		assert.equal(await fs.readFile(p, "utf8"), ["first", "second", "third"][i]);
		assert.equal(resolveSourcePath(p), p, "the ordinary file reader can resolve the returned path");
		if (process.platform !== "win32") {
			assert.equal((await fs.stat(p)).mode & 0o777, 0o600);
			assert.equal((await fs.stat(path.dirname(p))).mode & 0o777, 0o700);
		}
	}
	assert.equal((await fs.stat(path.join(data, "uploads"))).mode & 0o777, 0o700);
	assert.equal(await fs.readFile(path.join(data, "settings.json"), "utf8"), "{}");
	assert.deepEqual((await fs.readdir(data)).sort(), ["settings.json", "uploads"], "no sessions, jobs, or graph work is created");
});

it("accepts the full 25 MiB file allowance and refuses a combined excess before writes", async () => {
	const exact = await upload(request([new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "large.bin")]));
	assert.equal(exact.status, 200);
	const before = await fs.readdir(path.join(data, "uploads"));
	const refused = await upload(request([new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "large.bin"), new File(["x"], "extra.txt")]));
	assert.equal(refused.status, 413);
	assert.equal((await refused.json()).error, ATTACHMENT_SIZE_ERROR);
	assert.deepEqual(await fs.readdir(path.join(data, "uploads")), before);
});

it("bounds streamed bodies with missing or falsely small Content-Length and cancels further reads", async () => {
	for (const declared of [undefined, "1", String(MAX_ATTACHMENT_BODY_BYTES + 1)]) {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
		const headers: Record<string, string> = { "x-learnharness-desktop": secret, "content-type": "multipart/form-data; boundary=test" };
		if (declared) headers["content-length"] = declared;
		const req = new Request("http://localhost/api/attachments", { method: "POST", body, headers, duplex: "half" } as RequestInit);
		assert.equal((await upload(req)).status, 413);
		assert.equal(cancelled, true);
		await assert.rejects(fs.access(path.join(data, "uploads")));
	}
});

it("refuses unauthenticated requests before reading their body", async () => {
	let read = false;
	const req = request([new File(["secret"], "notes.txt")], { "x-learnharness-desktop": "wrong" });
	Object.defineProperty(req, "body", { get() { read = true; throw new Error("must not read"); } });
	assert.equal((await upload(req)).status, 403);
	assert.equal(read, false);
});

it("rejects malformed, empty, and non-file multipart requests without creating files", async () => {
	assert.equal((await upload(request([]))).status, 400);
	const form = new FormData(); form.append("files", "/etc/passwd");
	assert.equal((await upload(new Request("http://localhost/api/attachments", { method: "POST", body: form, headers: { "x-learnharness-desktop": secret } }))).status, 400);
	assert.equal((await upload(new Request("http://localhost/api/attachments", { method: "POST", body: "broken multipart", headers: { "x-learnharness-desktop": secret, "content-type": "multipart/form-data; boundary=broken" } }))).status, 400);
	await assert.rejects(fs.access(path.join(data, "uploads")));
});

it("rejects path/control names while preserving ordinary spaces, Unicode and backticks", () => {
	for (const name of ["", ".", "..", "../a", "a/b", "a\\b", "C:a", "a\0b", "a\nb", "a\u0085b", "a\u2028b", "x".repeat(256)]) assert.equal(validAttachmentName(name), false, JSON.stringify(name));
	for (const name of ["lecture notes.pdf", "図 `final`.png", "README", "zero.txt"]) assert.equal(validAttachmentName(name), true);
});

it("fails closed under restricted or corrupt file-access settings and never rewrites preferences", async () => {
	for (const settings of [{ agent: { fileAccess: { restricted: true, folders: [] } } }, { agent: { fileAccess: { restricted: "bad", folders: [] } } }]) {
		const raw = JSON.stringify(settings);
		await fs.writeFile(path.join(data, "settings.json"), raw);
		const response = await upload(request([new File(["notes"], "notes.txt")]));
		assert.equal(response.status, 403);
		await assert.rejects(fs.access(path.join(data, "uploads")));
		assert.equal(await fs.readFile(path.join(data, "settings.json"), "utf8"), raw);
	}
});

it("honors an allowed parent directory, still refusing protected filenames and cleaning the whole failed batch", async () => {
	await fs.writeFile(path.join(data, "settings.json"), JSON.stringify({ agent: { fileAccess: { restricted: true, folders: [data] } } }));
	assert.equal((await upload(request([new File(["notes"], "notes.txt")]))).status, 200);
	const before = await fs.readdir(path.join(data, "uploads"));
	assert.equal((await upload(request([new File(["notes"], "fine.txt"), new File(["private"], ".env")]))).status, 403);
	assert.deepEqual(await fs.readdir(path.join(data, "uploads")), before);
});

it("refuses a symlinked storage root without writing through it", async () => {
	const outside = path.join(root, "outside"); await fs.mkdir(outside, { recursive: true });
	await fs.symlink(outside, path.join(data, "uploads"), "dir");
	assert.equal((await upload(request([new File(["notes"], "notes.txt")]))).status, 500);
	assert.deepEqual(await fs.readdir(outside), []);
});

it("a failed copy or cancelled request removes only its own batch and preserves earlier files", async () => {
	const existing = (await (await upload(request([new File(["keep"], "keep.txt")]))).json()).paths[0];
	const bad = new File(["broken"], "broken.txt");
	Object.defineProperty(bad, "arrayBuffer", { value() { throw new Error("synthetic read failure"); } });
	const before = await fs.readdir(path.join(data, "uploads"));
	await assert.rejects(saveUploadedFiles([new File(["first"], "first.txt"), bad], () => {}, new AbortController().signal));
	const controller = new AbortController(); controller.abort();
	await assert.rejects(saveUploadedFiles([new File(["aborted"], "aborted.txt")], () => {}, controller.signal));
	assert.deepEqual(await fs.readdir(path.join(data, "uploads")), before);
	assert.equal(await fs.readFile(existing, "utf8"), "keep");
});
