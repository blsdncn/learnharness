export interface RemoteDevice {
	id: string;
	label: string;
	createdAt: number;
	expiresAt: number;
}

/** No desktop capability, provider credentials, or session cookie crosses IPC. */
export interface RemoteAccessStatus {
	available: boolean;
	enabled: boolean;
	url: string | null;
	error: string | null;
	devices: RemoteDevice[];
	/** One-time pairing grant, returned only after the user's explicit action. */
	pairingUrl?: string;
	pairingExpiresAt?: number;
}

export interface RemoteAccessBridge {
	status(): Promise<RemoteAccessStatus>;
	enable(): Promise<RemoteAccessStatus>;
	disable(): Promise<RemoteAccessStatus>;
	pair(): Promise<RemoteAccessStatus>;
	revoke(id: string): Promise<RemoteAccessStatus>;
	onChange(callback: () => void): () => void;
}
