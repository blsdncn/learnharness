/** The dictation custom endpoint: the chat custom endpoint's connect/disconnect
 * flow (server/custom-provider-http.ts) with its own settings entry, key and
 * binding. No per-model pins, so no PATCH. */
import { customSttEndpointGet, customSttEndpointMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customSttEndpointGet;
export const POST = customSttEndpointMutation;
export const DELETE = customSttEndpointMutation;
