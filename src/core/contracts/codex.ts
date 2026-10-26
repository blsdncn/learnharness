/** Client-safe Codex subscription status. Never contains tokens or auth URLs. */
export interface CodexStatus {
	available: boolean;
	pending: boolean;
	connected: boolean;
	manualCode: boolean;
	error: string | null;
}
export interface CodexControlBridge {
	status(): Promise<CodexStatus>;
	login(): Promise<CodexStatus>;
	cancel(): Promise<CodexStatus>;
	submit(value: string): Promise<CodexStatus>;
	disconnect(): Promise<CodexStatus>;
	onChange(callback: () => void): () => void;
}
