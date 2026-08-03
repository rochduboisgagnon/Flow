# Flow 2.0.0

**Flow has accounts.** Your settings, dictionary, statistics, dictation history,
meeting documents and meeting audio now live in a Supabase project in Canada
(`ca-central-1`) instead of files on one machine. The point is a second computer:
a dictionary of technical terms typed one word at a time over months used to be
trapped on whichever PC you happened to be sitting at.

A major version because the product's central claim changed, and because
**nothing about your data is where 1.x left it**.

## What did NOT change, and will not

**Your voice is never sent to anyone.** Speech-to-text runs on this machine
(whisper.cpp, kept warm). The optional dictation cleanup and the meeting notes
run on a local LLM. No audio and no transcript is ever handed to a speech or AI
service. There is no API key.

**Dictation never waits for the network.** Everything the hot path reads is
served from memory by *synchronous* calls — a synchronous read cannot wait on
Supabase, which is a property of the code's shape rather than a promise someone
has to remember. Unplug the network and dictation is unchanged; changes queue in
memory and go up when it returns.

## What changed

- **Accounts, with no sign-up.** Accounts are created deliberately, and the
  project refuses sign-ups server-side — the publishable key ships inside this
  installer, so a door closed only in the interface would not be closed at all.
- **A sign-in screen at launch**, and when Supabase does not answer it says so
  instead of crashing.
- **One account cannot see another's data.** Every table and the private audio
  bucket are closed by row-level security. This is not read off a policy file: a
  test signs in to two real accounts, writes with one, then tries to read, write,
  modify and delete with the other — against the real project.
- **Meetings are written as one document that grows in memory** and uploads in
  slices every 20 seconds, instead of a `.md` file rewritten on disk 18 different
  ways.
- **Poppins** is the interface font, served as a file of the application.

### Three things that only matter when something goes wrong

- **A network cut mid-meeting loses nothing.** Ten minutes offline costs one
  upload at reconnection, not thirty: the queue keeps the latest version of the
  document and sends that.
- **A meeting Flow did not finish is visible AS interrupted, never gone.** Its
  row stays open and the next sign-in closes it with a note at the top of the
  document saying how it ended and what was never transcribed. This covers a
  crash, a power cut and a forced quit — none of which run any shutdown code —
  and it now also covers a meeting cut short on your *other* computer, which
  nothing could see before. A meeting still being recorded elsewhere is left
  alone: the row's heartbeat tells the difference.
- **An interrupted audio upload resumes.** A one-hour `.wav` is 115 MB, uploaded
  in resumable 6 MB chunks. The upload address is kept with the meeting, so
  closing Flow halfway does not mean starting over.

## What left the disk

The five local stores (`settings.json`, `dictionary.json`, `stats.json`,
`history.json`, `live-notes.json`), the `staging/` folder and the `history/`
folder of recordings. What remains on this machine is the application, your
session token (encrypted by the OS keychain), the window's position, `flow.log`,
`api.json`, and — only while it uploads — the `.wav` of a meeting whose audio you
asked to keep.

**An existing `history/` folder is neither read, moved nor deleted.** Flow reports
it in Settings and on the Notes page as a folder of recordings it no longer
manages, with its path. The answer to "where did my recordings go" is never
"nowhere".

## Retention

Dictation history is still a rolling month, now enforced by the database. Moving
it there bought something the file version could not have: it also covers the
rows your **other** computer wrote.

The 90-day window on recordings is gone with the folder it described. It was a
property of a disk filling up, not a promise made to anyone — and the retention
that came from a security finding (dictations) is the one that stayed.

## Known limit, not fixed

On a French transcript, the local model writes the summary **in English**. Four
prompt variants were measured against the real model: this is a ceiling of the 3B,
not a placement to find. The real fix is to *tell* it the language from
`settings.language` instead of making it guess, and that deserves its own task.

---

1123 tests. Windows x64.
