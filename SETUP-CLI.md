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

**On Windows, use `bootstrap.ps1` instead** — see [Windows](#windows) below.

---

## Windows

`bootstrap.sh` is a bash script, so in `cmd`/PowerShell use the PowerShell
port, **`bootstrap.ps1`** — it does the same four steps (verify/install clasp,
login, create + push, prompt for secrets):

```powershell
git clone https://github.com/thewongdirection/gmail-to-dropbox-archiver.git
cd gmail-to-dropbox-archiver
# If scripts are blocked, allow this one process:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
./bootstrap.ps1                 # or: ./bootstrap.ps1 -Title "My Archiver"  /  -Run
```

It writes the same gitignored `.script-properties.json` (locked to your user
via an ACL) and prints the two remaining editor steps.

**The Node scripts are already cross-platform** and are the recommended Windows
path if you'd rather not touch clasp — `connect-dropbox.mjs`,
`install-via-api.mjs`, and `gen-init-properties.mjs` all run the same on
Windows (the browser auto-open uses `start`, and `chmod` calls no-op). The one
difference is **environment-variable syntax** — PowerShell, not the bash
`NAME=value cmd` form:

```powershell
# PowerShell:
$env:DROPBOX_APP_KEY="abc"; $env:DROPBOX_APP_SECRET="def"
node connect-dropbox.mjs
$env:GAS_ACCESS_TOKEN="ya29...."
node install-via-api.mjs --with-properties

# cmd.exe:
set DROPBOX_APP_KEY=abc
node connect-dropbox.mjs
```

Or just run the scripts with no env set and answer the prompts (the app-secret
prompt is hidden). Prefer **Windows Terminal / PowerShell 7** — the hidden
secret prompt in `connect-dropbox.mjs` relies on terminal raw-mode, which can
misbehave in very old consoles; if it does, pass the secret via `$env:` instead.

Bash users on Windows (Git Bash or WSL) can run `bootstrap.sh` unchanged.

Everything else in this guide (`clasp run`, no-clasp REST install, one-call
properties) works identically on Windows.

---

## Connecting to Dropbox (`connect-dropbox.mjs`)

Getting the Dropbox credentials is its own mini-flow, and most of it is
scriptable. `connect-dropbox.mjs` (zero-dependency, Node 18+) automates
everything after the app exists:

```bash
node connect-dropbox.mjs
# or non-interactively for the credential part:
DROPBOX_APP_KEY=… DROPBOX_APP_SECRET=… node connect-dropbox.mjs \
  --gmail-label Archive/ToDropbox --folder "/Gmail Archive"
```

It opens the authorize URL, takes the one code you paste back, exchanges it for
a **refresh token**, verifies it by printing your Dropbox account, and writes
`DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` (+ label,
folder, optional summary email) into a gitignored `.script-properties.json`.

**Three things it can't do — Dropbox exposes no API for them, so do them once by
hand first:**

1. **Create the app** at <https://www.dropbox.com/developers/apps> (Scoped
   access; "App folder" recommended).
2. **Enable `files.content.write`** on the Permissions tab — *before* running
   the script, or the minted token won't carry the scope.
3. **Click "Allow"** on the consent screen. There's no password grant; consent
   is interactive by design. The script handles the rest.

Then copy the app key + secret from the app's **Settings** tab and run it.
There is no way to headlessly log in with a Dropbox username/password — that's
intentional. Flags: `--app-name` (path hint), `--summary-email`, `--no-browser`,
`--print-only` (show values without writing the file), `--help`.

`.script-properties.json` is the same file `bootstrap.sh` writes, so the two
compose: run `connect-dropbox.mjs` for Dropbox, then set those properties on the
project (editor, or the one-call helper below).

---

## Microsoft 365 / OneDrive (`connect-onedrive.mjs`)

To back up to OneDrive/SharePoint (M365), set `STORAGE_PROVIDER` to `onedrive`
(only M365) or `both` (Dropbox **and** M365), and provide the OneDrive
credentials. `connect-onedrive.mjs` (zero-dependency, Node 18+) automates the
Microsoft Graph OAuth once the Azure AD app exists:

```bash
node connect-onedrive.mjs --client-id <APP_ID> --tenant common
# confidential (web) app that has a secret:
ONEDRIVE_CLIENT_ID=… ONEDRIVE_CLIENT_SECRET=… node connect-onedrive.mjs
```

It runs the authorization-code flow **with PKCE over a localhost loopback**
(Microsoft retired the paste-a-code flow), verifies the token against your
drive, and writes `ONEDRIVE_CLIENT_ID` / `ONEDRIVE_REFRESH_TOKEN` /
`ONEDRIVE_TENANT` / `ONEDRIVE_FOLDER` (+ `STORAGE_PROVIDER`, and
`ONEDRIVE_CLIENT_SECRET` if you gave one) into `.script-properties.json`. If it
sees existing Dropbox creds there, it defaults `STORAGE_PROVIDER` to `both` —
override with `--provider onedrive`.

