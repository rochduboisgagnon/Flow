# AGR Flow

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
- **Dictation is never stored.** No history, no database, no in-memory buffer
  kept around. Audio and text exist only for the duration of one utterance. If
  you overwrite the clipboard before pasting, the dictation is gone - by
  design. (Only the long-recording mode writes files, and only into the folder
  you picked.)

Status: **Windows, shipping** - distributed and auto-updated by
[AGR Manager](https://github.com/rochduboisgagnon/AGR-Manager) (signed catalog,
SHA-256 verified artifacts). When installed next to AGR Pilot, its mobile PWA
gains direct mic dictation and a remote-controlled Long recording page.

## How dictation works

```
hold Ctrl+Win ──> capture mic (16 kHz mono, in RAM) + listening ribbon + cue
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
large-v3-turbo, the French-friendly default), insertion mode (clipboard paste,
or typed keystrokes for paste-hostile apps), and an optional local-LLM pass
(Ollama) for dictation cleanup and meeting summaries.

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
