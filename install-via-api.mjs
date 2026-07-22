#!/usr/bin/env node
/**
 * install-via-api.mjs — install the Gmail → Dropbox archiver using the Apps
 * Script REST API directly, without clasp.
 *
 * clasp is only a wrapper around two API calls:
 *   • projects.create        → make an empty standalone Apps Script project
 *   • projects.updateContent → upload Code.gs + the appsscript manifest
 * This script makes those calls itself, with zero npm dependencies (Node 18+).
 *
 * ── Authentication (pick one) ───────────────────────────────────────────────
 *   A) Bring your own access token (simplest for one-offs):
 *        GAS_ACCESS_TOKEN=ya29.… node install-via-api.mjs
 *      Get a token carrying the `script.projects` scope from the OAuth 2.0
 *      Playground (https://developers.google.com/oauthplayground, gear ▸ use
 *      your own credentials, scope https://www.googleapis.com/auth/script.projects)
 *      or `gcloud auth print-access-token` if your ADC has that scope.
 *
 *   B) Full OAuth loopback flow (reusable): create a **Desktop app** OAuth
 *      client at https://console.cloud.google.com/apis/credentials, then:
 *        GOOGLE_CLIENT_ID=…apps.googleusercontent.com \
 *        GOOGLE_CLIENT_SECRET=… \
 *        node install-via-api.mjs
 *      A browser opens (or a URL is printed) to authorize; the script catches
 *      the redirect on localhost and exchanges the code for a token.
 *
 * ── Prerequisite ────────────────────────────────────────────────────────────
 *   Enable the Apps Script API once per account:
 *   https://script.google.com/home/usersettings  →  "Apps Script API: ON"
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node install-via-api.mjs [options]
 *     --title <name>        Project title (default "Gmail Dropbox Archiver")
 *     --script-id <id>      Update an EXISTING project instead of creating one
 *     --token <ya29…>       Access token (overrides GAS_ACCESS_TOKEN)
 *     --client-id <id>      OAuth client id (overrides GOOGLE_CLIENT_ID)
 *     --client-secret <s>   OAuth client secret (overrides GOOGLE_CLIENT_SECRET)
 *     --no-browser          Don't try to auto-open the auth URL; just print it
 *     --write-clasp         Write .clasp.json so later `clasp push/run` works
 *     --with-properties     Also push a SetupProperties.gs generated from
 *                           .script-properties.json (run applyScriptProperties()
 *                           once in the editor, then delete it)
 *     -h, --help            Show this help
 *
 * NOTE: Script Properties (your Dropbox secrets) and the daily trigger are
 * runtime state, not project files — the REST API cannot set them directly.
 * --with-properties gets you close: it pushes a one-call applyScriptProperties()
 * so the last step is running a single function. The trigger still needs
 * setupDailyTrigger() run once (see SETUP-CLI.md).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { buildSetupGs } from './gen-init-properties.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://script.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/script.projects';

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { title: 'Gmail Dropbox Archiver', noBrowser: false, writeClasp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} needs a value`);
    switch (a) {
      case '--title': out.title = next(); break;
      case '--script-id': out.scriptId = next(); break;
      case '--token': out.token = next(); break;
      case '--client-id': out.clientId = next(); break;
      case '--client-secret': out.clientSecret = next(); break;
      case '--no-browser': out.noBrowser = true; break;
      case '--write-clasp': out.writeClasp = true; break;
      case '--with-properties': out.withProperties = true; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default: die(`Unknown argument: ${a} (try --help)`);
    }
  }
  return out;
}

function printHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const banner = src.split('\n').filter((l) => l.startsWith(' *') || l.startsWith('/**'))
    .map((l) => l.replace(/^\/\*\*?/, '').replace(/^ \*\/?/, '').replace(/^ ?/, ''));
  console.log(banner.join('\n'));
}

const die = (msg) => { console.error(`\x1b[31m✗ ${msg}\x1b[0m`); process.exit(1); };
const info = (msg) => console.log(`\x1b[1m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
const warn = (msg) => console.log(`\x1b[33m! ${msg}\x1b[0m`);

// ── token acquisition ─────────────────────────────────────────────────────────
async function getAccessToken(opts) {
  const token = opts.token || process.env.GAS_ACCESS_TOKEN;
  if (token) { ok('Using provided access token'); return token; }

  const clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = opts.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return oauthLoopback(clientId, clientSecret, opts.noBrowser);

  die('No credentials. Set GAS_ACCESS_TOKEN (see --help option A), or ' +
      'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET for the OAuth flow (option B).');
}

function oauthLoopback(clientId, clientSecret, noBrowser) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost`);
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
          res.writeHead(204).end(); return; // ignore favicon etc.
        }
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif"><h3>' +
          (err ? 'Authorization failed: ' + err : 'Authorized — you can close this tab.') +
          '</h3></body></html>');
        server.close();
        if (err) return reject(new Error('OAuth error: ' + err));
        if (returnedState !== state) return reject(new Error('OAuth state mismatch (possible CSRF).'));

        info('Exchanging authorization code for an access token');
        const body = new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code'
        });
        const tokRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const tok = await tokRes.json();
        if (!tokRes.ok) return reject(new Error('Token exchange failed: ' + JSON.stringify(tok)));
        ok('Access token obtained');
        resolve(tok.access_token);
      } catch (e) { reject(e); }
    });

    // Random state; ephemeral loopback port (allowed for Desktop OAuth clients).
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let redirectUri;
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent', state
      });
      console.log('\nAuthorize access by opening this URL:\n\n  ' + authUrl + '\n');
      if (!noBrowser) tryOpen(authUrl);
      info('Waiting for authorization (listening on ' + redirectUri + ')…');
    });
    server.on('error', reject);
  });
}

function tryOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print-only */ }
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function apiFetch(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail = json?.error?.message || text || res.statusText;
    if (res.status === 403 && /Apps Script API/i.test(detail)) {
      die('Apps Script API is not enabled for this account.\n' +
          '  Turn it on at https://script.google.com/home/usersettings and retry.');
    }
    die(`API ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question + ' [y/N] ', r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ── main ──────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));

const codeSource = readFileSync(join(HERE, 'Code.gs'), 'utf8');
const manifestSource = readFileSync(join(HERE, 'appsscript.json'), 'utf8');
try { JSON.parse(manifestSource); } catch { die('appsscript.json is not valid JSON'); }

const token = await getAccessToken(opts);

let scriptId = opts.scriptId;
if (scriptId) {
  info(`Updating existing project ${scriptId}`);
} else {
  info(`Creating standalone Apps Script project: "${opts.title}"`);
  const project = await apiFetch(token, 'POST', '/projects', { title: opts.title });
  scriptId = project.scriptId;
  ok(`Project created: ${scriptId}`);
}

// updateContent replaces ALL files. The manifest MUST be included, named
// "appsscript" (type JSON); source files use type SERVER_JS with no extension.
const files = [
  { name: 'appsscript', type: 'JSON', source: manifestSource },
  { name: 'Code', type: 'SERVER_JS', source: codeSource }
];

let pushedProps = false;
if (opts.withProperties) {
  try {
    const props = JSON.parse(readFileSync(join(HERE, '.script-properties.json'), 'utf8'));
    files.push({ name: 'SetupProperties', type: 'SERVER_JS', source: buildSetupGs(props) });
    pushedProps = true;
    warn('Bundling SetupProperties.gs (contains secrets) — delete it after running it.');
  } catch (e) {
    die('--with-properties needs .script-properties.json (run connect-dropbox.mjs first): ' + e.message);
  }
}

info('Pushing ' + files.map((f) => f.name).join(', '));
await apiFetch(token, 'PUT', `/projects/${scriptId}/content`, { files });
ok('Content uploaded');

if (opts.writeClasp) {
  const claspPath = join(HERE, '.clasp.json');
  let write = true;
  try { readFileSync(claspPath); write = await confirm('.clasp.json exists — overwrite?'); } catch { /* none */ }
  if (write) {
    writeFileSync(claspPath, JSON.stringify({ scriptId, rootDir: HERE }, null, 2) + '\n');
    ok('Wrote .clasp.json (gitignored) — `clasp push`/`clasp run` will target this project');
  }
}

const editorUrl = `https://script.google.com/d/${scriptId}/edit`;
const step1 = pushedProps
  ? `1. Run applyScriptProperties() once (Run menu) to set your Script
     Properties, then DELETE SetupProperties.gs and re-push (drop
     --with-properties) so the secrets don't linger in the source.`
  : `1. Script Properties — open the project ▸ Project Settings ▸ Script
     Properties, and add DROPBOX_APP_KEY / DROPBOX_APP_SECRET /
     DROPBOX_REFRESH_TOKEN / GMAIL_LABEL (+ optional DROPBOX_FOLDER,
     RUN_SUMMARY_EMAIL). See README §3. (Tip: --with-properties makes this
     a one-function call.)`;
console.log(`
──────────────────────────────────────────────────────────────────────────
Code is live at:
  ${editorUrl}

Runtime steps the REST API can't do (set them once):
  ${step1}
  2. Run testDropboxConnection, testArchiveOne, then setupDailyTrigger from
     the editor's Run menu (approve the OAuth prompt on first run).

Full details + automation options in SETUP-CLI.md.
──────────────────────────────────────────────────────────────────────────`);
ok('Done.');