**Four things it can't do — do them once in the Azure portal
(<https://portal.azure.com> ▸ Microsoft Entra ID ▸ App registrations):**

1. **Register the app** (New registration). Under *Supported account types*,
   pick what matches you — personal Microsoft accounts, work/school, or both.
2. **Add a redirect URI** of type *Mobile and desktop applications* =
   `http://localhost` (Microsoft ignores the port, so the random loopback port
   the script uses is fine).
3. **Add delegated Graph permission** `Files.ReadWrite.All` (or `Files.ReadWrite`)
   **plus** `offline_access`, and grant/consent to it.
4. **Click through consent** in the browser the script opens (interactive by
   design — no password grant).

Then copy the **Application (client) ID** and run the script. Notes:

- **Native vs confidential app:** a *public/native* registration needs no
  secret (PKCE covers it) and is simplest. A *web/confidential* registration
  has a client secret — pass it, and it's stored so Apps Script can refresh.
- **Tenant:** `common` works for most; personal-only accounts can use
  `consumers`, single-tenant orgs their tenant id.
- **SharePoint / a specific library:** leave `ONEDRIVE_DRIVE_ID` blank to use
  the signed-in user's OneDrive, or set it to a drive id to target a SharePoint
  document library.
- **Refresh-token rotation:** Azure AD rotates refresh tokens; `Code.gs`
  re-saves the new one to Script Properties on each run, so the daily job keeps
  working. (The very first token must be set on the project — see below.)

Flags: `--client-id`, `--client-secret [value]`, `--tenant`, `--scope`,
`--folder`, `--provider onedrive|both`, `--no-browser`, `--print-only`, `--help`.

---

## Setting Script Properties in one call (`gen-init-properties.mjs`)

Script Properties can only be written by code *inside* the project — no API sets
them. To avoid hand-copying key/value pairs in the editor, generate a
pre-filled function from your `.script-properties.json`:

```bash
node gen-init-properties.mjs            # → SetupProperties.gs
```

`SetupProperties.gs` contains one function, `applyScriptProperties()`, with your
values baked in. Get it into the project, run it once, then delete it:

- **REST installer (one shot):** `node install-via-api.mjs --with-properties`
  pushes `Code.gs` *and* the generated `SetupProperties.gs` together. Open the
  project, run `applyScriptProperties()` from the Run menu, then delete the file
  and re-push without the flag so secrets don't linger in the source.
- **clasp:** `node gen-init-properties.mjs && clasp push && clasp run applyScriptProperties`
  (or run it from the editor), then delete `SetupProperties.gs` and `clasp push`.
- **manual:** `node gen-init-properties.mjs --stdout`, paste into a new file in
  the editor, run `applyScriptProperties()`, delete it.

`SetupProperties.gs` is gitignored (it holds live secrets) — never commit it,
and remove it from the project after that single run.

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

### 2. The Apps Script REST API directly — `install-via-api.mjs`
`clasp` is just a wrapper around two API calls:
[`projects.create`](https://developers.google.com/apps-script/api/reference/rest/v1/projects/create)
and [`projects.updateContent`](https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent).
This repo ships a **zero-dependency Node script** (Node 18+) that makes those
calls for you — no clasp, no `jq`, no npm install:

```bash
# Prereq (once): enable the Apps Script API at
#   https://script.google.com/home/usersettings

# A) With an access token you already have (script.projects scope):
GAS_ACCESS_TOKEN=ya29.… node install-via-api.mjs

# B) With a Desktop-app OAuth client (reusable; opens a browser to authorize):
GOOGLE_CLIENT_ID=…apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=… \
node install-via-api.mjs --write-clasp
```

It reads `Code.gs` + `appsscript.json`, creates a standalone project (or
updates one via `--script-id`), and uploads both files. Handy flags:

| Flag | Effect |
|------|--------|
| `--title <name>` | Project title (default "Gmail Dropbox Archiver") |
| `--script-id <id>` | Update an existing project instead of creating one |
| `--token <ya29…>` | Pass the access token inline (vs. `GAS_ACCESS_TOKEN`) |
| `--client-id` / `--client-secret` | OAuth client (vs. the env vars) |
| `--write-clasp` | Write `.clasp.json` so later `clasp push`/`clasp run` targets it |
| `--no-browser` | Print the auth URL instead of auto-opening it |
| `-h`, `--help` | Full usage |

**Getting a token for option A:** the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
(gear ▸ *use your own credentials*, authorize scope
`https://www.googleapis.com/auth/script.projects`), or
`gcloud auth print-access-token` if your ADC carries that scope.

Prefer raw `curl`? The same two calls by hand — note the manifest is a file
literally named `appsscript` of type `JSON`, and source files are `SERVER_JS`:

```bash
TOKEN="ya29...."
SCRIPT_ID=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://script.googleapis.com/v1/projects \
  -d '{"title":"Gmail Dropbox Archiver"}' | jq -r .scriptId)

curl -s -X PUT \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://script.googleapis.com/v1/projects/$SCRIPT_ID/content" \
  -d "$(jq -n --arg code "$(cat Code.gs)" --arg manifest "$(cat appsscript.json)" '
    {files: [
      {name:"appsscript", type:"JSON",      source:$manifest},
      {name:"Code",       type:"SERVER_JS", source:$code}
    ]}')"
```

Either way: the REST API can create and fill the project, but **not** set Script
Properties or triggers — those are runtime state (finish them in the editor or
via `clasp run`, as above).

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
