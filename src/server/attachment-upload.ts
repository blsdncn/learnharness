import { ATTACHMENT_SIZE_ERROR, MAX_ATTACHMENT_BODY_BYTES, MAX_ATTACHMENT_BYTES, validAttachmentName } from "../core/attachment-upload.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { resolvePolicy } from "../agent/tools/file-access.ts";
import { saveUploadedFiles } from "../store/uploads.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { fileAccessPolicy } from "./file-access.ts";

class UploadLimitError extends Error {}

/** Bound actual bytes, including bodies with no Content-Length, before parsing. */
async function uploadForm(request: Request): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > MAX_ATTACHMENT_BODY_BYTES) {
		void request.body?.cancel().catch(() => undefined);
		throw new UploadLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing upload body");
	try {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_ATTACHMENT_BODY_BYTES) throw new UploadLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function attachmentUploadResponse(request: Request): Promise<Response> {
	const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
	if (!desktopAPIAuthorized(request.headers)) return fail(403, "Upload requires an authenticated LearnHarness connection.");
	let form: FormData;
	try { form = await uploadForm(request); }
	catch (error) { return fail(error instanceof UploadLimitError ? 413 : 400,
		error instanceof UploadLimitError ? ATTACHMENT_SIZE_ERROR : "Could not read the upload. Select the files again."); }
	const entries = form.getAll("files");
	if (entries.length === 0 || entries.some((file) => !(file instanceof File))) return fail(400, "Select files to upload.");
	const files = entries as File[];
	if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) return fail(413, ATTACHMENT_SIZE_ERROR);
	if (files.some((file) => !validAttachmentName(file.name))) return fail(400, "A filename is invalid. Rename the file and try again.");
	try {
		const policy = resolvePolicy(fileAccessPolicy());
		const paths = await saveUploadedFiles(files, (file) => { resolveSourcePath(file, policy); }, request.signal);
		return Response.json({ paths }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof Error && /^(Access denied:|File-access configuration)/.test(error.message)) return fail(403, error.message);
		console.error("[attachments] upload storage failed:", error instanceof Error ? error.message : "unknown error");
		return fail(500, "Could not save the files. Please try again.");
	}
}
