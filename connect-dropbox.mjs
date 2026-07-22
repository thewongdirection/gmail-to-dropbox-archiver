#!/usr/bin/env node
/**
 * connect-dropbox.mjs — automate the Dropbox OAuth handshake and produce the
 * credentials the archiver needs, with zero npm dependencies (Node 18+).
 *
 * WHAT THIS DOES (the automatable part):
 *   Given your Dropbox app key + secret, it runs the OAuth "offline" flow,
 *   turns the one-time authorization code into a long-lived **refresh token**,
 *   verifies it against your account, and writes DROPBOX_APP_KEY /
 *   DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN (+ GMAIL_LABEL / DROPBOX_FOLDER /
 *   RUN_SUMMARY_EMAIL) into a gitignored .script-properties.json.
 *
 * WHAT IT CANNOT DO (Dropbox has no API for these — do them once by hand):
 *   1. Create the app          → https://www.dropbox.com/developers/apps
 *   2. Enable files.content.write on the app's Permissions tab (BEFORE running
 *      this — a token minted before the scope is added won't carry it)
 *   3. Click "Allow" on the consent screen (interactive by design; there is no
 *      password grant). This script opens the URL and takes the code you paste.
 *   Then copy the app key + secret from the app's Settings tab and run this.
 *
 * USAGE:
 *   node connect-dropbox.mjs                       # prompts for everything
 *   DROPBOX_APP_KEY=… DROPBOX_APP_SECRET=… node connect-dropbox.mjs
 *   node connect-dropbox.mjs --app-key … --app-name gmail-archiver \
 *        --gmail-label Archive/ToDropbox --folder "/Gmail Archive"
 *
 * OPTIONS:
 *   --app-key <key>       Dropbox app key      (or DROPBOX_APP_KEY)
 *   --app-secret <secret> Dropbox app secret   (or DROPBOX_APP_SECRET; prompted
 *                                                hidden if omitted)
 *   --app-name <name>     App name — only used for messages + the App-folder
 *                         path hint (not required by the flow)
 *   --gmail-label <label> GMAIL_LABEL to write   (default "Archive/ToDropbox")
 *   --folder <path>       DROPBOX_FOLDER to write (default "/Gmail Archive")
 *   --summary-email <a>   RUN_SUMMARY_EMAIL to write (default blank = off)
 *   --no-browser          Print the auth URL instead of auto-opening it
 *   --print-only          Print the values; do NOT write .script-properties.json
 *   -h, --help            Show this help
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, emitKeypressEvents } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROPS_FILE = join(HERE, '.script-properties.json');

const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const info = (m) => console.log(`\x1b[1m▸ ${m}\x1b[0m`);
const ok = (m) => console.log(`\x1b[32m✓ ${m}\x1b[0m`);
const warn = (m) => console.log(`\x1b[33m! ${m}\x1b[0m`);

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    gmailLabel: 'Archive/ToDropbox', folder: '/Gmail Archive',
    summaryEmail: '', noBrowser: false, printOnly: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} needs a value`);
    switch (a) {
      case '--app-key': out.appKey = next(); break;
      case '--app-secret': out.appSecret = next(); break;
      case '--app-name': out.appName = next(); break;
      case '--gmail-label': out.gmailLabel = next(); break;
      case '--folder': out.folder = next(); break;
      case '--summary-email': out.summaryEmail = next(); break;
      case '--no-browser': out.noBrowser = true; break;
      case '--print-only': out.printOnly = true; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default: die(`Unknown argument: ${a} (try --help)`);
    }
  }
  return out;
}
function printHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.split('\n').filter((l) => l.startsWith(' *') || l.startsWith('/**'))
    .map((l) => l.replace(/^\/\*\*?/, '').replace(/^ \*\/?/, '').replace(/^ ?/, '')).join('\n'));
}

// ── prompts ───────────────────────────────────────────────────────────────────
function prompt(question, def) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = def ? `${question} [${def}]: ` : `${question}: `;
  return new Promise((r) => rl.question(q, (ans) => { rl.close(); r(ans.trim() || def || ''); }));
}
// Hidden prompt for secrets — echoes nothing as you type.
function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(`${question}: `);
    const wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = '';
    const onKey = (ch, key) => {
      if (key && (key.name === 'return' || key.name === 'enter')) {
        stdin.removeListener('keypress', onKey);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write('\n');
        resolve(buf);
      } else if (key && key.name === 'backspace') {
        buf = buf.slice(0, -1);
      } else if (key && key.ctrl && key.name === 'c') {
        stdout.write('\n'); process.exit(130);
      } else if (ch) {
        buf += ch;
      }
    };
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}

function tryOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print-only */ }
}

