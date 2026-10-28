/** Exercise packaged math speech without falling back to checkout modules. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProbeError, probeEnv } from "./smoke-demo-runtime.mjs";

export function verifySpeechRuntime(standalone, runtime = process.execPath) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-runtime-"));
	try {
		const env = { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" };
		delete env.SRE_JSON_PATH;
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone)], {
			cwd: home, env, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024,
		});
		if (result.status !== 0 || result.error)
			throw new Error(`speech runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		assert.match(result.stdout, /math and number speech passed/);
		process.stdout.write(result.stdout);
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
}

async function probe(standalone) {
	const root = fs.realpathSync(standalone);
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				const relative = path.relative(root, fs.realpathSync(fileURLToPath(result.url)));
				assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
					`dependency escaped standalone payload: ${result.url}`);
			} else assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			return result;
		},
	});
	try {
		const require = createRequire(path.join(root, "server.js"));
		const SRE = require("speech-rule-engine");
		await SRE.setupEngine({ domain: "clearspeak", locale: "en", modality: "speech", markup: "none" });
		await SRE.engineReady();
		assert.equal(SRE.toSpeech("<math><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow></math>"), "x squared plus one half");
		assert.equal(SRE.number("1000").replace(/-/g, " "), "one thousand");
		assert.equal(SRE.number("1250").replace(/-/g, " "), "one thousand two hundred fifty");
		console.log("[smoke-speech-runtime] math and number speech passed using only the standalone payload");
	} finally { hooks.deregister(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const operation = process.argv[2] === "--probe"
		? probe(process.argv[3])
		: Promise.resolve().then(() => verifySpeechRuntime(path.resolve(import.meta.dirname, "../.next/standalone")));
	operation.catch((error) => { console.error(`[smoke-speech-runtime] FAIL: ${formatProbeError(error)}`); process.exitCode = 1; });
}
