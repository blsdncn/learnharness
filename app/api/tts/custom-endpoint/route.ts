/** The TTS custom endpoint: the chat custom endpoint's connect/disconnect
 * flow (server/custom-provider-http.ts) with its own settings entry, key and
 * binding. No per-model pins, so no PATCH. */
import { customTtsEndpointGet, customTtsEndpointMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customTtsEndpointGet;
export const POST = customTtsEndpointMutation;
export const DELETE = customTtsEndpointMutation;
