# Gmail → Dropbox PDF Archiver

A [Google Apps Script](https://developers.google.com/apps-script) that, once a
day, finds every Gmail thread carrying a label you choose, renders each message
to a **PDF**, and uploads it — together with any file **attachments** — to a
folder in **Dropbox**. Threads are tagged after archiving so they're never
processed twice.

```
Gmail (label: Archive/ToDropbox)
        │  daily trigger ~2 AM
        ▼
  render message → PDF  ──►  Dropbox:/Gmail Archive/2026-07/2026-07-14_1032_Subject_ab12cd34.pdf
  copy attachments      ──►  Dropbox:/Gmail Archive/2026-07/attachments/…__att__report.xlsx
        │
        ▼
  thread gets label: Archived/Dropbox  (skipped on future runs)
```

- **No servers, no cost** — runs entirely inside Google's infrastructure.
- **Secrets stay out of the code** — all credentials live in Script Properties.
- **Durable auth** — uses a Dropbox *refresh token*, so the daily job keeps
  working indefinitely (short-lived access tokens expire after ~4 hours).

---

## What you'll set up

1. A **Dropbox app** (to get an app key, secret, and refresh token).
2. A **Gmail label** whose threads you want archived.
3. This **Apps Script project** with a few Script Properties and a daily trigger.

Total time: ~15 minutes.

---

## 1. Create the Dropbox app + refresh token

1. Go to <https://www.dropbox.com/developers/apps> → **Create app**.
   - **Scoped access** → **App folder** (recommended — the app can only touch
     its own folder) or **Full Dropbox** if you want to write anywhere.
   - Name it e.g. `gmail-archiver`.
2. On the app's **Permissions** tab, enable **`files.content.write`** (and
   `files.content.read` if you like), then **Submit**.
3. On the **Settings** tab, note the **App key** and **App secret**.
4. Get a **refresh token** (one-time). In a terminal, replace `APP_KEY` and
   open the authorize URL in your browser:

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
   ```

   Approve access, copy the **authorization code** it shows, then exchange it
   (this must be done within a few minutes):

   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=PASTE_AUTH_CODE \
     -d grant_type=authorization_code \
     -u APP_KEY:APP_SECRET
   ```

   The JSON response contains `"refresh_token": "..."`. Save it — that's your
   `DROPBOX_REFRESH_TOKEN`. (The `access_token` in the same response is
   short-lived and can be ignored; the script mints fresh ones automatically.)

> The `token_access_type=offline` parameter is what makes Dropbox return a
> refresh token. Without it you'd only get a 4-hour access token.

---

## 2. Create the Gmail label

In Gmail, create (or reuse) a label such as `Archive/ToDropbox`. Apply it to any
emails you want archived. You can also set up a **Gmail filter** to auto-apply
the label (e.g. "from my accountant" → label `Archive/ToDropbox`).

The script auto-creates the *processed* label (`Archived/Dropbox`) the first
time it runs; you don't need to make that one.

---

## 3. Create the Apps Script project

**Option A — paste it in (simplest):**

1. Go to <https://script.google.com> → **New project**.
2. Replace the default `Code.gs` with the contents of [`Code.gs`](./Code.gs).
3. Click the project's **Project Settings** (gear) and, under **Script
   Properties**, add the keys below. (Or use the `initConfig()` helper — see
   Option B.)

