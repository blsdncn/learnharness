# Custom and local models

LearnHarness supports **one custom OpenAI-compatible endpoint with multiple models**, including a local model server. The setup/UI builds on PR #62 by Daniel Buckner and Abhishek Thakur. Pi handles inference, message conversion, tools, streaming, and reasoning effort. [Claude Code](claude-code.md) is a separate provider.

## Connect

1. Open **Settings → Providers → + Add a provider → Custom endpoint**, or use the first-run provider picker.
2. Choose **TCP** or **Unix socket** and enter the complete API base URL, such as `http://localhost:11434/v1`. LearnHarness **does not append `/v1`**. TCP supports HTTP/HTTPS and private-network addresses; embedded credentials, query strings, fragments, and discovery redirects are rejected. Unix socket setup is described below.
3. Choose **Keyless** or **API key**. Keyless ignores saved/environment custom keys. API key uses `CUSTOM_OPENAI_API_KEY`; a real environment value overrides a saved value, and the editor identifies environment ownership.
4. Optionally enter model IDs, separated by commas or whitespace, for servers without working model discovery.
5. Click **Connect**, then select Strong, Cheap, and Vision models.

A key is bound to the canonical endpoint URL, socket path (when selected), and authentication mode. Changing the URL, socket path, or transport requires a new effective key or explicit consent to reuse it; it is never silently forwarded. Clearing authentication selects Keyless. Use this editor—not generic key management—to change custom credentials.

Connect requests `GET <base>/models`; reported metadata wins over duplicate entered IDs. A nonfatal discovery failure can fall back to entered IDs. At the same URL, fallback preserves the previous model snapshot/pins; a different URL starts its own snapshot. **401/403, redirects, response-size, and model-count violations fail even with entered IDs.** A failed connect without fallback leaves configuration unchanged.

Discovery is not a continuous health or capability check. LearnHarness does not install a backend, download models, or perform custom-endpoint OAuth.

## HTTP over a Unix socket

On Linux or macOS, choose **Unix socket** in the same custom endpoint editor:

- Socket path: the existing absolute filesystem path, for example `/run/llm.sock`.
- Base URL: `http://localhost/v1`, or the HTTP Host and API prefix your server expects.
- Authentication: the same Keyless or API key options as TCP.

The socket must serve an OpenAI-compatible HTTP API, including streaming chat
completions. The base URL supplies the Host header and request path; it does
not cause a TCP connection. Both discovery and generation connect through the
socket. Unix socket transport requires plain `http://`; TLS over sockets,
abstract sockets, Windows named pipes, and WebSocket APIs are not supported.

Outgoing request bodies are automatically buffered and sent with their exact
byte `Content-Length`, without chunked request encoding. This supports socket
gateways that cannot decode chunked bodies. Response SSE remains streamed,
including text and tool calls. Buffering uses memory proportional to the
request size, including any inline image data; cancellation remains supported
during buffering and response streaming.

The socket is on the machine running LearnHarness, including when the UI is
in another machine's browser. LearnHarness connects to an existing socket; it
does not create/delete it or change its permissions. Relative paths, `~`, and
environment-variable expansion are not supported. Missing or inaccessible
sockets produce connection errors with no TCP fallback. Manual model IDs
retain the existing offline-configuration behavior.

You can check a keyless backend before connecting it:

```sh
curl --unix-socket /run/llm.sock http://localhost/v1/models
```

Socket configurations use a version 2 private credential binding. Existing TCP
bindings remain compatible. Older builds reject the newer binding rather than
reinterpreting the socket configuration as TCP; reconnect explicitly if you
switch back to an older build. When an environment key changes sockets, a
shadowed file key remains bound to its original socket.

