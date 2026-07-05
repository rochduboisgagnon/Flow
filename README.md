# AGR Flow

**Local, on-device voice dictation for any app.** Hold a key, speak, release: the
transcribed text lands at your cursor. If no text field has focus, it goes to the
clipboard instead. That's the whole product.

Two things make it different from the dictation tools it is inspired by:

- **Nothing ever leaves your machine.** The speech-to-text engine runs locally
  (whisper.cpp as a warm sidecar). No cloud, no account, no API key.
- **Nothing is ever stored.** No history, no database, no in-memory buffer kept
  around. Audio and text exist only for the duration of one utterance. If you
  overwrite the clipboard before pasting, the dictation is gone - by design.

Status: **Phase 1 (Windows push-to-talk MVP), under construction.** macOS comes
later.

## How it works

```
hold shortcut ──> capture mic (16 kHz mono, in RAM)
release       ──> transcribe once (whisper.cpp sidecar, model kept warm)
              ──> probe the focused UI element (UI Automation): editable?
   editable   ──> insert at cursor (clipboard paste + restore, or typed keys)
   otherwise  ──> leave the text on the clipboard, ready for Ctrl+V
```

## Development

```
npm ci
npm run dev        # vite + tsc watch + electron
npm test           # unit tests (node:test via tsx)
npm run lint
npm run dist       # NSIS installer (Windows x64)
```

## Credits

The architecture is informed by studying [OpenWhispr](https://github.com/OpenWhispr/openwhispr)
(MIT), notably its warm `whisper-server` sidecar pattern and its native helper
approach. AGR Flow shares no product goals with it (no history, no cloud paths,
no accounts) but gladly stands on what it proved workable.

License: [MIT](LICENSE).
