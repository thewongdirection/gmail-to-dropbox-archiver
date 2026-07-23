#!/usr/bin/env node
/**
 * connect-onedrive.mjs — automate the Microsoft Graph (OneDrive / M365) OAuth
 * handshake and produce the credentials the archiver needs. Zero npm
 * dependencies (Node 18+).
 *
 * WHAT THIS DOES (the automatable part):
 *   Given your Azure AD app (client) id, it runs the OAuth authorization-code
 *   flow with PKCE over a localhost loopback, turns the result into a long-lived
 *   **refresh token**, verifies it against your drive, and writes
 *   ONEDRIVE_CLIENT_ID / ONEDRIVE_REFRESH_TOKEN / ONEDRIVE_TENANT (+ ARCHIVE_FOLDER,
 *   optional client secret) plus STORAGE_PROVIDER into .script-properties.json.
 *
 * WHAT IT CANNOT DO (no API for these — do them once in the Azure portal):
 *   1. Register the app at https://portal.azure.com ▸ Microsoft Entra ID ▸
 *      App registrations ▸ New registration. Under "Supported account types",
 *      pick what matches your account (personal, work/school, or both).
 *   2. Add a redirect URI of type "Mobile and desktop applications" =
 *      http://localhost  (Microsoft ignores the port for loopback, so the
 *      random port this script uses is fine).
 *   3. Grant delegated Microsoft Graph permission Files.ReadWrite.All (or
 *      Files.ReadWrite) — plus offline_access — and consent to it.
 *   4. Click through the consent screen this script opens (interactive by
 *      design; there is no password grant).
 *   Confidential (web) app registrations also need a client secret; native
 *   ones don't (PKCE covers it).
 *
 * USAGE:
 *   node connect-onedrive.mjs                          # prompts for client id
 *   node connect-onedrive.mjs --client-id <id> --tenant common
 *   ONEDRIVE_CLIENT_ID=… ONEDRIVE_CLIENT_SECRET=… node connect-onedrive.mjs
 *
 * OPTIONS:
 *   --client-id <id>      Azure AD app id       (or ONEDRIVE_CLIENT_ID)
 *   --client-secret <s>   Only for confidential (web) apps (or ONEDRIVE_CLIENT_SECRET;
 *                         prompted hidden if the flag is given without a value)
 *   --tenant <t>          common | organizations | consumers | tenant id (default common)
 *   --scope <s>           OAuth scope (default "offline_access Files.ReadWrite.All")
 *   --folder <path>       ARCHIVE_FOLDER to write — applies to every provider (default "/Gmail Archive")
 *   --provider <p>        STORAGE_PROVIDER to write: onedrive | both
 *                         (default: "both" if Dropbox creds already present, else "onedrive")
 *   --no-browser          Print the auth URL instead of auto-opening it
 *   --print-only          Print the values; do NOT write .script-properties.json
 *   -h, --help            Show this help
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROPS_FILE = join(HERE, '.script-properties.json');

const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const info = (m) => console.log(`\x1b[1m▸ ${m}\x1b[0m`);
const ok = (m) => console.log(`\x1b[32m✓ ${m}\x1b[0m`);
const warn = (m) => console.log(`\x1b[33m! ${m}\x1b[0m`);

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    tenant: 'common', scope: 'offline_access Files.ReadWrite.All',
    folder: '/Gmail Archive', noBrowser: false, printOnly: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} needs a value`);
    switch (a) {
      case '--client-id': out.clientId = next(); break;
      case '--client-secret': out.clientSecret = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : '__prompt__'; break;
      case '--tenant': out.tenant = next(); break;
      case '--scope': out.scope = next(); break;
      case '--folder': out.folder = next(); break;
      case '--provider': out.provider = next(); break;
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
function tryOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print-only */ }
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── OAuth loopback + PKCE ─────────────────────────────────────────────────────
function authorize(opts) {
  return new Promise((resolve, reject) => {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const authBase = `https://login.microsoftonline.com/${encodeURIComponent(opts.tenant)}/oauth2/v2.0`;
    let redirectUri;

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
          res.writeHead(204).end(); return;
        }
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif"><h3>' +
          (err ? 'Authorization failed: ' + err : 'Authorized — you can close this tab.') +
          '</h3></body></html>');
        server.close();
        if (err) return reject(new Error('OAuth error: ' + err + ' — ' + (url.searchParams.get('error_description') || '')));
        if (url.searchParams.get('state') !== state) return reject(new Error('OAuth state mismatch (possible CSRF).'));

        info('Exchanging authorization code for tokens');
        const body = new URLSearchParams({
          client_id: opts.clientId, grant_type: 'authorization_code', code,
          redirect_uri: redirectUri, code_verifier: verifier, scope: opts.scope
        });
        if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
        const tokRes = await fetch(`${authBase}/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
        });
        const tok = await tokRes.json().catch(() => ({}));
        if (!tokRes.ok) return reject(new Error('Token exchange failed (' + tokRes.status + '): ' +
          (tok.error_description || JSON.stringify(tok))));
        if (!tok.refresh_token) return reject(new Error(
          'No refresh_token returned. Ensure "offline_access" is in the scope and consented. Response: ' + JSON.stringify(tok)));
        resolve(tok);
      } catch (e) { reject(e); }
    });

    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://localhost:${server.address().port}`;
      const authUrl = `${authBase}/authorize?` + new URLSearchParams({
        client_id: opts.clientId, response_type: 'code', redirect_uri: redirectUri,
        response_mode: 'query', scope: opts.scope, state,
        code_challenge: challenge, code_challenge_method: 'S256'
      });
      console.log('\nApprove access by opening this URL and signing in:\n\n  ' + authUrl + '\n');
      if (!opts.noBrowser) tryOpen(authUrl);
      info('Waiting for authorization (listening on ' + redirectUri + ')…');
    });
    server.on('error', reject);
  });
}