The transport uses a request-scoped [Undici dispatcher](https://undici.nodejs.org/api/Dispatcher)
and leaves the existing provider's message encoding and SSE parser in place.

## Budgets and reasoning

Edit each model's pins offline:

| Setting | Resolution |
| --- | --- |
| Context budget | User pin → reported limit → **8192 fallback** |
| Maximum output | User pin → reported limit → **4096 fallback** |
| Reasoning support | User declaration → reported support |

Positive integer token pins are accepted, including small output limits; blank removes a pin. The editor labels reported, fallback, and pinned values. **These are request/compaction budgets, not commands to resize the backend's context.** Configure the server separately and match its active limits. Reconnecting prunes pins only to the resulting model IDs.

Reasoning support declares a capability; it does not enable execution. The normal Pi effort picker remains available, but **Off may not disable a backend's default thinking**. There is no model-name inference, Ollama preset, thinking-map/compatibility editor, or nonstandard-header editor.

## Images

All custom models are Vision-selectable; reported image-capable models appear first. Choose a backend that actually understands images.

Every custom-engine image-bearing request attempts delivery even when discovery omitted image support. This includes file reads, PDF pages, and visual previews. A request-local model allowance lets Pi encode images without changing the catalog's capability claims. Text-only servers may reject them; errors surface without silent text-only fallback. Payload delivery tests do not establish real-model image quality.

## Editing, credentials, and recovery

Nonsecret configuration lives in `settings.json.customProvider`; saved keys and an internal binding live in `auth.json`. Authorization requires matching binding IDs, URL, socket path, and mode. A crash between auth/settings writes leaves the provider disabled rather than sending a key to a mismatched endpoint. Keyless also needs a valid nonsecret binding but never resolves a key. Missing private storage can initialize; malformed/unreadable storage fails closed without overwrite.

If authorization is interrupted, reload and explicitly reconnect. An environment key changing endpoints does not authorize a shadowed saved key for that new URL. Disconnect prevents a latent environment key from reviving the provider. These are crash/restart guards, not a power-loss/fsync transaction guarantee.

Stale editor saves return **409**: reload and retry. Mutations preserve unrelated settings changes; failed edits do not claim success. Each new model operation resolves current endpoint, credentials, limits, and effort; in-flight requests keep their setup. Disconnecting/removing a model does not remap saved selections or rewrite history.

Discovery limits are **15 seconds**, **8 MiB**, and **10,000 models**; configuration bodies are bounded to **64 KiB**. Desktop capability/same-origin browser checks are not multi-user authentication.

## Pricing and older development configurations

Prices are **unknown/unpriced**, not $0—even for a local server. Internal zero rates are Pi-required placeholders; there is no rate editor. See [accounting](compaction-accounting.md).

The earlier unshipped `models.json` configuration is not read or migrated. Existing early development profiles need explicit endpoint configuration/reconnect and model reselection; files/history are not deleted or silently remapped.

## Maintainer entry points

- [`server/custom-provider.ts`](../src/server/custom-provider.ts): discovery/registration; [`custom-provider-http.ts`](../src/server/custom-provider-http.ts): HTTP revisions and mutation boundaries.
- [`custom-provider-auth.ts`](../src/server/custom-provider-auth.ts) and the [binding contract](../src/core/custom-provider-auth.ts): credential authorization and restart behavior.
- [`agent/models.ts`](../src/agent/models.ts): per-operation engine resolution and image allowance.

`tests/custom-provider-*.test.*` covers fake endpoints, binding/restart failures, concurrent editing, UI, and payload delivery—not backend installation or real-model capabilities.

`tests/unix-socket-provider.test.ts` uses real filesystem sockets to check
discovery, streaming, tool calls, cancellation, restart persistence, key
binding, redirects, and absence of TCP fallback. After a production build and
server curation, run `node scripts/smoke-unix-provider.mjs` to check discovery
and synthetic chat generation in the built server, including restart. Use
`--appimage /path/to/LearnHarness-Local-0.5.0-x86_64.AppImage` to exercise the
packaged application instead; it needs a graphical session or Xvfb. All these
checks use disposable profiles and a synthetic provider, not real inference.

For this variation, follow the [AppImage build pipeline](localhost-appimage.md#build)
and give Electron Builder a separate output directory:

```sh
npx electron-builder --config electron-builder.local.yml --linux AppImage --x64 --publish never -c.directories.output=dist/unix-socket
```

The resulting artifact is
`dist/unix-socket/LearnHarness-Local-0.5.0-x86_64.AppImage`. Validation passed:
94 custom-provider/socket/UI tests, 122 settings/authentication/API regression
tests, and 28 native-rendering tests; production build, typecheck, and lint
(one existing warning); standalone and actual AppImage discovery/chat over
AF_UNIX before and after restart with zero TCP traffic; packaged provider and
demo checks; and the existing AppImage desktop/localhost-forwarding smoke.

The request-buffering fix adds checks for exact UTF-8 byte lengths, unchanged
`gpt-5.6-luna` JSON payloads, cancellation before/during buffering, and input
stream errors. The production and AppImage smoke fixture rejects chunked
requests with a `403 missing model for request` response, and verifies
discovery/chat generation before and after restart with fixed-length requests.
