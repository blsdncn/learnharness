/** The live audio smokes' custom endpoint: connected through its real route
 * (URL binding, /models probe with the model as a typed fallback), exactly
 * as Settings → Providers does. The key is the env's, never written here. */
import assert from "node:assert/strict";

export async function connectSmokeEndpoint(routePath, baseUrl, key, model) {
	const route = await import(routePath);
	const origin = "http://app.test";
	const url = `${origin}/api/endpoint`;
	const etag = route.GET(new Request(url)).headers.get("etag");
	const response = await route.POST(new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json", origin, "if-match": etag },
		body: JSON.stringify({ baseUrl, authMode: key ? "apiKey" : "keyless", ...(key ? { reuseKey: true } : {}), manualModels: model }),
	}));
	assert.equal(response.status, 200, `Connect failed: ${(await response.json()).error}`);
}
