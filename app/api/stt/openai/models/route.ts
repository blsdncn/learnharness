/** GET → {models} from the saved dictation server's /models (see server/audio-models.ts). */
import { audioKeyId } from "@/src/core";
import { effectiveSettings, keyValue, listAudioModels } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { baseUrl, keySource } = effectiveSettings().dictation;
	return listAudioModels({ baseUrl, keySource, apiKey: keyValue(audioKeyId(keySource, "STT_API_KEY")), settingsName: "Dictation" });
}
