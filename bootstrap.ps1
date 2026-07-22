<#
.SYNOPSIS
  One-command install for the Gmail -> Dropbox PDF Archiver (Windows/PowerShell).

.DESCRIPTION
  PowerShell equivalent of bootstrap.sh. Via clasp (Google's official Apps
  Script CLI) it:
    1. Verifies node/npm and installs clasp if missing.
    2. Logs you into Apps Script (browser OAuth), if not already.
    3. Creates a new standalone Apps Script project (or reuses an existing
       .clasp.json) and pushes Code.gs + appsscript.json.
    4. Prompts for your Dropbox secrets + options and saves them locally to a
       gitignored .script-properties.json.

  What it CANNOT fully automate (Google limitations - see SETUP-CLI.md):
    Script Properties and triggers are runtime state, not project files, so
    they can't be set by a file push. Finish those two steps in the editor
    (or wire up `clasp run`, see -Run and SETUP-CLI.md).

.PARAMETER Title
  Apps Script project title (default "Gmail Dropbox Archiver").

.PARAMETER Run
  Also attempt `clasp run` for the setup functions (requires the executable-API
  setup described in SETUP-CLI.md).

.EXAMPLE
  ./bootstrap.ps1
.EXAMPLE
  ./bootstrap.ps1 -Title "My Archiver"
.EXAMPLE
  ./bootstrap.ps1 -Run
#>
[CmdletBinding()]
param(
  [string]$Title = "Gmail Dropbox Archiver",
  [switch]$Run
)

$ErrorActionPreference = "Stop"
$PropsFile = ".script-properties.json"

