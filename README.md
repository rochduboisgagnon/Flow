# Flow

by AGR Labs

**On-device voice transcription for your PC - two modes, one engine.**

1. **Quick dictation.** Hold `Ctrl+Win` anywhere, speak, release: the transcribed
   text lands at your cursor. If no text field has focus, it goes to the
   clipboard instead. Double-tap the shortcut for hands-free dictation, and
   press it once to stop.
2. **Long recording** (Plaud-style). Record a meeting for hours: it is
   transcribed locally as it goes, and lands in your account as one document
   (timestamped transcript + AI meeting notes).

What makes it different from the tools it is inspired by:

- **Your voice is never sent to anyone.** The speech-to-text engine runs on this
  machine (whisper.cpp as a warm sidecar); the optional cleanup and the meeting
  notes run on a local LLM. No audio and no transcript is ever handed to a
  speech or AI service, there is no API key, and that is the promise that has
  not moved and will not.

- **Flow now has accounts, and that changes this product's central claim.**
  Until 2026-08-03 the line above read "Nothing ever leaves your machine. No
  cloud, no account, no API key." Saying so here, rather than quietly deleting
  the old wording, is the whole point - and it is the second time this README has
  had to do it, after 2026-07-30. **A promise that changes and does not announce
  itself was never a promise.**

  Why it changed: the same information has to follow you to a second computer.
  A dictionary of technical terms typed one word at a time over months, and the
  meetings you recorded, were trapped on whichever machine you happened to be
  at.

  What that means, precisely:

  - **Your data lives in a Supabase project in Canada** (`ca-central-1`), under
    an account that is yours: settings, dictionary, statistics, dictation
    history, and meeting documents.
  - **A meeting's AUDIO is the one thing that does not travel.** It stays on the
    machine that recorded it, and it is never uploaded anywhere. Open that
    meeting on another computer and you get its transcript and its notes, with a
    line saying where the recording is.

    *Why, since the audio did upload in 2.0.x:* the project refuses any object
    over 50 MiB - measured, 52 428 800 bytes accepted and 52 428 801 refused -
    and a `.wav` of dictation-grade audio reaches that in 27 minutes. Roch's
    decision, on 2026-08-04, was to keep the audio local rather than pay for a
    larger ceiling or build an Opus encoder. Settings > Storage & Privacy says
    what the audio folder weighs, because nothing removes those files on its
    own.
  - **One account cannot see another's data.** Every table and the audio bucket
    are closed by row-level security, and that is not a claim read off a policy
    file - a test signs in to two real accounts, writes with one, and tries to
    read, write, modify and delete with the other. It runs against the real
    project.
  - **The audio bucket is private**, and since 2.1.0 it is also EMPTY by
    design: nothing is written to it any more, and a start-up sweep brings down
    whatever 2.0.x left there. The policies and their isolation test stay - a
    bucket that exists and is not closed would be a hole, whether or not
    anything is in it.
  - **There is no sign-up.** Accounts are created deliberately, not by anyone
    who downloads the installer, and the project refuses sign-ups server-side -
    the publishable key ships inside the app, so a door closed only in the
    interface would not be closed at all.
  - **Dictation never waits for the network.** Everything the hot path reads is
    served from memory by synchronous calls - a synchronous read *cannot* wait
    on Supabase - and writes go out behind you. Pull the network cable and
    dictation is unchanged; the changes queue in memory and go up when it
    returns.

- **What is left on the disk of this machine** is the application, your session
  token (encrypted by the OS keychain), the window's position, `flow.log`,
  `api.json`, and the `audio/` folder holding the `.wav` of every meeting whose
  audio you asked to keep. Nothing else. The five local stores Flow used to keep
  (`settings.json`, `dictionary.json`, `stats.json`, `history.json`,
  `live-notes.json`) and the `history/` folder of recordings are gone.

  The `audio/` folder is the one thing here that GROWS: 115 MB per hour of
  recording, and nothing deletes it on its own. Deleting a meeting in Notes
  deletes its audio with it, and Settings > Storage & Privacy shows the total.

