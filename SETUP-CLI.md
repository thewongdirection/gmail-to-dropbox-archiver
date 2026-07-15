# Command-line install

Prefer the terminal over clicking around `script.google.com`? This guide covers
installing the archiver from the CLI — the fast path (`bootstrap.sh`), the
manual `clasp` steps it wraps, how to fully automate the parts Google keeps as
runtime state, and **ways to install without clasp at all**.

> First get your Dropbox **App key**, **App secret**, and **refresh token** —
> see [README §1](./README.md#1-create-the-dropbox-app--refresh-token). You'll
> also want a Gmail label (e.g. `Archive/ToDropbox`) applied to a few emails.

---

## Quick start — `bootstrap.sh`

```bash
git clone https://github.com/thewongdirection/gmail-to-dropbox-archiver.git
cd gmail-to-dropbox-archiver
./bootstrap.sh
```

It will:

1. Verify `node`/`npm` and install [`clasp`](https://github.com/google/clasp) if missing.
2. `clasp login` (opens a browser once).
3. `clasp create --type standalone` (or reuse an existing `.clasp.json`) and
   `clasp push` your `Code.gs` + `appsscript.json`.
4. Prompt for your Dropbox secrets + options and save them to a gitignored
   `.script-properties.json` (chmod 600).

Then it prints the two steps Google won't let a file-push do (set Script
Properties, run the setup functions). Flags: `--title "My Name"`, `--run`
(attempt `clasp run`, needs the [executable-API setup](#automating-everything-clasp-run)).

---

## What the CLI can and cannot do

Apps Script splits your project into two kinds of state:

| State | Is it a project file? | Set by `clasp push`? |
|-------|----------------------|----------------------|
| `Code.gs`, `appsscript.json` | ✅ yes | ✅ yes |
| **Script Properties** (your secrets) | ❌ runtime data | ❌ no |
| **Triggers** (the daily schedule) | ❌ runtime data | ❌ no |

So code deploys are fully scriptable; properties and triggers are set by
*running code* (`initConfig()`, `setupDailyTrigger()`), not by uploading files.
You either do that in the editor once, or wire up `clasp run` (below).

---

## Manual `clasp` steps (what bootstrap wraps)

```bash
npm install -g @google/clasp
clasp login
# Enable the Apps Script API once per account:
#   https://script.google.com/home/usersettings  → "Apps Script API: ON"

clasp create --type standalone --title "Gmail Dropbox Archiver"
clasp push          # uploads Code.gs + appsscript.json
clasp open-script   # opens the project in your browser
```

Then, once, in the editor:

1. **Project Settings ▸ Script Properties** — add `DROPBOX_APP_KEY`,
   `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `GMAIL_LABEL` (plus optional
   `DROPBOX_FOLDER`, `RUN_SUMMARY_EMAIL`, …). See the table in
   [README §3](./README.md#script-properties).
2. **Run menu** → `testDropboxConnection`, then `testArchiveOne`, then
   `setupDailyTrigger` — approving the OAuth consent screen on the first run.

Every later code change is just `clasp push`.

---

## Automating everything (`clasp run`)

`clasp run <fn>` executes a function in your deployed project from the terminal,
so you *can* script `setupDailyTrigger`, `testDropboxConnection`, etc. It needs a
one-time setup because it uses the Apps Script API:

1. `clasp open-script` → **Project Settings** → associate a **standard Google
   Cloud project** (create one at <https://console.cloud.google.com>; note its
   **project number**).
2. Enable the **Apps Script API** for that GCP project.
3. Add an executable deployment + the OAuth scopes to `appsscript.json`:

   ```jsonc
   {
     // …existing fields…
     "executionApi": { "access": "MYSELF" }
   }
   ```

   `clasp push`, then `clasp deploy`.
4. Now run functions directly:

   ```bash
   clasp run testDropboxConnection
   clasp run setupDailyTrigger
   ```

**Secrets note:** `initConfig()` hard-codes its values, so the cleanest way to
set properties without the UI is to paste your values into `initConfig()`,
`clasp push`, `clasp run initConfig`, then blank them out and push again. There
is **no** Apps Script API endpoint to set Script Properties directly — they can
only be written by code running inside the project.

---

## Installing WITHOUT clasp

clasp is just a friendly wrapper around the Apps Script REST API. You have
several alternatives:

### 1. Manual copy-paste (zero tooling)
The baseline, no CLI at all: <https://script.google.com> → **New project**,
paste [`Code.gs`](./Code.gs), set the manifest and Script Properties in the UI.
Full steps in [README §3–4](./README.md#3-create-the-apps-script-project).

### 2. The Apps Script REST API directly (`curl`)
`clasp` calls [`projects.create`](https://developers.google.com/apps-script/api/reference/rest/v1/projects/create)
and [`projects.updateContent`](https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent).
You can hit them yourself with any HTTP client. Sketch:

```bash
# 1) Get an OAuth access token with the script.projects scope
#    (via gcloud, an OAuth playground token, or your own flow):
TOKEN="ya29...."

# 2) Create an empty standalone project:
SCRIPT_ID=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://script.googleapis.com/v1/projects \
  -d '{"title":"Gmail Dropbox Archiver"}' | jq -r .scriptId)

# 3) Push files. Note: source goes as "SERVER_JS"; the manifest is a file
#    literally named "appsscript" of type "JSON".
curl -s -X PUT \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://script.googleapis.com/v1/projects/$SCRIPT_ID/content" \
  -d "$(jq -n --arg code "$(cat Code.gs)" --arg manifest "$(cat appsscript.json)" '
    {files: [
      {name:"Code",       type:"SERVER_JS", source:$code},
      {name:"appsscript", type:"JSON",      source:$manifest}
    ]}')"
```

This is exactly what `bootstrap.sh` automates for you via clasp — reach for raw
`curl` only if you can't install clasp (locked-down CI, etc.). Requires the
Apps Script API enabled and a token carrying
`https://www.googleapis.com/auth/script.projects`.

### 3. `google-apps-script-github-assistant` / CI
For teams, some wire `clasp push` into CI (GitHub Actions) using a stored
`.clasprc.json` (refresh token) as a secret, so merges to `main` redeploy the
script. Same clasp under the hood, just headless.

### 4. Container-bound alternative
If you'd rather bind the script to a Google **Sheet/Doc** instead of a
standalone project, you can create it from Apps Script inside that container —
but standalone (what this repo assumes) is simpler for a background job.

> There is **no** official Git-native or `gcloud`-native deploy for Apps
> Script; every path above ultimately uses either the editor or the Apps Script
> REST API.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `User has not enabled the Apps Script API` | Turn it on at <https://script.google.com/home/usersettings>, wait a minute, retry. |
| `clasp login` opens but never completes | Try `clasp login --no-localhost` and paste the code. |
| `clasp push` overwrites nothing / wrong project | Check `.clasp.json`'s `scriptId`; delete it to start fresh. |
| Upload/PDF errors at run time | Run `testDropboxConnection` and check **Executions** logs; verify the three Dropbox secrets. |