**Option B — deploy with [clasp](https://github.com/google/clasp) (CLI):**

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "Gmail Dropbox Archiver"
clasp push        # uploads Code.gs + appsscript.json
```

Then set properties in the editor or by editing `initConfig()` and running it.

### Script Properties

| Key                     | Required | Example / default          | Purpose |
|-------------------------|----------|----------------------------|---------|
| `DROPBOX_APP_KEY`       | ✅       | `abc123…`                  | Dropbox app key |
| `DROPBOX_APP_SECRET`    | ✅       | `def456…`                  | Dropbox app secret |
| `DROPBOX_REFRESH_TOKEN` | ✅       | `sl.B7…`                   | From step 1.4 |
| `GMAIL_LABEL`           | ✅       | `Archive/ToDropbox`        | Label to archive |
| `DROPBOX_FOLDER`        | ➖       | `/Gmail Archive` (default) | Destination folder in Dropbox |
| `PROCESSED_LABEL`       | ➖       | `Archived/Dropbox`         | Applied after archiving |
| `MAX_THREADS_PER_RUN`   | ➖       | `40`                       | Per-run safety cap |
| `INCLUDE_ATTACHMENTS`   | ➖       | `true`                     | Also upload file attachments |
| `RUN_SUMMARY_EMAIL`     | ➖       | `you@example.com` (blank)  | Email a per-run digest; blank = off |

> If you use a Dropbox **App folder** app, `DROPBOX_FOLDER` is relative to that
> app folder (which lives at `Apps/<your-app>/` in your Dropbox).

---

## 4. Test, then schedule

Run these functions from the Apps Script editor's **Run** menu (the first run
will prompt you to authorize the Gmail/external-request scopes — approve them):

1. **`testDropboxConnection`** — confirms your Dropbox credentials work.
   Check **Executions / Logs**; you should see your account email.
2. **`testArchiveOne`** — archives a single labeled message end-to-end so you
   can verify the PDF and attachments show up in Dropbox. (It does *not* mark
   the thread processed, so you can re-run it.)
3. **`setupDailyTrigger`** — installs the daily time-based trigger
   (runs ~2 AM in the project's timezone). Run once.

To change the schedule, edit `.everyDays(1).atHour(2)` in `setupDailyTrigger()`,
or manage triggers under the editor's **Triggers** (clock icon) panel.
To stop the automation, run **`removeTriggers`**.

---

## How it works

- **Selection** — `GmailApp.search('label:X -label:Processed')` returns only
  threads that still need archiving. Processed threads are excluded by the
  label, so runs are idempotent and cheap.
- **PDF** — each message's HTML body is wrapped with a small header table
  (Subject / From / To / Cc / Date) and converted via
  `Utilities.newBlob(html).getAs('application/pdf')`.
- **Upload** — `files/upload` on `content.dropboxapi.com`, with the request
  parameters passed in the `Dropbox-API-Arg` header (non-ASCII escaped so
  unicode filenames work). `mode=add` + `autorename=true` never overwrites.
  Files larger than one 8 MB chunk are streamed via a Dropbox **upload session**
  (`start` → `append_v2` → `finish`) so big attachments don't hit the
  single-request cap.
- **Resilience** — every Dropbox call goes through a retry wrapper that backs
  off and retries on transient `429` (rate-limit) and `5xx` errors, honoring the
  `Retry-After` header. Persistent failures still surface as thrown errors.
- **Dedup** — after all of a thread's messages upload successfully, the thread
  gets the processed label. If any upload throws, the thread is left untagged
  and retried on the next run.
- **Run summary (optional)** — set `RUN_SUMMARY_EMAIL` to receive a short digest
  after each run (threads found/archived, files uploaded, and any per-thread
  errors). It's skipped on quiet no-op runs to avoid inbox noise. This uses the
  `script.send_mail` scope, so you'll be re-prompted to authorize once.
- **Timezone** — set `"timeZone"` in [`appsscript.json`](./appsscript.json)
  (default `America/New_York`); it controls both the filename timestamps and
  the trigger's hour.

## Limits & notes

- **Execution time** — a single run is capped at ~6 minutes by Apps Script.
  `MAX_THREADS_PER_RUN` (default 40) keeps runs well under that; the next day
  picks up any remainder. Lower it if you archive very large threads.
- **Daily quotas** — consumer Gmail accounts allow ~20,000 `UrlFetchApp` calls
  and generous Gmail read quotas per day, far above normal use.
- **Inline images** — images embedded in the email body via `cid:` references
  may not render inside the PDF. Real file attachments are uploaded separately
  and are unaffected.
- **File size** — small files use the single-request upload path; anything
  larger than an 8 MB chunk automatically switches to a chunked upload session,
  so large attachments upload reliably within Apps Script's per-request payload
  limit.

## Security

- No secrets are committed to this repo — they live only in Script Properties
  on your own Apps Script project.
- If you used the `initConfig()` helper to write properties, clear the values
  back out of the function afterward so they aren't stored in the source.
- Revoke access anytime from the Dropbox app console and/or your Google
  Account's *Third-party access* settings.

## Files

| File                | Purpose |
|---------------------|---------|
| `Code.gs`           | The archiver + setup/maintenance functions |
| `appsscript.json`   | Manifest: timezone, runtime, OAuth scopes |
| `.gitignore`        | Keeps clasp creds / secrets out of git |

## License

MIT — see [`LICENSE`](./LICENSE).
