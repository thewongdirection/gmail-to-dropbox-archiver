# Handoff — Gmail → Dropbox PDF Archiver

Status snapshot for continuing this project in a fresh Claude Code session.
Last updated: 2026-07-14.

> **Latest session** added upload resilience (retry/backoff on 429 + 5xx with
> `Retry-After` support), chunked **upload sessions** for large attachments,
> and an optional per-run **summary email** (`RUN_SUMMARY_EMAIL`). See the
> "What's DONE" and "How it works" notes below and in `README.md`.

## What this project is

A Google Apps Script that runs daily, finds Gmail threads carrying a chosen
label, renders each message to a PDF, and uploads it (plus file attachments)
to Dropbox — then tags the thread so it's never archived twice. Full details
in [`README.md`](./README.md).

## What's DONE ✅

- **Repo created & pushed** — `thewongdirection/gmail-to-dropbox-archiver`,
  branch `main`.
- **`Code.gs`** — complete and syntax-checked. Contains:
  - `archiveLabeledEmails()` — the main function the daily trigger calls.
  - `messageToPdf_()`, `archiveMessage_()` — PDF rendering + attachment upload.
  - Dropbox refresh-token auth (`getDropboxAccessToken_`) and upload
    (`uploadToDropbox_`, `toDropboxApiArg_` with ASCII-safe header escaping).
  - **Upload resilience** — `fetchWithRetry_()` / `retryDelayMs_()` /
    `headerValue_()`: exponential backoff + jitter on `429`/`5xx`, honoring
    `Retry-After`. All Dropbox calls route through it.
  - **Large files** — `uploadSmallToDropbox_()` for ≤8 MB, else
    `uploadLargeToDropbox_()` streams via `upload_session/start|append_v2|finish`.
  - **Run summary** — `maybeSendSummary_()` emails a digest when
    `RUN_SUMMARY_EMAIL` is set (skips quiet no-op runs).
  - Setup/test helpers: `initConfig()`, `setupDailyTrigger()`,
    `removeTriggers()`, `testDropboxConnection()`, `testArchiveOne()`.
- **`appsscript.json`** — manifest with V8 runtime, timezone
  (`America/New_York`), and OAuth scopes (`gmail.modify`,
  `script.external_request`, `script.scriptapp`, `script.send_mail`).
- **`README.md`, `LICENSE` (MIT), `.gitignore`**.

## Design decisions already locked in

- **Dropbox auth:** refresh token (never expires) — not short-lived tokens.
- **Attachments:** body PDF **+** real file attachments (inline images excluded).
- **Dedup:** processed-label approach (`Archived/Dropbox`), idempotent runs.
- **Schedule:** daily time-based trigger, ~2 AM script-timezone.
- **Secrets:** live only in Script Properties, never committed.

## What's LEFT to do 🔜 (needs the user's hands)

1. **Create the Dropbox app** at <https://www.dropbox.com/developers/apps>
   (scoped access, `files.content.write` permission). Get **App key** + **App secret**.
   → README Section 1.
2. **Get a Dropbox refresh token** via the OAuth `token_access_type=offline`
   flow (authorize URL → auth code → `curl` token exchange). → README Section 1.4.
3. **Create the Apps Script project** at <https://script.google.com>, paste in
   `Code.gs` (or deploy with `clasp`), and set the Script Properties:
   `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
   `GMAIL_LABEL`. → README Section 3.
4. **Create/apply the Gmail label** (e.g. `Archive/ToDropbox`) to some emails.
5. **Test then schedule** — run `testDropboxConnection()`, then
   `testArchiveOne()`, then `setupDailyTrigger()`. → README Section 4.

## Where a new session can help next

- Generate the exact Dropbox authorize URL / token-exchange `curl` once the
  user has their app key + secret.
- Adjust the schedule (`setupDailyTrigger()` uses `.everyDays(1).atHour(2)`).
- Remaining optional features: combine a thread's messages into one PDF,
  per-sender Dropbox subfolders, a Slack webhook summary, or switch the
  timezone in `appsscript.json`.
- Tune `DROPBOX_CHUNK_BYTES` (default 8 MB) if you want larger/smaller upload
  chunks.
- ✅ Large attachments (upload sessions), retry/backoff, and email summary are
  now implemented (this session).

## Repo layout

```
Code.gs           # archiver + setup/test/maintenance functions
appsscript.json   # manifest: timezone, V8 runtime, OAuth scopes
bootstrap.sh      # one-command CLI install (clasp + secret prompts)
install-via-api.mjs # no-clasp installer via the Apps Script REST API (Node 18+)
SETUP-CLI.md      # command-line install guide (clasp, clasp run, no-clasp options)
README.md         # full 15-minute setup guide
HANDOFF.md        # this file
LICENSE           # MIT
.gitignore        # keeps clasp creds / secrets out of git
```
