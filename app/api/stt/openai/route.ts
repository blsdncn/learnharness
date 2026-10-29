import { dictationConnection } from "@/src/core";
import { dictationCredential, effectiveSettings, readSettingsRecord, transcribeOpenAIDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const settings = effectiveSettings();
	const { language, ...current } = settings.dictation;
	const snapshot = request.headers.get("x-lh-dictation-connection");
	let connection = current;
	if (snapshot) {
		// A recording that explicitly pinned a connection can finish even if
		// the default provider changed while its microphone was active — as
		// long as that provider would still send it to the same place.
		const record = readSettingsRecord();
		const pinned = [current, dictationConnection("openai", undefined, undefined), dictationConnection("custom", record?.customSttProvider, record?.dictation?.customModel)]
			.find((candidate) => JSON.stringify(candidate) === snapshot);
		if (!pinned) {
			return Response.json({ message: "Dictation connection changed. Restore its settings to retry, or discard this recording." }, { status: 409 });
		}
		connection = pinned;
	}
	return transcribeOpenAIDictation(request, {
		...connection,
		language,
		...dictationCredential(connection.custom),
		enabled: Boolean(snapshot) || settings.general.dictationProvider !== "deepgram",
	});
}
