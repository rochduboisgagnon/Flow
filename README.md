# Flow

by AGR Labs

**Local, on-device voice transcription for your PC - two modes, one engine.**

1. **Quick dictation.** Hold `Ctrl+Win` anywhere, speak, release: the transcribed
   text lands at your cursor. If no text field has focus, it goes to the
   clipboard instead. Double-tap the shortcut for hands-free dictation.
2. **Long recording** (Plaud-style). Record a meeting for hours: it is
   transcribed locally as it goes, deposited (transcript + AI meeting notes)
   into a folder you choose.

Two things make it different from the tools it is inspired by:

- **Nothing ever leaves your machine.** The speech-to-text engine runs locally
  (whisper.cpp as a warm sidecar); the optional cleanup and the meeting
  summaries run on a local LLM (Ollama). No cloud, no account, no API key.
- **Dictation is never written down.** No history, no database, no transcript
  on disk. A dictation's audio and text exist only for the duration of one
  utterance. If you overwrite the clipboard before pasting, the dictation is
  gone - by design. (Only the long-recording mode writes files, and only into
  the folder you picked.) Flow does keep **one** audio buffer in memory, half a
  second long, and it is described in full below - because a product that
  claims the absolute and holds a buffer anyway has told you nothing you can
  rely on.

Status: **Windows, shipping** - autonomous app distributed via
[GitHub Releases](https://github.com/rochduboisgagnon/Flow/releases) with built-in automatic updates.

## The one buffer, and how to turn it off

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

How to turn it off, in one click: **Settings > Dictation >
Microphone pre-warm > Off**. The microphone then opens only while you hold the
shortcut and closes the moment you let go, no buffer is ever allocated, and the
first word of a dictation can be clipped instead - Diagnostics shows by how
much. The third option, *Always, while Flow runs*, keeps the microphone open
for the whole session: no acquisition cost ever, and the indicator stays lit
the whole time.

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

Settings live in AGR Manager's AGR Flow view (the engine itself is headless and
is driven over its local API): shortcut (recorded through the low-level hook,
modifier-only combos welcome), microphone, language, model (tiny through
large-v3-turbo, the French-friendly default), a soft start/stop sound cue (off by
default), insertion mode (clipboard paste, or typed keystrokes for paste-hostile
apps), and an optional local-LLM pass (Ollama) for dictation cleanup and meeting
summaries.

## How the long mode works

```
start (from AGR Pilot's Long recording page, folder of your choice)
   ──> continuous capture, streamed in slices (bounded memory)
   ──> pause-aware segmentation (cuts on silences, caps at 25 s)
   ──> one warm-whisper pass per segment
   ──> transcript grows ON DISK as the meeting runs (crash-safe)
   ──> "mark this moment" drops anchors the summary emphasizes
stop
   ──> local Ollama summary (meeting notes / client interaction templates)
   ──> transcript + notes sit in your folder; the 10 last stay one tap away
```

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

Deferred by design (plan phase 5). The codebase is structured for it - the
hotkey (keyspy ships a MacKeyServer), the injection (nut.js) and the engine
(whisper.cpp with Core ML/Metal) are cross-platform; what remains is the
AX-API focus probe (the Windows one is a UI Automation sidecar), the
Accessibility / Input Monitoring permission onboarding, and a mac packaging
lane. No Windows-only assumption lives outside the OS adapters.

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

## Credits

The architecture is informed by studying [OpenWhispr](https://github.com/OpenWhispr/openwhispr)
(MIT), notably its warm `whisper-server` sidecar pattern and its native helper
approach. AGR Flow shares no product goals with it (no history, no cloud paths,
no accounts) but gladly stands on what it proved workable.

License: [MIT](LICENSE).
