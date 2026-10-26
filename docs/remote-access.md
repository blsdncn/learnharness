# Phone and private browser access

The packaged desktop app can serve its full existing web UI over Tailscale:
sessions, teaching and practice, the knowledge graph, background activity,
settings, and model selection all use the same running desktop backend.
The laptop must remain awake with LearnHarness running. Codex subscription
sign-in and credential refresh stay in the desktop process.

## Connect

1. Connect the laptop and phone to the same Tailscale network. Enable HTTPS
   certificates for that network if Tailscale requests it.
2. In the packaged app, open **Settings → Remote Access → Enable remote access**.
   LearnHarness uses private Tailscale Serve HTTPS on port **8443**. It refuses
   a port occupied by another app or configured for public Funnel.
3. Choose **Create one-time pairing link**, copy it privately to the phone,
   open it in Safari or Chrome, and select **Pair this device**. Links expire
   after five minutes and can be used once. A new link replaces the old one,
   so use only the newest link and close older pairing tabs first. The page
   shows the link's last six characters before pairing; tap only if they match
   what the laptop displayed. Pairing failures name their HTTP status on the
   page; the laptop log records the server-side reason without credential
   material.
4. Bookmark the private app address. The paired browser can use the full app.
   Enable browser storage and service workers; they authenticate navigation,
   assets, API requests, and event streams.

Use **Revoke** beside a paired device to immediately disconnect its streams
and deny future requests. **Disable remote access** closes the gateway and
revokes all devices. Pairing is remembered across desktop restarts and ends
after 30 days, when revoked, or when remote access is disabled. Remote access
itself is restored on launch if its enabled setting was saved successfully.

Upgrading from the first remote-access build requires one final pairing,
because that build kept device grants only in memory. Subsequent restarts of
the updated app remember the pairing.

Pairing and access management are laptop-only. A paired device has the same
learning-data and settings permissions as the app. Provider API keys remain
server-side; existing key endpoints continue to return masked status only.
Subscription sign-in remains a laptop operation; connected models can be
selected and used from the phone.

## This Linux installation

The application launcher is **LearnHarness Codex Remote**, also available as:

```sh
~/.local/bin/learnharness-codex-remote
```

It uses the existing LearnHarness Codex profile and the separate
`learnharness-tailscale.service` user service. That service runs Tailscale in
userspace mode and does not change the machine's system VPN or T3 connection.
The launcher supplies its private socket with `LH_TAILSCALE_SOCKET` and clears
`ELECTRON_RUN_AS_NODE` so it also launches correctly from coding-agent shells.

```sh
systemctl --user status learnharness-tailscale.service
tailscale --socket="$XDG_RUNTIME_DIR/learnharness-tailscale/tailscaled.sock" status
```

Other installations can use their normal system Tailscale daemon; the socket
override is optional. Tailscale must be installed and available on `PATH`.

## Implementation

- `electron/remote-access.cjs` owns a loopback-only gateway, pairing grants,
  persistent browser grants, expiry, revocation, and streaming proxy cleanup.
- `electron/remote-worker.cjs` authenticates same-origin requests using a token
  in origin-scoped IndexedDB. No session cookies are used: cookies are shared
  across HTTPS ports on one hostname. Requests use `same-origin` mode so custom
  authentication headers survive script/style/image request guards and cannot
  follow redirects to another origin or port.
- The desktop capability is inserted only for upstream API requests and never
  returned to a browser. Remote grants are stripped before forwarding.
- Pairs are minted through the laptop window, or through the laptop-local
  `POST /api/remote/pair` relay (per-launch desktop secret over direct
  loopback; callers arriving through the gateway are refused, so paired
  phones can never mint). The relay speaks to the shell over the existing
  inherited Node IPC channel. Revocation and disable stay laptop-UI-only.
- Unsafe browser POSTs outside the app origin are rejected, except an opaque
  (`null`) origin paired with browser-certified same-origin fetch metadata,
  which sandboxed webviews produce. Missing metadata and cross-site posts
  stay rejected; tailnet-only ingress is unchanged.
