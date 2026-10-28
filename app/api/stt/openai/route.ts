import { effectiveSettings, keyValue, transcribeOpenAIDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const settings = effectiveSettings();
	const { language, ...connection } = settings.dictation;
	const snapshot = request.headers.get("x-lh-dictation-connection");
	if (snapshot && snapshot !== JSON.stringify(connection)) {
		return Response.json({ message: "Dictation connection changed. Restore its settings to retry, or discard this recording." }, { status: 409 });
	}
	return transcribeOpenAIDictation(request, {
		...connection,
		language,
		apiKey: keyValue(connection.keyId),
		// A recording that explicitly pinned this connection can finish even
		// if the default provider changed while its microphone was active.
		enabled: Boolean(snapshot) || settings.general.dictationProvider === "openai",
	});
}
