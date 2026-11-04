# Private remote access on a headless Linux host

`scripts/remote-headless.cjs` starts the production standalone server and
the existing authenticated Tailscale gateway without Electron. It supports
API-key providers, TTS, dictation, learning sessions and the graph. Desktop
subscription sign-in is unavailable. The host must join the same tailnet
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

Administration uses an HTTP protocol over a mode-0600 Unix socket inside
a mode-0700 directory, with no TCP management listener. Existing control
sockets are never overwritten. Under systemd, `RuntimeDirectory` removes
stale sockets when the service exits. When launched manually after a hard
crash, ensure the old process is gone before removing a stale socket.

The supervisor stops its gateway and backend together. systemd's
`KillMode=control-group` also removes children after an ungraceful exit.

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
