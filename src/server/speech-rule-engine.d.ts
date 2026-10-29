// speech-rule-engine ships no type entry for its main bundle (lib/sre.js);
// this declares only what server/speech.ts calls.
declare module "speech-rule-engine" {
	const SRE: {
		setupEngine(options: Record<string, string>): Promise<void>;
		engineReady(): Promise<void>;
		toSpeech(mathml: string): string;
		number(value: string): string;
	};
	export default SRE;
}
