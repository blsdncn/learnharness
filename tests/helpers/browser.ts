/**
 * Browser stand-ins for suites that run components or the listening
 * reader over linkedom.
 */

/** Replace `values` on `target` (globalThis, URL…) for a suite; the
 *  returned function restores exactly what was there, absent included. */
export function replaceProperties(target: object, values: Record<string, unknown>): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, Object.getOwnPropertyDescriptor(target, key));
		Object.defineProperty(target, key, { configurable: true, writable: true, value });
	}
	return () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else delete (target as Record<string, unknown>)[key];
		}
	};
}

/** The reader's audio element, recording what was done to it: each
 *  play() with the src it played, pause(), and the src's removal.
 *  `end()` finishes the clip as a browser does (paused, then "ended"). */
export class FakeAudio {
	src = "";
	playbackRate = 1;
	preservesPitch = true;
	paused = true;
	readonly played: string[] = [];
	private listeners = new Map<string, () => void>();
	addEventListener(type: string, fn: () => void) {
		this.listeners.set(type, fn);
	}
	play() {
		this.paused = false;
		this.played.push(this.src);
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
	removeAttribute(name: string) {
		if (name === "src") this.src = "";
	}
	end() {
		this.paused = true;
		this.listeners.get("ended")?.();
	}
}
