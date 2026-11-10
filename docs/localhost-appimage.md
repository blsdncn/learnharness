# Local browser AppImage (v0.5.0)

This custom Linux x64 build starts from upstream v0.5.0. It adds optional
localhost hosting, without the later TTS, remote-access, or light-mode changes.

Launching normally opens the desktop UI. To run without an Electron window:

```sh
chmod +x LearnHarness-Local-0.5.0-x86_64.AppImage
./LearnHarness-Local-0.5.0-x86_64.AppImage --local-host
# Equivalent environment option:
LH_LOCAL_HOST=1 ./LearnHarness-Local-0.5.0-x86_64.AppImage
# Override the default port:
LH_LOCAL_PORT=3005 ./LearnHarness-Local-0.5.0-x86_64.AppImage --local-host
```

The launcher opens the default browser at `http://127.0.0.1:3000`, or the
chosen port, after the server is ready. If browser opening fails, open the
printed URL manually. The server binds only to IPv4 loopback. An occupied
port fails startup with instructions to choose another port.

Keep the AppImage process running. Ctrl+C or SIGTERM stops hosting and its
server; closing the browser does not. Only one instance can use this build's
profile at a time. Quit the desktop instance before switching to hosting.
This is windowless Electron, so a graphical Linux session is still required.

Both modes use the separate `LearnHarness Local` Electron profile (normally
`~/.config/LearnHarness Local`). Existing LearnHarness and LearnHarness Codex
profiles are not migrated. Auto-updates are disabled for this custom build.
Local browser mode uses v0.5.0's existing web subscription owner and saves
subscription credentials beside this profile's `auth.json`. Desktop-only
file pickers are unavailable in a browser; paste local paths instead.

## Access through an SSH tunnel

On the machine running the AppImage:

```sh
LH_LOCAL_PORT=42311 ./LearnHarness-Local-0.5.0-x86_64.AppImage --local-host
```

On your browser's machine:

```sh
ssh -N -L 42311:127.0.0.1:42311 user@host
```

Open `http://127.0.0.1:42311` locally. Hosting mode uses the existing web
credential owner and does not require Electron's private desktop API header.
Normal desktop launches still require that header, so tunneling the port
printed by a normal desktop launch will still produce API 403s. Automatic
browser opening happens on the host; open the forwarded URL yourself locally.

## Build

On Linux x64 with Node 26 and the lockfile dependencies installed:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --config electron-builder.local.yml --linux AppImage --x64 --publish never
```

The output is `dist/LearnHarness-Local-0.5.0-x86_64.AppImage`. As with v0.5.0's
web/dev server, connected local browsers share the same credentials and
learning data. This build provides no LAN/public listener or remote pairing.

With Chrome/Chromium installed and a graphical session (or Xvfb), verify
both launch options, browser API reads/writes through TCP forwarding,
automatic browser opening, and shutdown using an isolated profile:

```sh
LH_TEST_CHROME=/path/to/chrome node scripts/smoke-local-host.mjs
```

## Validation of this branch

Production build, typecheck, and packaging passed. Lint passed with one
existing warning in `tests/source-name-ui.test.tsx`. All 26 focused
launcher/desktop API/platform tests and 28 Electron native-rendering tests
passed. Packaged provider initialization, compression, and the demo helper
passed with no model generation.

The actual AppImage passed the isolated browser smoke in desktop, CLI-host,
and environment-host modes. Both hosting modes returned 200 for graph,
models, settings, subscription status, and a settings write through a TCP
forwarder. Desktop mode retained its external-browser API 403. Automatic
browser opening and server shutdown passed, including extract-and-run
supervisor termination.

The full suite was not clean: 3,546 tests passed and four were skipped;
an assertion in the unmodified `tests/chat-flow.test.ts` failed (also when
run alone), and the `tests/jobs.test.ts` worker remained alive after its
test output and was terminated. These files were not changed for hosting.