async function verifyDrive(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { warn('Could not verify drive (' + res.status + '): ' + JSON.stringify(json)); return null; }
  return json; // { owner: { user: { displayName } }, driveType, quota, ... }
}

function readExistingProps() {
  try { return JSON.parse(readFileSync(PROPS_FILE, 'utf8')); } catch { return {}; }
}
function writeProps(values) {
  const merged = {
    PROCESSED_LABEL: 'Archived/Dropbox', MAX_THREADS_PER_RUN: '40', INCLUDE_ATTACHMENTS: 'true',
    ...readExistingProps(), ...values
  };
  writeFileSync(PROPS_FILE, JSON.stringify(merged, null, 2) + '\n');
  try { chmodSync(PROPS_FILE, 0o600); } catch { /* non-posix */ }
  return merged;
}

// ── main ──────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));

console.log(`
Before running: register an app at https://portal.azure.com (Microsoft Entra ID
▸ App registrations), add redirect URI http://localhost (type "Mobile and
desktop applications"), and grant delegated Graph permission Files.ReadWrite.All
+ offline_access. Then copy the Application (client) ID. See SETUP-CLI.md.
`);

opts.clientId = opts.clientId || process.env.ONEDRIVE_CLIENT_ID || await prompt('Azure AD application (client) id');
if (!opts.clientId) die('Client id is required.');

// Client secret: env, or --client-secret (with value or as a hidden prompt trigger).
if (opts.clientSecret === '__prompt__') opts.clientSecret = await prompt('Client secret (blank for a native/PKCE app)');
opts.clientSecret = opts.clientSecret || process.env.ONEDRIVE_CLIENT_SECRET || '';

const tok = await authorize(opts);
ok('Refresh token obtained');

info('Verifying against your OneDrive');
const drive = await verifyDrive(tok.access_token);
if (drive) {
  const who = drive.owner && drive.owner.user ? drive.owner.user.displayName : '(unknown)';
  ok(`Connected to ${drive.driveType || 'drive'} owned by ${who}`);
}

// Decide STORAGE_PROVIDER: explicit flag, else "both" when Dropbox creds already exist.
const existing = readExistingProps();
const hasDropbox = existing.DROPBOX_APP_KEY && existing.DROPBOX_REFRESH_TOKEN;
const provider = opts.provider || (hasDropbox ? 'both' : 'onedrive');

const values = {
  STORAGE_PROVIDER: provider,
  ONEDRIVE_CLIENT_ID: opts.clientId,
  ONEDRIVE_REFRESH_TOKEN: tok.refresh_token,
  ONEDRIVE_TENANT: opts.tenant,
  ARCHIVE_FOLDER: opts.folder  // one destination folder for every provider
};
if (opts.clientSecret) values.ONEDRIVE_CLIENT_SECRET = opts.clientSecret;

if (opts.printOnly) {
  console.log('\nScript Properties (set these on the Apps Script project):\n');
  for (const [k, v] of Object.entries(values)) {
    console.log(`  ${k} = ${/SECRET|TOKEN/.test(k) ? String(v).slice(0, 6) + '…(hidden)' : v}`);
  }
  warn('--print-only: nothing written.');
} else {
  writeProps(values);
  ok(`Wrote ${PROPS_FILE} (gitignored, chmod 600) with STORAGE_PROVIDER=${provider}`);
}

console.log(`
──────────────────────────────────────────────────────────────────────────
OneDrive is connected (STORAGE_PROVIDER=${provider}). Files will land in the
user's OneDrive under ${values.ARCHIVE_FOLDER}/ (set ONEDRIVE_DRIVE_ID to
target a SharePoint document library instead).

Remaining step — get these values into the Apps Script project's Script
Properties (paste from .script-properties.json, or use gen-init-properties.mjs).
Then run testOneDriveConnection and setupDailyTrigger from the editor.
See SETUP-CLI.md.
──────────────────────────────────────────────────────────────────────────`);
ok('Done.');
