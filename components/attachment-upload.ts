"use client";

import { useEffect, useRef, useState } from "react";
import { ATTACHMENT_SIZE_ERROR, MAX_ATTACHMENT_BYTES, quoteFilePath, validAttachmentName } from "@/src/core";

export async function uploadAttachmentFiles(files: readonly File[], signal?: AbortSignal): Promise<string[]> {
	if (files.length === 0) return [];
	if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error(ATTACHMENT_SIZE_ERROR);
	if (files.some((file) => !validAttachmentName(file.name))) throw new Error("A filename is invalid. Rename the file and try again.");
	const body = new FormData();
	for (const file of files) body.append("files", file);
	const response = await fetch("/api/attachments", { method: "POST", body, signal });
	const result = await response.json().catch(() => null) as { paths?: unknown; error?: string } | null;
	if (!response.ok) throw new Error(result?.error || "Could not upload the files. Please try again.");
	if (!Array.isArray(result?.paths) || result.paths.length !== files.length || result.paths.some((p) => typeof p !== "string")) throw new Error("Could not confirm the upload. Please try again.");
	for (const path of result.paths) quoteFilePath(path);
	return result.paths as string[];
}

/** Abort on unmount and ignore late replies, so a route change cannot insert
 * an attachment into a different session. Files already saved remain durable. */
export function useAttachmentUpload() {
	const pending = useRef<AbortController | null>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
	const upload = async (files: readonly File[]): Promise<string[] | null> => {
		if (pending.current) return null;
		if (files.length === 0) return [];
		const controller = new AbortController();
		pending.current = controller;
		setUploading(true); setError("");
		try {
			const paths = await uploadAttachmentFiles(files, controller.signal);
			return pending.current === controller ? paths : null;
		} catch (reason) {
			if (pending.current === controller && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not upload the files. Please try again.");
			return null;
		} finally {
			if (pending.current === controller) { pending.current = null; setUploading(false); }
		}
	};
	return { upload, uploading, error, clearError: () => setError("") };
}
