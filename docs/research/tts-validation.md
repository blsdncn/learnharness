# Standalone TTS integration validation

Date: 2026-10-27. Dictation remains a separate follow-up to PR #203.

## Implemented behavior

- Settings → Speech controls listening, API base URL, model, and voice.
- (Superseded by the key-source pass below.) `TTS_API_KEY` is server-side and optional for keyless services. Explicit
  activation supports those services without dummy keys. An unset activation
  preference preserves existing activation by key presence.
- Requests use only the OpenAI `/audio/speech` contract with MP3 output.
  Voice discovery and its non-standard route have been removed.
- Text splitting, server-side math speech, and browser playback speed remain.
  Cancellation closes upstream requests; provider error bodies are withheld
  because they may echo credentials.

## Live endpoints

Both checks exercised the production `POST /api/tts` handler through
`scripts/smoke-tts.mjs`, using isolated temporary settings. The input combined
prose and `x^2`; the configured model and voice were the ordinary defaults,
`gpt-4o-mini-tts` and `alloy`.

- Local speechifyd at `http://127.0.0.1:47616/v1`: passed; 13,632 MP3 bytes.
- Remotely hosted OpenAI at `https://api.openai.com/v1`: passed; 33,792 MP3 bytes.

Only the base URL and key differed. No provider-specific application code,
voice discovery, model discovery, account routes, or response translation
was needed. Each probe required a successful HTTP response, MP3 content
type, MP3 header, and non-empty audio. Audio remained in memory; keys were
read from private files and were not saved to the app's credential store.
These checks establish synthesis/transport success, not a human listening test.

Command for both checks:

```sh
node --import tsx scripts/smoke-tts.mjs
```

The local check set `TTS_BASE_URL=http://127.0.0.1:47616/v1`; the remote check
used the default base URL. Each supplied `TTS_API_KEY_FILE` through its private
credential file path. Private paths and secret values are intentionally omitted.

## Automated checks

The focused test command passed 183 tests:

```sh
NODE_ENV=test npx tsx --test tests/speech.test.ts tests/speech-http.test.ts tests/speech-settings.test.tsx tests/listen-dom.test.ts tests/listen-touch.test.tsx tests/auth-keys.test.ts tests/settings-body.test.ts tests/settings-resolution.test.ts tests/settings-pure.test.ts tests/settings-signal.test.ts tests/render-settings.test.tsx tests/dictation-warm.test.ts tests/zero-keys.test.tsx tests/esc-layering.test.ts
```

After adding the final sample-stop regression, the UI test file was rerun:

```sh
NODE_ENV=test npx tsx --test tests/speech-settings.test.tsx
```

It passed 4 tests, bringing the focused set to 184 distinct tests. The real
HTTP suite uses an independent strict OpenAI-compatible test server, with
the real Node fetch implementation. It covers authentication, keyless
operation, independent credentials, path prefixes, splitting, output
cancellation, and request cancellation. This test server is a contract
fixture; the two live endpoints above are separately reported evidence.

Packaging checks:

```sh
NODE_ENV=test npx tsx --test tests/provider-tracing.test.ts
node scripts/smoke-speech-runtime.mjs
```

All 9 tracing tests passed. The standalone math-speech probe passed using
only `.next/standalone` dependencies and locale data, without falling back
to checkout modules.

Static checks:

```sh
npm run typecheck
npx eslint app/api/tts components/listen components/settings/speech-section.tsx components/settings/controls.tsx src/core/speech.ts src/core/settings.ts src/core/settings-resolution.ts src/core/auth-keys.ts src/server/speech.ts src/server/settings-body.ts tests/speech.test.ts tests/speech-http.test.ts tests/speech-settings.test.tsx
git diff --check
```

All passed.

Production build:

```sh
npm run build
```

Passed. Next emitted four filesystem-tracing warnings in unchanged
`src/agent/subagents/headless.ts`, `src/agent/tools/pdf-read.ts`, and
`src/store/graph.ts`, plus a warning about an external home-directory lockfile.
The generated route list includes `/api/tts` and has no `/api/tts/voices`.

## Browser UI pass

The Speech settings were inspected in actual browser screenshots at 320, 390,
768, and 1440 CSS pixels wide. Connection fields stack according to the
available settings-pane width; compact inputs fill the pane, and the API-key
and sample buttons keep their labels on one line. The desktop row layout
remains inline. The settings pane had no horizontal overflow at any checked
width. Stacking adds vertical scrolling on a phone; the sample control remains
reachable in the existing content scroller.

Browser interactions covered saving the server URL with Enter, opening its
API-key row in Providers, listening activation and the disabled sample state,
sample playback, and a provider
authentication error. Playback used a keyless local HTTP fixture returning
silent MP3 audio; its error mode returned HTTP 401. This is UI evidence, not
another live synthesis-provider check or a human listening test. The earlier
playback-bar inspection also exercised pause, speed, and Escape with fixture
audio at desktop and compact widths.

Checks rerun after the responsive layout change:

```sh
npx eslint components/settings/controls.tsx components/settings/speech-section.tsx
npm run typecheck
NODE_ENV=test npx tsx --test tests/speech-settings.test.tsx tests/render-settings.test.tsx
npm run build
git diff --check
```

All passed; the focused UI suite passed 27 tests. No new tests were added for
the CSS layout changes; browser measurements and screenshots cover those.
The build used isolated temporary app data and emitted the same four
filesystem-tracing warnings and external-lockfile warning described above.

## Advanced connection organization

Listening, Voice, and Test remain visible. The API-key link, Server, and
Model now sit inside a native, initially collapsed “Advanced connection”
disclosure. Existing settings values, save behavior, and responsive row
layouts are retained. This completes the selected organization proposal;
dictation remains a separate follow-up.

Validation for this grouping is recorded separately from the browser pass
above. No new browser screenshots or live provider calls were taken for the
disclosure change.

```sh
npx eslint components/settings/speech-section.tsx
npm run typecheck
NODE_ENV=test npx tsx --test tests/speech-settings.test.tsx tests/render-settings.test.tsx
npm run build
node scripts/build-server.mjs
git diff --check
```

All passed; the focused suite passed 27 tests. The production build used
isolated temporary app data and emitted the same existing tracing and
external-lockfile warnings. The curated standalone runtime was installed
into the existing preview, preserving its imported profile.

## OpenAI-compatible dictation (live)

A fixed sentence ("The derivative of x squared is two x.") was synthesized
by speechifyd, converted with ffmpeg to the 16 kHz mono PCM16 WAV the
recorder produces, and posted through `/api/stt/openai` with isolated
temporary settings:

- Local speechifyd at `http://127.0.0.1:47616/v1`, separate dictation key:
  passed; transcript "The derivative of x squared is two x."
- Remotely hosted OpenAI at the default base URL and `gpt-transcribe`, using
  the "Use OpenAI key" source (`OPENAI_API_KEY`): passed; transcript
  "The derivative of x squared is 2x."

Only the base URL and key source differed. Keys were read from private
files and were not saved to the app's credential store. The probe checks
that the expected words appear in the transcript.

```sh
STT_SAMPLE=<wav> STT_EXPECT="derivative squared" STT_BASE_URL=<base> STT_API_KEY_FILE=<file> node --import tsx scripts/smoke-stt.mjs
STT_SAMPLE=<wav> STT_EXPECT="derivative squared" STT_KEY_SOURCE=OPENAI_API_KEY OPENAI_API_KEY_FILE=<file> node --import tsx scripts/smoke-stt.mjs
```

Alongside these: `npm run typecheck`, 240 focused speech/dictation/settings
tests, and `npm run build` (isolated app data) passed.

## Audio key sources (TTS + dictation)

Both sections now pick their key in one shared row: a saved provider key
(default `OPENAI_API_KEY`, red "No OpenAI API key configured" when absent)
or "Custom key" (`TTS_API_KEY` / `STT_API_KEY`, entered inline, empty = no
auth). The custom keys left Providers; listening is opt-in.

Live, through the app routes with isolated settings:

- speechifyd, custom key: TTS passed (13,632 MP3 bytes); dictation passed,
  "The derivative of x squared is two x."
- Hosted OpenAI, default provider-key source: TTS passed (32,256 MP3
  bytes); dictation passed, "The derivative of x squared is 2x."

Automated: typecheck, ESLint on the changed files, the focused
speech/dictation/settings suites (293 tests) plus the Providers UI suite
(50), `npm run build`, and `git diff --check`. Screenshots at 1440 and
390px: the Custom key toggle keeps the same position and width when
switched, and nothing scrolls sideways. The provider picker opens from the
slot's left edge, so it stays on screen on phones (it was clipped before
that fix).

## Key row: Provider | Custom switch

The key row became a fixed-width Provider | Custom switch beside one slot.
The picker always lists OpenAI alongside saved provider keys (each with its
masked key or "not set"), so the default can be re-picked. A missing key's
red hint links to Providers with that provider's paste field open. The
custom key is read-only at rest; clicking it opens a Providers-style editor
on its own line (Save / Cancel / Delete) and nothing is written before Save.

Typecheck, ESLint, 306 focused tests (including the rewritten key-row suite
and a Providers deep-link test), and `npm run build` passed. Screenshots at
1440 and 390px: the switch keeps its position and width in both states, the
editor line fits on a phone, the deep link opens the OpenAI paste field, and
nothing scrolls sideways. No live provider calls were repeated; the server
path is unchanged from the previous pass.

Follow-up: the row now uses two lines in both modes — "API key" with the
switch, then the source's key full width (the picker with its masked key,
or a Providers-style "Custom key" row with no input box at rest). Clicking
the custom row turns that same row into its inline editor; only one input
exists while editing. The switch kept its position in both states at 1440
and 390px.

## Checks outside this validation

The entire repository test suite, a human listening test, and a packaged
Electron application were not exercised. A genuinely offline model was not
live-tested. An offline compatible server can use the same interface; that deployment's
offline operation requires its own validation.