- `remote-access.json` stores the enabled setting, owned loopback target,
  non-reversible token hashes, and safe device metadata with mode 0600.
  Pairing and revocation commit through a flushed temporary file, atomic rename,
  and directory flush before acknowledgement. A failed commit closes access
  and invalidates the previous grant file through deletion or direct replacement.
  If storage also prevents invalidation, the UI explicitly reports that durable
  revocation failed; previously saved devices could reconnect after a restart.
- Tailscale setup inspects existing listeners, refuses public Funnel on its
  port, and removes only its owned root route during shutdown.
- The remote-control IPC surface is restricted to trusted desktop main frames.

## Validation

Commands run for this change:

```sh
npm run typecheck
npm run lint
npm run build
NODE_ENV=test node --import tsx --test tests/remote-access.test.ts tests/desktop-api.test.ts tests/chatgpt-ui.test.tsx tests/chatgpt-connection-ui.test.tsx tests/desktop-platform.test.ts tests/render-settings.test.tsx tests/render-composer.test.tsx
npm test
node scripts/build-server.mjs
node scripts/smoke-provider-runtime.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --config electron-builder.codex.yml --linux AppImage --x64 --publish never -c.linux.artifactName='LearnHarness-Codex-Remote-${version}-${arch}.${ext}'
```

Typecheck, lint, production build, the 106 focused tests, runtime smoke checks,
and AppImage packaging passed. The full suite passed 2,072 of 2,073 tests. The
remaining failure is the already documented date-sensitive assertion in
`tests/render-sidebar.test.tsx` expecting January 2 even when local time renders
the fixture as January 1. The unrelated ChatGPT auth assertion that failed in
the first full run passed on targeted and full reruns.

Browser QA used the production standalone server and isolated learning data,
with a mock Tailscale transport. Pairing, full application hydration and assets,
320px and 390px layouts, session loading, origin-bound redirects, and revocation
with an active service worker were exercised. A redirect to a different port
was blocked before the receiving service got any request. API access changed
from 200 to 401 immediately after revocation. No live model generation was run.

The built AppImage was also launched against the existing Codex profile. Its
six Electron source files were compared byte-for-byte with the running bundle.
Its real gateway returned 401 for an unpaired API call, 403 for direct ingress
without Tailscale HTTPS headers, and 200 for the pairing page and worker script.
Tailscale reported the private HTTPS listener active and public Funnel disabled.
An actual phone and live model generation still require the user's device.

References: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
[userspace networking](https://tailscale.com/docs/concepts/userspace-networking).

## Session-profile repair and remembered pairing

The initial remote build opened the separate LearnHarness Codex profile, while
the existing learning session was in the original LearnHarness profile. The
session and settings were copied into the remote profile, preserving the source
byte-for-byte and preserving any existing destination files. The active desktop
API confirmed that the restored session is listed. Authentication files were
not part of this learning-data copy.

The remembered-pairing follow-up adds a regression that preserves an authorized
browser across a full controller restart, revokes it, restarts again, and verifies
401. Failure tests cover an unsuccessful pairing commit, failed revocation
commits, the direct-file invalidation fallback when unlink also fails, failed
directory flushes, both recovery paths failing, logout, and expiry after reload.

Follow-up validation commands:

```sh
NODE_ENV=test node --import tsx --test tests/remote-access.test.ts tests/desktop-api.test.ts tests/desktop-platform.test.ts tests/render-settings.test.tsx tests/codex-ui.test.tsx
npm run typecheck
npm run lint
npm run build
node scripts/build-server.mjs
node scripts/smoke-provider-runtime.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --config electron-builder.codex.yml --linux AppImage --x64 --publish never -c.linux.artifactName='LearnHarness-Codex-Remote-Remembered-${version}-${arch}.${ext}'
git diff --check
```

All 58 focused tests, static checks, production build, smoke checks, packaging,
and whitespace validation passed. The full suite was not rerun for this follow-up;
its earlier result is recorded above. In the isolated production browser, the
same service worker and browser credential retained API status 200 after a
gateway-process restart without a new pairing link. Revocation produced 401
both immediately and after another restart. The installed, running AppImage
was compared with current Electron sources and the real desktop API confirmed
that the original session is listed.
