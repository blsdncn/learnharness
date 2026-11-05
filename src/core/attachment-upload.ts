/** File bytes per upload, plus bounded multipart metadata (same as notes imports). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY_BYTES = 26 * 1024 * 1024;
export const ATTACHMENT_SIZE_ERROR = "Too big. Max 25 MB per upload.";

/** Keep the original display name, but never accept a client-controlled path. */
export function validAttachmentName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".."
		&& !/[\\/:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)
		&& new TextEncoder().encode(name).byteLength <= 255;
}
