/** GET → {models} from the saved TTS server's /models (see server/audio-models.ts). */
import { audioKeyId } from "@/src/core";
import { effectiveSettings, keyValue, listAudioModels, TTS_KEY_ID } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { baseUrl, keySource } = effectiveSettings().speech;
	return listAudioModels({ baseUrl, keySource, apiKey: keyValue(audioKeyId(keySource, TTS_KEY_ID)), settingsName: "TTS" });
}