- **Your dictations, as text, for a rolling month.** Listed on the Home page,
  and anything older than 31 days is deleted from the database itself - not
  filtered out when it is displayed. One click erases the lot.

  *This retention has been wrong twice, so here is where it stands.* It first
  ran only when a new dictation was written, so an installation that stopped
  being used kept everything forever while the page showed it correctly purged
  (found by a security scan, 2026-08-02). It now runs every time you sign in,
  whether or not you dictate - and moving it into the database bought something
  the file version could not have: it also covers the rows your **other**
  computer wrote. The honest remaining limit: it happens when Flow runs.

- **A dictation's audio is still never written down.** It exists for exactly one
  utterance and reaches no file, ever. Only the long-recording mode keeps audio,
  and only when you ask it to.

- Flow also keeps **one** audio buffer in memory, half a second long, described
  in full below.

Status: **Windows, shipping** - autonomous app distributed via
[GitHub Releases](https://github.com/rochduboisgagnon/Flow/releases) with built-in automatic updates.

## The one buffer, and what bounds it

Flow ships with **microphone pre-warm** set to *a few seconds after each
dictation*. That setting does exactly one thing, and it is worth stating
plainly rather than burying: **Flow keeps a rolling half-second of sound in
memory between dictations, and holds the microphone open for a few seconds
after each one.**

It exists because the alternative loses your first word. Opening a microphone
costs a few hundred milliseconds; audio spoken during that window is not late,
it never existed, and nothing downstream can recover a syllable the microphone
was not open for. The half-second is prepended to your next dictation, so the
first word is there whether or not the device was ready.

What bounds it:

- **Half a second, by construction.** It is a ring buffer capped in samples,
  not a buffer that is trimmed when someone remembers to. Lowering the bound
  erases the excess immediately.
- **Memory only.** It is never written to disk, never sent to the speech
  engine on its own, never sent anywhere. The only audio that ever leaves the
  window holding the microphone is one finished utterance's WAV.
- **Erased, not filed.** It is cleared when the dictation that consumed it
  ends, when the microphone closes, and when you turn the setting off.
- **Visible.** Windows shows its microphone indicator for the seconds Flow
  holds the device. That is the honest cost of the trade, and it is not hidden.

**There is no longer a switch for this, and that is a deliberate change made on
2026-07-30.** It used to be a three-way setting. Being honest about why it went:

- *Always, while Flow runs* held the microphone open for the whole session. It
  is also the option that failed a human check - with it on, the Windows
  microphone indicator stayed lit through a **session lock**, which is Flow
  holding the microphone through a gesture that means "stop listening".
- *Off* allocated no buffer and clipped the first word instead. It existed
  mostly as an escape hatch from the option above.

What is left is the middle one, which was always the right answer, so it is now
the only one. In exchange for losing the choice you get a narrower promise that
is easier to check: the microphone is held for **a few seconds after a
dictation and no longer**, and it is released outright whenever you lock the
session, the machine sleeps, or you pause dictation from the tray.

## How dictation works

```
hold Ctrl+Win ──> capture mic (16 kHz mono, in RAM) + listening ribbon + cue
              ──> with pre-warm on, the rolling half-second recorded BEFORE the
                  key went down is prepended, then erased
release       ──> energy VAD (silence never reaches the model)
              ──> transcribe once (whisper.cpp sidecar, model kept warm,
                  encoder context sized to the utterance: ~0.4 s on CPU)
              ──> anti-hallucination gates (no-speech scoring + phantom list)
              ──> optional local LLM cleanup (punctuation, spoken commands)
              ──> probe the focused UI element (UI Automation): editable?
   editable   ──> insert at cursor (clipboard paste + restore)
   otherwise  ──> leave the text on the clipboard, ready for Ctrl+V
```

Settings live in Flow's own window: shortcut (recorded through the low-level hook,
modifier-only combos welcome), microphone, language, model (tiny through
large-v3-turbo, the French-friendly default), a soft start/stop sound cue (on by
default since 2.1.0: you dictate into another app, so the pill is out of sight
and the sound is the only confirmation that reaches you), insertion mode (clipboard paste, or typed keystrokes for paste-hostile
apps), and an optional local-LLM pass (Ollama) for dictation cleanup and meeting
summaries.

