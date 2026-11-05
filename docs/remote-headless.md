# Private remote access on a headless Linux host

Paired phone and laptop browsers can attach files to a chat using its paperclip
or drag-and-drop. Select multiple files up to 25 MiB total per upload. The app
shows upload status/errors and inserts references into the draft; send the message
when ready. Browser folder uploads are not supported. Desktop file/folder picking
continues to reference existing local paths.

Uploaded files persist privately under `LH_DATA_DIR/uploads/`, so include that
directory when backing up the profile. Names are preserved inside unique upload
directories; repeated filenames cannot overwrite earlier attachments. Existing
File access settings still apply. If restrictions block the upload location,
adjust the allowed folders explicitly rather than changing other preferences.
Uploads are retained across restarts and session deletion, including abandoned
draft attachments. Uploading does not run extraction or infer a model response.

`scripts/remote-headless.cjs` starts the production standalone server and
the existing authenticated Tailscale gateway without Electron. It supports
API-key providers, TTS, dictation, learning sessions and the graph. ChatGPT
uses the private IPC bridge and manual sign-in handoff described below.
Other desktop subscriptions remain unavailable. The host must join the same tailnet
as the browsers that will access it.

Build the payload with `npm run build` and `node scripts/build-server.mjs`.
Then run `node scripts/remote-headless.cjs serve`. The backend binds only
to `127.0.0.1`, defaults to port 3000 and requires a fresh private capability
on every API request. That capability stays inside the supervisor and its
server child. Direct unauthenticated backend API calls receive 403.

The supervisor uses the existing gateway, remembered device grants and
private HTTPS listener on port 8443. It retries enabling access every 30
seconds while waiting for Tailscale. An explicit disable remains disabled
across restarts. It never enables public Funnel.

## Local management

From the same Unix account, use:

```sh
node scripts/remote-headless.cjs status
node scripts/remote-headless.cjs pair
node scripts/remote-headless.cjs revoke <device-id>
node scripts/remote-headless.cjs disable
node scripts/remote-headless.cjs enable
```

`status` lists device IDs and the private URL. `pair` prints a one-use
pairing URL, valid for five minutes; open it privately on the device being
paired. Mint a fresh URL if it expires. Do not put pairing output in
shared logs. Remote browsers cannot mint links or administer devices.

A Home Screen web app (for example on iPhone, from Safari or Chrome) keeps
its own storage, separate from the browser, so pairing a browser tab does
not pair the saved app, and the saved app's URL cannot be edited. Open the
app instead, copy a fresh pairing link, and use the pairing page's
**Paste** button or text box; it accepts the whole link or its bare grant.

Administration uses an HTTP protocol over a mode-0600 Unix socket inside
a mode-0700 directory, with no TCP management listener. Existing control
sockets are never overwritten. Under systemd, `RuntimeDirectory` removes
stale sockets when the service exits. When launched manually after a hard
crash, ensure the old process is gone before removing a stale socket.

The supervisor stops its gateway and backend together. systemd's
`KillMode=control-group` also removes children after an ungraceful exit.

## ChatGPT subscription from a phone

The supervisor owns a mode-0600 `chatgpt-credentials.json` in
`LH_REMOTE_STATE_DIR`. The existing OAuth owner handles PKCE, ID-token
verification, account identity, scopes and token refresh. Credentials
reach only the backend through inherited IPC. Background use preserves
the existing preference, enabled by default.

```sh
learnharness-remote chatgpt-login
learnharness-remote chatgpt-status
learnharness-remote chatgpt-models
learnharness-remote chatgpt-cancel
```

Open the returned `authorizationUrl` on the phone. After authorization,
its browser will fail to load `http://127.0.0.1:<port>/auth/callback?...`,
because that listener is on the VPS. Supply the full failed address
through private input and complete the attempt using stdin:

```sh
learnharness-remote chatgpt-complete < /path/to/private-callback-file
```

Never use a command argument or shared log for that address: it contains
a one-use OAuth code. The handoff accepts only the exact pending loopback
scheme, host, port, path and state, rejects duplicate OAuth parameters,
and never follows redirects. The normal OAuth owner performs all final
verification. Attempts expire after ten minutes. Do not restart the
service while signing in.