# --- tiny logging helpers ---------------------------------------------------
function Write-Info { param($m) Write-Host "> $m"  -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "OK $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "!  $m" -ForegroundColor Yellow }
function Die        { param($m) Write-Host "X  $m" -ForegroundColor Red; exit 1 }

function Test-Command { param($name) [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Run inside the script's own directory so relative paths resolve.
Set-Location -LiteralPath $PSScriptRoot

# --- 1. preflight -----------------------------------------------------------
Write-Info "Checking prerequisites"
if (-not (Test-Command node)) { Die "node is required (https://nodejs.org)" }
if (-not (Test-Command npm))  { Die "npm is required (ships with node)" }
Write-Ok ("node {0}, npm {1}" -f (node --version), (npm --version))

if (-not (Test-Command clasp)) {
  Write-Warn "clasp not found."
  $reply = Read-Host "Install it globally now with 'npm install -g @google/clasp'? [y/N]"
  if ($reply -match '^(y|yes)$') {
    npm install -g @google/clasp
    if ($LASTEXITCODE -ne 0) { Die "clasp install failed" }
  } else {
    Die "clasp is required. Install with: npm install -g @google/clasp"
  }
}
# clasp may be a .cmd/.ps1 shim on Windows; call through cmd for a clean version string.
$claspVersion = (clasp --version 2>$null); if (-not $claspVersion) { $claspVersion = "(installed)" }
Write-Ok "clasp $claspVersion"

# --- 2. login ---------------------------------------------------------------
Write-Info "Checking Apps Script login"
clasp login --status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Warn "Not logged in. A browser window will open for Google OAuth."
  clasp login
  if ($LASTEXITCODE -ne 0) { Die "clasp login failed" }
}
Write-Ok "Logged in to Apps Script"

Write-Warn "If 'clasp create/push' errors with 'User has not enabled the Apps Script API',"
Write-Warn "enable it at https://script.google.com/home/usersettings and re-run."

# --- 3. create + push -------------------------------------------------------
if (Test-Path -LiteralPath ".clasp.json") {
  Write-Ok "Reusing existing .clasp.json (scriptId already set)"
} else {
  Write-Info "Creating a new standalone Apps Script project: $Title"
  clasp create --type standalone --title "$Title"
  if ($LASTEXITCODE -ne 0) { Die "clasp create failed" }
  Write-Ok "Project created (.clasp.json written - it's gitignored)"
}

Write-Info "Pushing Code.gs + appsscript.json"
clasp push -f
if ($LASTEXITCODE -ne 0) { Die "clasp push failed" }
Write-Ok "Code pushed"

# --- 4. collect secrets -----------------------------------------------------
Write-Info "Now let's collect your Dropbox credentials and options."
Write-Host "  (Get these from SETUP-CLI.md / README section 1. Secret input is hidden.)"

function Read-Secret {
  param([string]$Label)
  $secure = Read-Host -Prompt "  $Label" -AsSecureString
  # Convert SecureString -> plain text (needed to write into JSON).
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Read-Plain {
  param([string]$Label, [string]$Default = "")
  $prompt = if ($Default) { "  $Label [$Default]" } else { "  $Label" }
  $val = Read-Host -Prompt $prompt
  if ([string]::IsNullOrWhiteSpace($val)) { $Default } else { $val }
}

$AppKey       = Read-Secret "DROPBOX_APP_KEY"
$AppSecret    = Read-Secret "DROPBOX_APP_SECRET"
$RefreshToken = Read-Secret "DROPBOX_REFRESH_TOKEN"
$GmailLabel   = Read-Plain  "GMAIL_LABEL"   "Archive/ToDropbox"
$Folder       = Read-Plain  "DROPBOX_FOLDER" "/Gmail Archive"
$SummaryEmail = Read-Plain  "RUN_SUMMARY_EMAIL (blank = off)" ""

if ([string]::IsNullOrWhiteSpace($AppKey) -or
    [string]::IsNullOrWhiteSpace($AppSecret) -or
    [string]::IsNullOrWhiteSpace($RefreshToken)) {
  Die "The three Dropbox values are required."
}

# Build the properties object and let ConvertTo-Json handle all escaping.
$props = [ordered]@{
  DROPBOX_APP_KEY       = $AppKey
  DROPBOX_APP_SECRET    = $AppSecret
  DROPBOX_REFRESH_TOKEN = $RefreshToken
  GMAIL_LABEL           = $GmailLabel
  DROPBOX_FOLDER        = $Folder
  PROCESSED_LABEL       = "Archived/Dropbox"
  MAX_THREADS_PER_RUN   = "40"
  INCLUDE_ATTACHMENTS   = "true"
  RUN_SUMMARY_EMAIL     = $SummaryEmail
}
# Write UTF-8 without BOM so the JSON parses cleanly everywhere.
$json = ($props | ConvertTo-Json)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $PropsFile), $json, (New-Object System.Text.UTF8Encoding($false)))

# Best-effort: lock the file down to the current user (NTFS only).
try {
  $acl = Get-Acl -LiteralPath $PropsFile
  $acl.SetAccessRuleProtection($true, $false)  # disable inheritance, drop inherited rules
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
    "FullControl", "Allow")
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $PropsFile -AclObject $acl
} catch { Write-Warn "Could not tighten file permissions (non-NTFS?) - $($_.Exception.Message)" }
Write-Ok "Saved properties to $PropsFile (gitignored, locked to your user)"

# --- 5. finish: set properties + trigger ------------------------------------
if ($Run) {
  Write-Info "Attempting to apply properties + install trigger via 'clasp run'"
  Write-Warn "This only works if you've completed the executable-API setup in SETUP-CLI.md."
  clasp run testDropboxConnection
  if ($LASTEXITCODE -ne 0) { Write-Warn "clasp run failed - finish the steps below manually." }
}

@"

--------------------------------------------------------------------------
Almost done. Two things Google requires you to do in the editor (once):

  1. Set Script Properties. Open the project:
         clasp open-script
     then Project Settings > Script Properties > "Edit script properties",
     and add the key/value pairs from .script-properties.json.
     (Or generate a one-call setter:  node gen-init-properties.mjs)

  2. From the editor's Run menu, run these once - approving the OAuth prompt:
         testDropboxConnection   -> confirms Dropbox creds (check Logs)
         testArchiveOne          -> archives one labeled email end-to-end
         setupDailyTrigger       -> installs the daily ~2 AM trigger

After that it runs itself. See SETUP-CLI.md for the full walkthrough and for
automating steps 1-2 with the Apps Script "run" API.
--------------------------------------------------------------------------
"@ | Write-Host

Write-Ok "Bootstrap complete."
