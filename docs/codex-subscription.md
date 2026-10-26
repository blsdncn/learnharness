# Codex subscription connection (local build)

This adds **OpenAI Codex (subscription)** independently of the existing OpenAI
API-key and ChatGPT connections. It reuses the installed Pi AI version's
`openai-codex` provider, OAuth implementation, native model catalog, and transport.
No extra dependency or local proxy is needed.

## Use

1. Open **LearnHarness Codex** → Settings → Providers → Subscriptions.
2. Choose **Sign in with Codex subscription**, read the notice, then continue to
   OpenAI. Complete sign-in yourself in the browser.
3. The browser callback normally completes automatically. If another Codex client
   owns port 1455, the form accepts the final redirect URL as Pi's manual fallback.
4. Choose `openai-codex` models for Strong, Cheap, and Vision in setup or Agent
   settings. Vision requires an image-capable model. Model choice is explicit;
   connecting does not replace existing pins or start a lesson.

Teaching, research, extraction, and other background roles selected to use Codex
consume subscription allowance. OpenAI controls entitlement and limits; this is
not an offline model or a way to bypass plan restrictions. Authentication and
live generation still need to be verified with the user's own account.

## Credentials and safety

- Main owns OAuth and serialized refresh. The server receives only short-lived
  access-token leases over its inherited Node IPC connection.
- Renderer controls expose safe status, login/cancel, manual-code submission, and
  local disconnect. They cannot read credentials or request a token lease.
- The packaged desktop's existing origin/main-frame checks protect controls;
  its per-launch capability still protects every HTTP endpoint. No token endpoint
  is added. Browser-only and externally launched development servers cannot use
  this connection.
- `codex-credentials.json` is an atomic, mode-0600, **unencrypted** local file in
  Electron userData. Pi's and the Codex CLI's files are never read or modified.
  Disconnect removes LearnHarness's saved credential, not the subscription, and
  is not a claim of remote token revocation.
- Login/disconnect invalidate older leases and cancel active streams. Concurrent
  refresh is serialized; a failed credential save denies subsequent leases.
- The native subscription transport never falls back to an OpenAI API key.
  Subscription calls are excluded from API-dollar estimates and labeled as
  ChatGPT plan usage.

## Build on Linux

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
node scripts/build-server.mjs
node scripts/smoke-provider-runtime.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --config electron-builder.codex.yml --linux AppImage --x64 --publish never
```

The local packaging config sets a distinct **LearnHarness Codex** app identity and
profile (`~/.config/LearnHarness Codex` on Linux). It leaves the release app and its
learning records untouched. Upstream auto-updates are disabled for this custom
build so an official release cannot overwrite the patch. Rebuild to update it.

## Implementation and checks

- `electron/codex.cjs`: private file storage, Pi OAuth adapter, serialized refresh,
  cancellation, safe renderer controls, and private child IPC.
- `src/agent/codex.ts`: epoch-scoped credential leases and native Pi streaming.
- `src/agent/models.ts`: shared engine dispatch for all model roles.
- `src/server/model-catalog.ts`, `src/server/keys.ts`: connection-gated discovery.
- `components/settings/codex-connection.tsx`: setup and Providers sign-in surface.
- `src/core/prices.ts`: subscription accounting for `openai-codex:` records.
- `tests/codex-*`: deterministic lifecycle, transport, tools/images/history,
  no-fallback, storage, picker gating, accounting, and UI checks.
- `scripts/smoke-provider-runtime.mjs`: loads the real packaged OAuth and transport
  closures and stops generation before any network call. This catches missing
  standalone files that source-tree tests cannot detect.

On this machine the upstream `render-sidebar` test's date-dependent assertion
also fails on an untouched checkout of c549494. It is unrelated to Codex.
