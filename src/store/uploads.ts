import * as fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";

export const uploadsDirectory = PATHS.uploads;

/** Each batch owns a new private directory; only that directory is removed on
 * failure. Per-file subdirectories also allow duplicate names within a batch. */
export async function saveUploadedFiles(files: readonly File[], checkPath: (file: string) => void, signal: AbortSignal): Promise<string[]> {
	checkPath(uploadsDirectory);
	await fs.mkdir(uploadsDirectory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(uploadsDirectory);
	if (!stat.isDirectory() || stat.isSymbolicLink()
		|| (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))) {
		throw new Error("The upload directory must be private and owned by this user.");
	}
	const batch = await fs.mkdtemp(path.join(uploadsDirectory, "upload-"));
	try {
		const paths = files.map((file, index) => path.join(batch, String(index), file.name));
		// Validate every final path before copying anything, including protected names.
		for (const file of paths) checkPath(file);
		for (const [index, file] of files.entries()) {
			signal.throwIfAborted();
			const bytes = new Uint8Array(await file.arrayBuffer());
			signal.throwIfAborted();
			await fs.mkdir(path.dirname(paths[index]!), { mode: 0o700 });
			await fs.writeFile(paths[index]!, bytes, { flag: "wx", mode: 0o600, signal });
		}
		signal.throwIfAborted();
		return paths;
	} catch (error) {
		await fs.rm(batch, { recursive: true, force: true });
		throw error;
	}
}