## How the long mode works

```
start (Record page)                       the row exists from the first instant,
   ──> continuous capture, streamed in slices (bounded memory)      still OPEN
   ──> pause-aware segmentation (cuts on silences)
   ──> one warm-whisper pass per segment
   ──> the document grows IN MEMORY and a slice goes up every 20 s
   ──> "mark this moment" drops anchors the notes emphasize
   ──> notes you type during the meeting are saved as you type them
stop
   ──> local LLM notes, spliced into the SAME document
   ──> the row is closed; the audio (if kept) stays in Flow's audio folder
```

Three things that only matter when something goes wrong, which is when they
matter most:

- **A network cut mid-meeting loses nothing.** The document is in memory; the
  queue keeps the latest version of it and sends that when the network returns.
  Ten minutes offline costs one upload, not thirty.
- **A meeting Flow did not finish is visible AS interrupted, never gone.** Its
  row stays open, and the next sign-in closes it with a note at the top of the
  document saying how it ended and what was never transcribed. This covers a
  crash, a power cut and a forced quit - none of which run any shutdown code -
  and it covers a meeting cut short on your *other* computer, which nothing
  could see before. A meeting still being recorded elsewhere is left alone: the
  row's heartbeat says the difference.
- **The audio is never in flight, so it can never be half-arrived.** A one-hour
  `.wav` is 115 MB and it does not move: it is written where it will live, and
  the meeting's row records its real size. This replaced a resumable upload in
  2.1.0, and the trade is stated rather than hidden - a meeting recorded on one
  computer cannot be listened to on another, and its transcript and notes can.

## Known limits on Windows

Written down on purpose rather than left to be discovered in a meeting. Each of
these is a deliberate trade, not an open bug.

- **Applications running as administrator.** Flow runs unelevated, by choice. A
  low-level keyboard hook cannot see keystrokes going to a higher-integrity
  process, so the shortcut simply does not respond while an elevated window has
  focus (Task Manager, an installer, an editor opened "as administrator"), and
  the pill does not draw over those windows. There is no error message, because
  from Flow's point of view nothing happened at all. Running Flow elevated would
  give an administrator process a view of every keystroke on the machine, which
  is a bad trade for an app whose whole promise is that it does not keep what
  you say. Dictate in an unelevated window and paste.
- **Exclusive-fullscreen applications** (DirectX games, some presentation
  modes). Flow re-asserts its always-on-top level on every press, which covers
  *borderless* fullscreen. True exclusive fullscreen owns the display surface
  and no overlay can appear on it. Dictation still works and the optional start
  cue still plays; only the ribbon is invisible.
- **Fast user switching** is not observed. Windows reports it as a console
  disconnect rather than a lock, and Electron does not surface that event. A
  press held across the switch is cleaned up at the next lock, sleep or press.
- **A microphone that disappears mid-sentence** (USB headset unplugged, audio
  service restart, another app taking the device exclusively) is *detected but
  not prevented*: Flow inserts the part it actually heard, then names the
  incident in `flow.log` and counts it in Diagnostics
  (`mic-dropped-mid-dictation`). The detection is a deliberately conservative
  heuristic - it ignores presses shorter than 2 s and gaps smaller than 1.5 s,
  so it will miss a device lost in the last moment of an utterance rather than
  ever accuse a healthy one. *Between* dictations it is prevented: a pre-warmed
  microphone that dies, goes silent or stops being the device Windows now calls
  the default is released and rebuilt rather than reused, so a dead device can
  never become a run of empty dictations.
- **The pill follows the mouse, not the text field.** On a multi-monitor desk it
  appears on the display under the cursor, which is not always the display you
  are typing on. Locating the focused field first would cost the activation
  budget it exists to protect, and the overlay never takes focus - that is what
  makes insert-at-cursor possible at all.