// ── Dropbox calls ─────────────────────────────────────────────────────────────
async function exchangeCode(appKey, appSecret, code) {
  const body = new URLSearchParams({ code, grant_type: 'authorization_code' });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${appKey}:${appSecret}`).toString('base64')
    },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = json.error_description || json.error || JSON.stringify(json);
    if (/invalid_grant|expired/i.test(hint)) {
      die('Authorization code rejected: ' + hint +
          '\n  The code is single-use and expires within minutes — re-run and paste a fresh one.');
    }
    die('Token exchange failed (' + res.status + '): ' + hint);
  }
  if (!json.refresh_token) {
    die('Dropbox did not return a refresh_token. Make sure the authorize URL used ' +
        'token_access_type=offline (this script does). Response: ' + JSON.stringify(json));
  }
  return json; // { refresh_token, access_token, ... }
}

async function verifyAccount(accessToken) {
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    warn('Could not verify account (' + res.status + '): ' + JSON.stringify(json));
    return null;
  }
  return json; // { email, name: { display_name }, ... }
}

function writeProps(values) {
  let existing = {};
  try { existing = JSON.parse(readFileSync(PROPS_FILE, 'utf8')); } catch { /* fresh */ }
  const merged = {
    PROCESSED_LABEL: 'Archived/Dropbox',
    MAX_THREADS_PER_RUN: '40',
    INCLUDE_ATTACHMENTS: 'true',
    ...existing,
    ...values
  };
  writeFileSync(PROPS_FILE, JSON.stringify(merged, null, 2) + '\n');
  try { chmodSync(PROPS_FILE, 0o600); } catch { /* non-posix */ }
  return merged;
}

// ── main ──────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));

console.log(`
Before running: create the app at https://www.dropbox.com/developers/apps,
enable "files.content.write" on its Permissions tab, then copy the app key +
secret from the Settings tab. (Dropbox has no API to automate those clicks.)
`);

const appKey = opts.appKey || process.env.DROPBOX_APP_KEY || await prompt('Dropbox app key');
if (!appKey) die('App key is required.');
const appSecret = opts.appSecret || process.env.DROPBOX_APP_SECRET || await promptHidden('Dropbox app secret');
if (!appSecret) die('App secret is required.');

// 1) Authorize — token_access_type=offline is what yields a refresh token.
const authUrl = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
  client_id: appKey, token_access_type: 'offline', response_type: 'code'
});
console.log('\n1) Approve access by opening this URL and clicking "Allow":\n\n  ' + authUrl + '\n');
if (!opts.noBrowser) tryOpen(authUrl);

// 2) The consent screen shows a one-time code; paste it here.
const code = (await prompt('2) Paste the authorization code shown by Dropbox')).trim();
if (!code) die('No authorization code entered.');

// 3) Exchange for a refresh token.
info('Exchanging the code for a refresh token');
const tok = await exchangeCode(appKey, appSecret, code);
ok('Refresh token obtained');

// 4) Verify it actually works.
info('Verifying against your Dropbox account');
const acct = await verifyAccount(tok.access_token);
if (acct) ok(`Connected as ${acct.name?.display_name || '(unknown)'} <${acct.email}>`);

// 5) Emit the four values.
const values = {
  DROPBOX_APP_KEY: appKey,
  DROPBOX_APP_SECRET: appSecret,
  DROPBOX_REFRESH_TOKEN: tok.refresh_token,
  GMAIL_LABEL: opts.gmailLabel,
  DROPBOX_FOLDER: opts.folder,
  RUN_SUMMARY_EMAIL: opts.summaryEmail
};

if (opts.printOnly) {
  console.log('\nScript Properties (set these on the Apps Script project):\n');
  for (const [k, v] of Object.entries(values)) {
    const shown = /SECRET|TOKEN/.test(k) ? v.slice(0, 6) + '…(hidden)' : v;
    console.log(`  ${k} = ${shown}`);
  }
  warn('--print-only: nothing written. Re-run without it to save .script-properties.json.');
} else {
  writeProps(values);
  ok(`Wrote ${PROPS_FILE} (gitignored, chmod 600)`);
}

const folderHint = opts.appName
  ? `Apps/${opts.appName}${values.DROPBOX_FOLDER}/ (App-folder apps are sandboxed there)`
  : `${values.DROPBOX_FOLDER}/ (relative to the app folder if you chose "App folder")`;

console.log(`
──────────────────────────────────────────────────────────────────────────
Dropbox is connected. Files will land in: ${folderHint}

Remaining step — get these values into the Apps Script project's Script
Properties (they can't be pushed via API):
  • Easiest: open the project and paste the key/value pairs from
    .script-properties.json into Project Settings ▸ Script Properties, or
  • paste them into initConfig() in Code.gs, run it once, then blank it out.

Then run testDropboxConnection (should print your account), testArchiveOne,
and setupDailyTrigger from the editor's Run menu. See SETUP-CLI.md.
──────────────────────────────────────────────────────────────────────────`);
ok('Done.');