This manual relay is app-specific, distinct from OpenAI's documented
[credential-transfer procedure for VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
Actual account eligibility must still be verified. After completion,
refresh the app and select a ChatGPT model in its model picker. The
desktop-only Providers sign-in controls do not manage this headless
account; administration stays on the local CLI.

## Paths and configuration

- `PORT`: backend loopback port, default 3000.
- `LH_DATA_DIR` and `LH_AUTH_FILE`: learning data and provider keys;
  default to the checkout's `data/` and `auth.json`.
- `LH_REMOTE_STATE_DIR`: remote grant state; defaults to
  `$XDG_STATE_HOME/learnharness` or `~/.local/state/learnharness`.
- `LH_REMOTE_CONTROL_SOCKET`: optional override; defaults to
  `$XDG_RUNTIME_DIR/learnharness-remote/control.sock`, with the state
  directory as a fallback when `XDG_RUNTIME_DIR` is absent.
- `LH_TAILSCALE_SOCKET`: optional private userspace daemon socket.

The state and socket directories must be owned by the invoking Unix
user and inaccessible to other users. Device tokens are stored only as
hashes in `remote-access.json`, using the gateway's existing atomic writes.

## Installed on blaisevps

Two persistent systemd user services are installed and enabled:

```sh
systemctl --user status learnharness-tailscale.service learnharness-remote.service
journalctl --user -u learnharness-remote.service -n 40
~/.local/bin/learnharness-remote status
~/.local/bin/learnharness-remote pair
```

The user manager has lingering enabled, so these services start at boot
without an interactive login. Tailscale 1.104.5 is installed under
`~/.local/lib/tailscale-1.104.5/`; its commands are linked in `~/.local/bin/`.
The supervisor uses the durable Node runtime at
`~/.local/lib/learnharness/node`. The existing checkout data and auth paths
remain in use. Fonts and fontconfig are installed in the user's home.

### Speechify audio service

`speechifyd.service` runs `blsdncn/speechifyd` from
`~/.local/share/speechifyd`, listening only on `127.0.0.1:47616`.
LearnHarness's two custom audio endpoints use
`http://127.0.0.1:47616/v1`, its private API key and its `speechify` model.
Existing language, voice and reading preferences are preserved. Speechify
maps unsupported voice names to its default, initially `geffenv1`.

Account login uses the authenticated `/v1/session` route over loopback.
Passwords arrive through private input and are not saved. The service
keeps only its refresh token in `~/.local/state/speechifyd/refresh-token`;
its API key is in that same private directory. Speechify's upstream
account API is unofficial, as documented by its repository.

FFmpeg 8.0.1 and its runtime dependencies were downloaded from Ubuntu's
package archive, checked against package-metadata SHA-256 hashes and
extracted into `~/.local/lib/learnharness-ffmpeg/`. The launcher at
`~/.local/bin/ffmpeg` supplies its private library paths. The speechifyd
unit override includes that launcher in `PATH`; LearnHarness wants the
speechifyd service at boot. No system packages or public listeners were
added.

The Tailscale service uses `--tun=userspace-networking` and an explicit `--statedir` (required for
TLS certificate storage), private state in
`~/.local/state/learnharness-tailscale/`, and a private socket at
`/run/user/1000/learnharness-tailscale/tailscaled.sock`. It does not change
the system VPN, DNS, SSH, or the T3 connection. To authorize the VPS:

```sh
tailscale --socket="$XDG_RUNTIME_DIR/learnharness-tailscale/tailscaled.sock" up --accept-dns=false
```

After joining the tailnet, enable HTTPS certificates if Tailscale prompts
for that account setting, then run `learnharness-remote enable`. The service
reports its private address with `learnharness-remote status`.

For an update, stop `learnharness-remote.service`, build and curate the
payload, then start the service again. Avoid rebuilding its standalone
directory while the service is running.

References: [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking),
[private HTTPS Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
and [pairing and gateway behavior](remote-access.md).