Sleep, resume and lock **are** handled: a press that the keyboard can no longer
end is torn down instead of leaving a hot microphone behind it, and the keyboard
hook is rebuilt on resume, because Windows silently removes a low-level hook
that overran its budget and [documents that there is no way for an application
to know](https://learn.microsoft.com/windows/win32/winmsg/lowlevelkeyboardproc).

## macOS

Shipped, arm64 (Apple Silicon), from the same tag as Windows. Dictation, the
local engines, the account, the dictionary and meeting recording all work; what
this machine can and cannot do is a single table in `src/shared/platform.ts`,
and the app *says* what is missing rather than greying a control out.

Not there yet, and named rather than vaguely deferred: capturing what the
computer plays during a meeting (Windows gets it free from WASAPI loopback;
macOS needs ScreenCaptureKit and the Screen Recording permission), muting other
applications during a dictation (macOS has no per-application volume API at all,
so this one probably never crosses), and the front-window probe (the Windows one
launches powershell.exe).

**It updates itself.** Not through electron-updater: Squirrel.Mac requires a
real Developer ID signature, and no certificate is being bought. Flow reads a
small document published beside the zip (`mac-arm64.json`: version, archive
name, SHA-256, size), downloads, checks the fingerprint *before* the file takes
its name, expands with `ditto`, inspects the bundle that comes out, and swaps it
through a detached script that waits for the process to die, keeps the old
bundle aside until the new one is in place, and relaunches. The same quiet
window as Windows holds it back: never during a dictation or a recording.

Two consequences of the ad-hoc signature, said here so they are not discovered:

- **The Accessibility permission has to be granted again after every update.**
  macOS ties it to the app's exact signature, and an ad-hoc signature is a hash
  of the code, so a new version is a new application as far as the system is
  concerned. Flow detects this and points at the right pane instead of telling
  you to restart it. This matters more than it sounds: without that permission a
  process can start its key server *successfully* and never receive a single key
  event, which no health check could see.
- **The first install** (the .dmg, downloaded by a browser) trips Gatekeeper:
  `xattr -dr com.apple.quarantine /Applications/Flow.app`. Updates should not,
  because the quarantine flag is set by the *downloader* and Flow fetches its own
  update.

Precisely, because the loose phrase "ad-hoc signed" is easy to over-read: the
package is not signed by us at all. `mac.identity: null` means *do not sign*, and
what the binary carries is the signature Apple's linker puts on every arm64
executable (`adhoc, linker-signed`). The kernel accepts it - the CI proves that by
launching the extracted app, not by asking `codesign` - and nothing here needs
more. What binds the bytes you download to the bytes that were built is the
SHA-256 in the manifest and the GitHub provenance attestation, both of which say
more than an ad-hoc signature ever could.

## Development

```
npm ci
npm run dev        # vite + tsc watch + electron
npm test           # unit + integration tests (node:test via tsx)
npm run lint
npm run dist       # NSIS installer + zip (Windows x64)
```

The real-engine tests (TTS through the full pipeline) run automatically when
the speech model is present locally and skip on CI. `npx tsx
scripts/bench-latency.ts` measures warm dictation latency.

`npm run bench:wer` measures French transcription quality (word error rate) over
a 24-utterance corpus. The repository versions the corpus TEXT only; the audio
is git-ignored, so give it a voice first with either `npm run bench:wer --
--synthesize` (Windows speech, reproducible in a minute, measures the processing
chain and *not* real speech) or `npm run bench:wer -- --record` (your own voice,
the only real baseline). Real recordings win automatically, utterance by
utterance, and every table states which source it measured.

## Credits

The architecture is informed by studying [OpenWhispr](https://github.com/OpenWhispr/openwhispr)
(MIT), notably its warm `whisper-server` sidecar pattern and its native helper
approach. Flow's product goals are its own - it keeps a bounded history, and
since 2026-08-03 it keeps it in an account - but it gladly stands on what
OpenWhispr proved workable.

License: [MIT](LICENSE).
