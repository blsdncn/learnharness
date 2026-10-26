/**
 * POST /api/remote/pair — mint a one-time pairing link without touching the
 * laptop screen. Laptop-local only: the gateway proxies /api with the desktop
 * secret re-attached, so this route additionally refuses any request carrying
 * the gateway's forwarding headers (see isDirectDesktopCall). Phones keep
 * using pairing links; they can never mint them.
 */
import { isDirectDesktopCall, requestRemotePair } from "@/src/server/remote-admin.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!isDirectDesktopCall(request.headers)) {
		return Response.json({ error: "Remote pairing links are created on the laptop." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	try {
		return Response.json(await requestRemotePair());
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Remote pairing failed." },
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	}
}
