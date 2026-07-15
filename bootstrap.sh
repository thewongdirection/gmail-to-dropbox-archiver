#!/usr/bin/env bash
#
# bootstrap.sh — one-command CLI install for the Gmail → Dropbox PDF Archiver.
#
# What it automates (via clasp, Google's official Apps Script CLI):
#   1. Verifies node/npm and installs clasp if missing.
#   2. Logs you into Apps Script (browser OAuth), if not already.
#   3. Creates a new standalone Apps Script project (or reuses an existing
#      .clasp.json) and pushes Code.gs + appsscript.json.
#   4. Prompts for your Dropbox secrets + options and saves them locally to a
#      gitignored .script-properties.json.
#
# What it CANNOT fully automate (Google limitations — see SETUP-CLI.md):
#   * Script Properties and triggers are runtime state, not project files, so
#     they can't be set by a file push. This script writes a ready-to-paste
#     initConfig() snippet and tells you the two remaining clicks. With the
#     Apps Script "run" API wired up you can automate those too (--run flag).
#
# Usage:
#   ./bootstrap.sh                # deploy code + collect secrets
#   ./bootstrap.sh --title "My Archiver"
#   ./bootstrap.sh --run          # also try `clasp run` for setup functions
#                                 # (requires the executable-API setup in SETUP-CLI.md)
#
set -euo pipefail

TITLE="Gmail Dropbox Archiver"
DO_RUN=0
PROPS_FILE=".script-properties.json"

# --- tiny logging helpers ---------------------------------------------------
c_reset='\033[0m'; c_bold='\033[1m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'
info()  { printf "${c_bold}▸ %s${c_reset}\n" "$*"; }
ok()    { printf "${c_green}✓ %s${c_reset}\n" "$*"; }
warn()  { printf "${c_yellow}! %s${c_reset}\n" "$*"; }
die()   { printf "${c_red}✗ %s${c_reset}\n" "$*" >&2; exit 1; }

# --- args -------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title needs a value}"; shift 2 ;;
    --run)   DO_RUN=1; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

cd "$(dirname "$0")"

# --- 1. preflight -----------------------------------------------------------
info "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required (ships with node)"
ok "node $(node --version), npm $(npm --version)"

if ! command -v clasp >/dev/null 2>&1; then
  warn "clasp not found."
  printf "Install it globally now with 'npm install -g @google/clasp'? [y/N] "
  read -r reply
  case "$reply" in
    [yY]*) npm install -g @google/clasp || die "clasp install failed" ;;
    *) die "clasp is required. Install with: npm install -g @google/clasp" ;;
  esac
fi
ok "clasp $(clasp --version 2>/dev/null || echo '(installed)')"

# --- 2. login ---------------------------------------------------------------
info "Checking Apps Script login"
if ! clasp login --status >/dev/null 2>&1; then
  warn "Not logged in. A browser window will open for Google OAuth."
  clasp login || die "clasp login failed"
fi
ok "Logged in to Apps Script"

# Reminder: the Apps Script API toggle must be ON (once per Google account).
warn "If 'clasp create/push' errors with 'User has not enabled the Apps Script API',"
warn "enable it at https://script.google.com/home/usersettings and re-run."

# --- 3. create + push -------------------------------------------------------
if [ -f .clasp.json ]; then
  ok "Reusing existing .clasp.json (scriptId already set)"
else
  info "Creating a new standalone Apps Script project: $TITLE"
  clasp create --type standalone --title "$TITLE" || die "clasp create failed"
  ok "Project created (.clasp.json written — it's gitignored)"
fi

info "Pushing Code.gs + appsscript.json"
clasp push -f || die "clasp push failed"
ok "Code pushed"

# --- 4. collect secrets -----------------------------------------------------
info "Now let's collect your Dropbox credentials and options."
echo "  (Get these from SETUP-CLI.md / README section 1. Input is not echoed for secrets.)"

prompt_secret() { # var_name  prompt_text
  local __var="$1" __txt="$2" __val=""
  printf "  %s: " "$__txt"
  read -rs __val; echo
  printf -v "$__var" '%s' "$__val"
}
prompt_plain() {  # var_name  prompt_text  default
  local __var="$1" __txt="$2" __def="${3:-}" __val=""
  if [ -n "$__def" ]; then printf "  %s [%s]: " "$__txt" "$__def"; else printf "  %s: " "$__txt"; fi
  read -r __val
  printf -v "$__var" '%s' "${__val:-$__def}"
}

prompt_secret APP_KEY       "DROPBOX_APP_KEY"
prompt_secret APP_SECRET    "DROPBOX_APP_SECRET"
prompt_secret REFRESH_TOKEN "DROPBOX_REFRESH_TOKEN"
prompt_plain  GMAIL_LABEL   "GMAIL_LABEL"          "Archive/ToDropbox"
prompt_plain  DROPBOX_FOLDER "DROPBOX_FOLDER"      "/Gmail Archive"
prompt_plain  SUMMARY_EMAIL "RUN_SUMMARY_EMAIL (blank = off)" ""

[ -n "$APP_KEY" ] && [ -n "$APP_SECRET" ] && [ -n "$REFRESH_TOKEN" ] || \
  die "The three Dropbox values are required."

# JSON-escape helper (handles quotes/backslashes in values).
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

cat > "$PROPS_FILE" <<JSON
{
  "DROPBOX_APP_KEY": "$(json_escape "$APP_KEY")",
  "DROPBOX_APP_SECRET": "$(json_escape "$APP_SECRET")",
  "DROPBOX_REFRESH_TOKEN": "$(json_escape "$REFRESH_TOKEN")",
  "GMAIL_LABEL": "$(json_escape "$GMAIL_LABEL")",
  "DROPBOX_FOLDER": "$(json_escape "$DROPBOX_FOLDER")",
  "PROCESSED_LABEL": "Archived/Dropbox",
  "MAX_THREADS_PER_RUN": "40",
  "INCLUDE_ATTACHMENTS": "true",
  "RUN_SUMMARY_EMAIL": "$(json_escape "$SUMMARY_EMAIL")"
}
JSON
chmod 600 "$PROPS_FILE"
ok "Saved properties to $PROPS_FILE (gitignored, chmod 600)"

# --- 5. finish: set properties + trigger ------------------------------------
if [ "$DO_RUN" -eq 1 ]; then
  info "Attempting to apply properties + install trigger via 'clasp run'"
  warn "This only works if you've completed the executable-API setup in SETUP-CLI.md."
  # initConfig() reads nothing from args; it's easiest to set props in the UI.
  # setupDailyTrigger() and the test helpers DO run cleanly once the API is wired.
  clasp run testDropboxConnection || warn "clasp run failed — finish the steps below manually."
fi

cat <<'NEXT'

──────────────────────────────────────────────────────────────────────────
Almost done. Two things Google requires you to do in the editor (once):

  1. Set Script Properties. Open the project:
         clasp open-script
     then Project Settings ▸ Script Properties ▸ "Edit script properties",
     and add the key/value pairs from .script-properties.json.
     (Or paste the values into initConfig() in Code.gs, run it once from the
      Run menu, then blank them back out and `clasp push` again.)

  2. From the editor's Run menu, run these once — approving the OAuth prompt:
         testDropboxConnection   → confirms Dropbox creds (check Logs)
         testArchiveOne          → archives one labeled email end-to-end
         setupDailyTrigger       → installs the daily ~2 AM trigger

After that it runs itself. See SETUP-CLI.md for the full walkthrough and for
automating steps 1–2 with the Apps Script "run" API.
──────────────────────────────────────────────────────────────────────────
NEXT
ok "Bootstrap complete."
