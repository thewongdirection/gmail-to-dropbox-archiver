/**
 * Gmail → Cloud PDF Archiver (Dropbox and/or Microsoft 365 / OneDrive)
 * ---------------------------------------------------------------------------
 * Archives Gmail messages that carry a specific label by:
 *   1. Rendering each message (headers + body) to a PDF.
 *   2. Uploading that PDF — and any real file attachments — to one or more
 *      cloud targets: Dropbox, OneDrive/SharePoint (M365), or both.
 *   3. Tagging the thread with a "processed" label so it is never archived twice.
 *
 * Runs on a daily time-based trigger. All secrets live in Script Properties,
 * never in this file. See README.md for one-time setup.
 * ---------------------------------------------------------------------------
 */

/**
 * Configuration is read from Script Properties (Project Settings ▸ Script
 * Properties, or set programmatically with initConfig()).
 *
 *   GMAIL_LABEL            Gmail label to archive, e.g. "Archive/ToDropbox" (required)
 *   STORAGE_PROVIDER       "dropbox" | "onedrive" | "both"    (default "dropbox")
 *   ARCHIVE_FOLDER         Destination folder for BOTH providers (default "/Gmail Archive").
 *                          Per-provider DROPBOX_FOLDER / ONEDRIVE_FOLDER override it.
 *   SUBJECT_REGEX          Only archive messages whose subject matches this regex;
 *                          blank = archive every message in a labeled thread (default "")
 *   SUBJECT_REGEX_FLAGS    Regex flags for SUBJECT_REGEX (default "i" case-insensitive;
 *                          set to "" for case-sensitive; g/y ignored)
 *   PROCESSED_LABEL        Label applied after archiving      (default "Archived/Dropbox")
 *   MAX_THREADS_PER_RUN    Safety cap per execution           (default "40")
 *   INCLUDE_ATTACHMENTS    "true"/"false"                     (default "true")
 *   RUN_SUMMARY_EMAIL      Address to email a per-run digest; blank = off (default "")
 *
 *   -- Dropbox (required when STORAGE_PROVIDER is "dropbox" or "both") --
 *   DROPBOX_APP_KEY        Dropbox app key
 *   DROPBOX_APP_SECRET     Dropbox app secret
 *   DROPBOX_REFRESH_TOKEN  Dropbox refresh token
 *   DROPBOX_FOLDER         Destination folder override (default: ARCHIVE_FOLDER)
 *
 *   -- OneDrive / M365 (required when STORAGE_PROVIDER is "onedrive" or "both") --
 *   ONEDRIVE_CLIENT_ID     Azure AD app (client) id
 *   ONEDRIVE_REFRESH_TOKEN Microsoft Graph refresh token (rotated + re-saved automatically)
 *   ONEDRIVE_CLIENT_SECRET App secret — only for confidential (web) app registrations (optional)
 *   ONEDRIVE_TENANT        "common" | "organizations" | "consumers" | tenant id (default "common")
 *   ONEDRIVE_SCOPE         OAuth scope (default "offline_access Files.ReadWrite.All")
 *   ONEDRIVE_FOLDER        Destination folder override (default: ARCHIVE_FOLDER)
 *   ONEDRIVE_DRIVE_ID      Target a specific drive (SharePoint library); blank = the user's OneDrive
 */
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var p = props.getProperties();

  var provider = normalizeProvider_(p.STORAGE_PROVIDER);
  var useDropbox = provider === 'dropbox' || provider === 'both';
  var useOneDrive = provider === 'onedrive' || provider === 'both';

  var required = ['GMAIL_LABEL'];
  if (useDropbox) required.push('DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN');
  if (useOneDrive) required.push('ONEDRIVE_CLIENT_ID', 'ONEDRIVE_REFRESH_TOKEN');
  var missing = required.filter(function (k) { return !p[k]; });
  if (missing.length) {
    throw new Error('Missing Script Properties: ' + missing.join(', ') +
      ' (STORAGE_PROVIDER=' + provider + '). Run initConfig() or set them under ' +
      'Project Settings ▸ Script Properties.');
  }

  // One folder for every destination, with optional per-provider overrides.
  var archiveFolder = p.ARCHIVE_FOLDER || '/Gmail Archive';
  var trimFolder = function (f) { return f.replace(/\/+$/, ''); };

  return {
    provider: provider,
    useDropbox: useDropbox,
    useOneDrive: useOneDrive,

    // Dropbox
    appKey: p.DROPBOX_APP_KEY,
    appSecret: p.DROPBOX_APP_SECRET,
    refreshToken: p.DROPBOX_REFRESH_TOKEN,
    dropboxFolder: trimFolder(p.DROPBOX_FOLDER || archiveFolder),

    // OneDrive / Microsoft 365
    onedriveClientId: p.ONEDRIVE_CLIENT_ID,
    onedriveClientSecret: p.ONEDRIVE_CLIENT_SECRET || '',
    onedriveRefreshToken: p.ONEDRIVE_REFRESH_TOKEN,
    onedriveTenant: p.ONEDRIVE_TENANT || 'common',
    onedriveScope: p.ONEDRIVE_SCOPE || 'offline_access Files.ReadWrite.All',
    onedriveFolder: trimFolder(p.ONEDRIVE_FOLDER || archiveFolder),
    onedriveDrivePrefix: p.ONEDRIVE_DRIVE_ID ? '/drives/' + p.ONEDRIVE_DRIVE_ID : '/me/drive',

    // Common
    gmailLabel: p.GMAIL_LABEL,
    subjectRe: compileSubjectRegex_(p.SUBJECT_REGEX, p.SUBJECT_REGEX_FLAGS),
    processedLabel: p.PROCESSED_LABEL || 'Archived/Dropbox',
    maxThreads: parseInt(p.MAX_THREADS_PER_RUN || '40', 10),
    includeAttachments: (p.INCLUDE_ATTACHMENTS || 'true').toLowerCase() !== 'false',
    summaryEmail: (p.RUN_SUMMARY_EMAIL || '').trim()
  };
}

/**
 * Compile the optional subject filter into a RegExp (or null = match all).
 * Flags default to case-insensitive when SUBJECT_REGEX_FLAGS is unset, but an
 * explicit empty string means "no flags" (case-sensitive) — V8 has no inline
 * (?i) syntax, so flags are the only way to control this. The 'g' and 'y' flags
 * are stripped because they make RegExp.test() stateful across calls, which
 * would intermittently skip matching subjects.
 */
function compileSubjectRegex_(pattern, flags) {
  if (!pattern) return null;
  var raw = (flags == null) ? 'i' : flags;   // unset → 'i'; '' → no flags
  var safeFlags = raw.replace(/[^imsu]/g, '');
  try {
    return new RegExp(pattern, safeFlags);
  } catch (e) {
    throw new Error('Invalid SUBJECT_REGEX /' + pattern + '/' + safeFlags + ': ' + e.message);
  }
}

/** True when no subject filter is set, or the message subject matches it. */
function subjectMatches_(cfg, message) {
  if (!cfg.subjectRe) return true;
  return cfg.subjectRe.test(message.getSubject() || '');
}

/** Normalize STORAGE_PROVIDER into one of: "dropbox", "onedrive", "both". */
function normalizeProvider_(v) {
  var s = (v || 'dropbox').toString().trim().toLowerCase();
  if (s === 'both' || s === 'all') return 'both';
  if (s === 'onedrive' || s === 'm365' || s === 'sharepoint' || s === 'msgraph' || s === 'graph') {
    return 'onedrive';
  }
  return 'dropbox';
}

/* ===========================================================================
 * MAIN ENTRY POINT — this is the function the daily trigger calls.
 * ======================================================================== */
function archiveLabeledEmails() {
  var cfg = getConfig_();
  // Resolve each enabled storage target up front so a bad credential fails fast.
  var targets = buildTargets_(cfg);
  Logger.log('Archiving to: %s', targets.map(function (x) { return x.name; }).join(', '));

  var processedLabel = getOrCreateLabel_(cfg.processedLabel);

  // Only pick up threads that carry the source label but NOT the processed label.
  var query = 'label:' + toSearchLabel_(cfg.gmailLabel) +
              ' -label:' + toSearchLabel_(cfg.processedLabel);

  var threads = GmailApp.search(query, 0, cfg.maxThreads);
  Logger.log('Found %s thread(s) to archive for query: %s', threads.length, query);

  var archivedThreads = 0;
  var archivedFiles = 0;
  var skippedMessages = 0;
  var errors = [];

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    try {
      var messages = thread.getMessages();
      var matchedInThread = 0;
      for (var m = 0; m < messages.length; m++) {
        // Only archive messages whose subject matches SUBJECT_REGEX (if set).
        if (!subjectMatches_(cfg, messages[m])) { skippedMessages++; continue; }
        archivedFiles += archiveMessage_(messages[m], cfg, targets);
        matchedInThread++;
      }
      // Tag the thread once handled — including when nothing matched — so a run
      // isn't re-scanning the same non-matching threads forever (they'd otherwise
      // keep filling MAX_THREADS_PER_RUN and starve everything else).
      thread.addLabel(processedLabel);
      if (matchedInThread > 0) archivedThreads++;
    } catch (err) {
      // Leave the thread untagged so the next run retries it.
      Logger.log('ERROR archiving thread "%s": %s', safeSubject_(thread), err);
      errors.push({ subject: safeSubject_(thread), error: String(err) });
    }
  }

  Logger.log('Done. Archived %s file(s) across %s thread(s); %s message(s) skipped by filter. %s error(s).',
    archivedFiles, archivedThreads, skippedMessages, errors.length);

  var summary = {
    found: threads.length,
    threads: archivedThreads,
    files: archivedFiles,
    skipped: skippedMessages,
    errors: errors
  };
  maybeSendSummary_(cfg, summary);
  return summary;
}

/**
 * Build the list of storage targets to upload each file to. Each target owns
 * its own resolved access token and destination folder, and exposes a single
 * upload(relativePath, blob) method. Resolving tokens here makes a bad
 * credential fail the whole run immediately rather than mid-archive.
 */
function buildTargets_(cfg) {
  var targets = [];

  if (cfg.useDropbox) {
    var dropboxToken = getDropboxAccessToken_(cfg);
    targets.push({
      name: 'Dropbox',
      upload: function (relPath, blob) {
        uploadToDropbox_(dropboxToken, cfg.dropboxFolder + '/' + relPath, blob);
      }
    });
  }

  if (cfg.useOneDrive) {
    var graphToken = getGraphAccessToken_(cfg);
    targets.push({
      name: 'OneDrive',
      upload: function (relPath, blob) {
        uploadToOneDrive_(cfg, graphToken, cfg.onedriveFolder + '/' + relPath, blob);
      }
    });
  }

  if (!targets.length) {
    throw new Error('No storage target enabled. Set STORAGE_PROVIDER to "dropbox", "onedrive", or "both".');
  }
  return targets;
}

/** Upload one blob to every configured target. */
function uploadToAll_(targets, relPath, blob) {
  for (var i = 0; i < targets.length; i++) {
    targets[i].upload(relPath, blob);
  }
}

/** Human-readable destination label for logs / the summary email. */
function providerLabel_(cfg) {
  if (cfg.provider === 'both') return 'Dropbox + OneDrive';
  return cfg.useOneDrive ? 'OneDrive' : 'Dropbox';
}

/**
 * Email a short per-run digest when RUN_SUMMARY_EMAIL is configured. Never
 * throws — a failed notification must not fail the archive run itself.
 */
function maybeSendSummary_(cfg, summary) {
  if (!cfg.summaryEmail) return;
  // Skip the "nothing happened, no errors" case to avoid daily inbox noise.
  if (summary.found === 0 && summary.errors.length === 0) return;

  try {
    var dest = providerLabel_(cfg);
    var lines = [
      'Gmail → ' + dest + ' archive run complete.',
      '',
      'Threads found:    ' + summary.found,
      'Threads archived: ' + summary.threads,
      'Files uploaded:   ' + summary.files + ' (to ' + dest + ')',
      'Skipped (filter): ' + (summary.skipped || 0),
      'Errors:           ' + summary.errors.length
    ];
    if (summary.errors.length) {
      lines.push('', 'Failed threads (will retry next run):');
      summary.errors.forEach(function (e) {
        lines.push('  • ' + e.subject + ' — ' + e.error);
      });
    }
    var subject = 'Gmail→' + dest + ' archive: ' + summary.files + ' file(s), ' +
      summary.errors.length + ' error(s)';
    MailApp.sendEmail(cfg.summaryEmail, subject, lines.join('\n'));
  } catch (err) {
    Logger.log('Could not send run summary email: %s', err);
  }
}

/**
 * Archive a single message: body PDF + (optionally) attachments, to every
 * configured storage target. Returns the number of distinct files archived
 * (not multiplied by target count). Paths are relative to each target's own
 * destination folder, laid out as "<yyyy-MM>/<file>".
 */
function archiveMessage_(message, cfg, targets) {
  var uploaded = 0;
  var baseName = buildBaseName_(message);
  var sub = datePart_(message.getDate());  // e.g. "2026-07"

  // 1) The email itself as a PDF.
  var pdf = messageToPdf_(message, baseName);
  uploadToAll_(targets, sub + '/' + pdf.getName(), pdf);
  uploaded++;

  // 2) Real file attachments (inline images excluded).
  if (cfg.includeAttachments) {
    var attachments = message.getAttachments({
      includeInlineImages: false,
      includeAttachments: true
    });
    for (var i = 0; i < attachments.length; i++) {
      var att = attachments[i];
      var attName = baseName + '__att__' + sanitize_(att.getName());
      uploadToAll_(targets, sub + '/attachments/' + attName, att.copyBlob());
      uploaded++;
    }
  }

  return uploaded;
}

/* ===========================================================================
 * PDF RENDERING
 * ======================================================================== */
function messageToPdf_(message, baseName) {
  var subject = message.getSubject() || '(no subject)';
  var body = message.getBody() || message.getPlainBody() || '';

  var header =
    '<table style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:12px;margin-bottom:16px;border-bottom:2px solid #ccc;padding-bottom:8px;">' +
    row_('Subject', escapeHtml_(subject)) +
    row_('From', escapeHtml_(message.getFrom())) +
    row_('To', escapeHtml_(message.getTo())) +
    (message.getCc() ? row_('Cc', escapeHtml_(message.getCc())) : '') +
    row_('Date', escapeHtml_(message.getDate().toString())) +
    '</table>';

  var html =
    '<html><head><meta charset="utf-8"><base target="_blank"></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222;">' +
    header + '<div>' + body + '</div></body></html>';

  var pdf = Utilities.newBlob(html, 'text/html', baseName + '.html')
    .getAs('application/pdf');
  pdf.setName(baseName + '.pdf');
  return pdf;
}

function row_(label, value) {
  return '<tr><td style="padding:2px 8px 2px 0;font-weight:bold;white-space:nowrap;' +
    'vertical-align:top;color:#555;">' + label + ':</td><td style="padding:2px 0;">' +
    value + '</td></tr>';
}

/* ===========================================================================
 * DROPBOX
 * ======================================================================== */

// Chunk size for upload sessions. Also the ceiling for a single-request upload:
// anything larger is streamed in chunks. Kept well under Apps Script's ~50 MB
// UrlFetchApp payload limit so each request stays comfortably in bounds.
var DROPBOX_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Refresh tokens do not expire, so the daily trigger keeps working forever.
 */
function getDropboxAccessToken_(cfg) {
  var res = fetchWithRetry_('https://api.dropboxapi.com/oauth2/token', {
    method: 'post',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      client_id: cfg.appKey,
      client_secret: cfg.appSecret
    }
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) {
    throw new Error('Dropbox token refresh failed (' + code + '): ' + text);
  }
  return JSON.parse(text).access_token;
}

/**
 * Upload a blob to Dropbox. Small files go through the single-request
 * files/upload endpoint; anything larger than one chunk is streamed via an
 * upload session (start → append → finish) so oversized attachments don't
 * blow past Dropbox's 150 MB single-request cap or Apps Script's payload limit.
 * mode=add + autorename avoids clobbering if the same path already exists.
 */
function uploadToDropbox_(accessToken, dropboxPath, blob) {
  var bytes = blob.getBytes();
  var path = normalizeDropboxPath_(dropboxPath);
  if (bytes.length > DROPBOX_CHUNK_BYTES) {
    uploadLargeToDropbox_(accessToken, path, bytes);
  } else {
    uploadSmallToDropbox_(accessToken, path, bytes);
  }
}

/** Single-request upload for files that fit in one chunk. */
function uploadSmallToDropbox_(accessToken, path, bytes) {
  var apiArg = {
    path: path,
    mode: 'add',
    autorename: true,
    mute: true,
    strict_conflict: false
  };

  var res = fetchWithRetry_('https://content.dropboxapi.com/2/files/upload', {
    method: 'post',
    contentType: 'application/octet-stream',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Dropbox-API-Arg': toDropboxApiArg_(apiArg)
    },
    payload: bytes
  });

  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Dropbox upload failed (' + code + ') for ' + path +
      ': ' + res.getContentText());
  }
}

/** Chunked upload session for files larger than a single chunk. */
function uploadLargeToDropbox_(accessToken, path, bytes) {
  var total = bytes.length;

  // 1) start — send the first chunk, keep the session open.
  var firstEnd = Math.min(DROPBOX_CHUNK_BYTES, total);
  var startRes = fetchWithRetry_('https://content.dropboxapi.com/2/files/upload_session/start', {
    method: 'post',
    contentType: 'application/octet-stream',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Dropbox-API-Arg': toDropboxApiArg_({ close: false })
    },
    payload: bytes.slice(0, firstEnd)
  });
  if (startRes.getResponseCode() !== 200) {
    throw new Error('Dropbox upload_session/start failed (' + startRes.getResponseCode() +
      ') for ' + path + ': ' + startRes.getContentText());
  }
  var sessionId = JSON.parse(startRes.getContentText()).session_id;
  var offset = firstEnd;

  // 2) append — stream the middle chunks.
  while (total - offset > DROPBOX_CHUNK_BYTES) {
    var end = offset + DROPBOX_CHUNK_BYTES;
    var appendRes = fetchWithRetry_('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
      method: 'post',
      contentType: 'application/octet-stream',
      muteHttpExceptions: true,
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Dropbox-API-Arg': toDropboxApiArg_({
          cursor: { session_id: sessionId, offset: offset },
          close: false
        })
      },
      payload: bytes.slice(offset, end)
    });
    if (appendRes.getResponseCode() !== 200) {
      throw new Error('Dropbox upload_session/append failed (' + appendRes.getResponseCode() +
        ') for ' + path + ': ' + appendRes.getContentText());
    }
    offset = end;
  }

  // 3) finish — send the last chunk and commit to the final path.
  var finishRes = fetchWithRetry_('https://content.dropboxapi.com/2/files/upload_session/finish', {
    method: 'post',
    contentType: 'application/octet-stream',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Dropbox-API-Arg': toDropboxApiArg_({
        cursor: { session_id: sessionId, offset: offset },
        commit: { path: path, mode: 'add', autorename: true, mute: true, strict_conflict: false }
      })
    },
    payload: bytes.slice(offset, total)
  });
  if (finishRes.getResponseCode() !== 200) {
    throw new Error('Dropbox upload_session/finish failed (' + finishRes.getResponseCode() +
      ') for ' + path + ': ' + finishRes.getContentText());
  }
}

/**
 * UrlFetchApp wrapper that retries transient Dropbox failures — HTTP 429
 * (rate limited) and 5xx (server) — with exponential backoff plus jitter,
 * honoring the Retry-After header when present. Returns the final response;
 * the caller inspects the status code for non-retryable errors.
 */
function fetchWithRetry_(url, params) {
  var MAX_ATTEMPTS = 5;
  var res;
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = UrlFetchApp.fetch(url, params);
    var code = res.getResponseCode();
    if (code !== 429 && code < 500) return res;   // success or non-retryable
    if (attempt === MAX_ATTEMPTS) return res;      // out of retries; let caller handle
    var waitMs = retryDelayMs_(res, attempt);
    Logger.log('Transient HTTP %s from %s — retry %s/%s in %s ms',
      code, url, attempt, MAX_ATTEMPTS, waitMs);
    Utilities.sleep(waitMs);
  }
  return res;
}

/**
 * Backoff delay for a retry: prefer the server's Retry-After header, else
 * exponential (1s, 2s, 4s, 8s…) capped at 32s, with up to 1s of jitter.
 */
function retryDelayMs_(res, attempt) {
  var retryAfter = headerValue_(res, 'Retry-After');
  if (retryAfter) {
    var secs = parseInt(retryAfter, 10);
    if (!isNaN(secs) && secs >= 0) return (secs * 1000) + Math.floor(Math.random() * 1000);
  }
  var base = Math.min(1000 * Math.pow(2, attempt - 1), 32000);
  return base + Math.floor(Math.random() * 1000);
}

/** Case-insensitive lookup into UrlFetchApp response headers. */
function headerValue_(res, name) {
  var headers = res.getHeaders() || {};
  var target = name.toLowerCase();
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === target) {
      var v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

/**
 * The Dropbox-API-Arg HTTP header must be ASCII-only. Serialize to JSON and
 * escape every non-ASCII code point as \\uXXXX so headers with unicode
 * filenames (accents, emoji, CJK) are accepted by UrlFetchApp / Dropbox.
 */
function toDropboxApiArg_(obj) {
  var json = JSON.stringify(obj);
  var out = '';
  for (var i = 0; i < json.length; i++) {
    var code = json.charCodeAt(i);
    if (code > 126) {
      out += '\\u' + ('0000' + code.toString(16)).slice(-4);
    } else {
      out += json.charAt(i);
    }
  }
  return out;
}

function normalizeDropboxPath_(path) {
  // Collapse duplicate slashes and ensure a single leading slash.
  return ('/' + path).replace(/\/{2,}/g, '/');
}

/* ===========================================================================
 * ONEDRIVE / MICROSOFT 365 (Microsoft Graph)
 * ======================================================================== */

// Files at or below this size use a single PUT; larger ones use an upload
// session. OneDrive requires session chunks to be multiples of 320 KiB — 5 MiB
// (= 16 × 320 KiB) satisfies that and stays under Apps Script's payload limit.
var ONEDRIVE_SIMPLE_MAX_BYTES = 4 * 1024 * 1024;  // 4 MiB
var ONEDRIVE_CHUNK_BYTES = 5 * 1024 * 1024;       // 5 MiB (multiple of 320 KiB)

/**
 * Exchange the Microsoft Graph refresh token for a short-lived access token.
 * Azure AD rotates refresh tokens, so when a new one comes back we persist it
 * to Script Properties — otherwise the daily job would eventually stop working.
 * Public (native) app registrations refresh without a secret; confidential
 * (web) ones include ONEDRIVE_CLIENT_SECRET.
 */
function getGraphAccessToken_(cfg) {
  var payload = {
    grant_type: 'refresh_token',
    refresh_token: cfg.onedriveRefreshToken,
    client_id: cfg.onedriveClientId,
    scope: cfg.onedriveScope
  };
  if (cfg.onedriveClientSecret) payload.client_secret = cfg.onedriveClientSecret;

  var res = fetchWithRetry_(
    'https://login.microsoftonline.com/' + encodeURIComponent(cfg.onedriveTenant) + '/oauth2/v2.0/token', {
      method: 'post',
      muteHttpExceptions: true,
      payload: payload
    });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) {
    throw new Error('OneDrive token refresh failed (' + code + '): ' + text);
  }
  var json = JSON.parse(text);
  if (json.refresh_token && json.refresh_token !== cfg.onedriveRefreshToken) {
    PropertiesService.getScriptProperties().setProperty('ONEDRIVE_REFRESH_TOKEN', json.refresh_token);
    cfg.onedriveRefreshToken = json.refresh_token;
  }
  return json.access_token;
}

/**
 * Upload a blob to OneDrive/SharePoint. Small files use a single PUT to
 * .../root:/<path>:/content; larger files stream through an upload session in
 * 5 MiB chunks. conflictBehavior=rename avoids clobbering an existing file.
 */
function uploadToOneDrive_(cfg, accessToken, path, blob) {
  var bytes = blob.getBytes();
  if (bytes.length > ONEDRIVE_SIMPLE_MAX_BYTES) {
    uploadLargeToOneDrive_(cfg, accessToken, path, bytes);
  } else {
    uploadSmallToOneDrive_(cfg, accessToken, path, bytes);
  }
}

/** Single-request PUT for files that fit under the simple-upload limit. */
function uploadSmallToOneDrive_(cfg, accessToken, path, bytes) {
  var url = graphItemUrl_(cfg, path) + ':/content?@microsoft.graph.conflictBehavior=rename';
  var res = fetchWithRetry_(url, {
    method: 'put',
    contentType: 'application/octet-stream',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: bytes
  });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('OneDrive upload failed (' + code + ') for ' + path +
      ': ' + res.getContentText());
  }
}

/** Chunked upload session for files larger than the simple-upload limit. */
function uploadLargeToOneDrive_(cfg, accessToken, path, bytes) {
  // 1) Create the session (authenticated).
  var sessRes = fetchWithRetry_(graphItemUrl_(cfg, path) + ':/createUploadSession', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } })
  });
  if (sessRes.getResponseCode() >= 300) {
    throw new Error('OneDrive createUploadSession failed (' + sessRes.getResponseCode() +
      ') for ' + path + ': ' + sessRes.getContentText());
  }
  var uploadUrl = JSON.parse(sessRes.getContentText()).uploadUrl;

  // 2) PUT each chunk to the pre-authenticated session URL (no auth header).
  var total = bytes.length;
  var offset = 0;
  while (offset < total) {
    var end = Math.min(offset + ONEDRIVE_CHUNK_BYTES, total);
    var res = fetchWithRetry_(uploadUrl, {
      method: 'put',
      contentType: 'application/octet-stream',
      muteHttpExceptions: true,
      headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + total },
      payload: bytes.slice(offset, end)
    });
    var code = res.getResponseCode();
    // 202 = more chunks expected; 200/201 = final chunk accepted & committed.
    if (code !== 202 && code !== 200 && code !== 201) {
      throw new Error('OneDrive chunk upload failed (' + code + ') at offset ' + offset +
        ' for ' + path + ': ' + res.getContentText());
    }
    offset = end;
  }
}

/** Graph item URL up to (and including) the addressed path, e.g.
 *  https://graph.microsoft.com/v1.0/me/drive/root:/Gmail%20Archive/2026-07/x.pdf
 *  Callers append ":/content" or ":/createUploadSession". */
function graphItemUrl_(cfg, path) {
  return 'https://graph.microsoft.com/v1.0' + cfg.onedriveDrivePrefix +
         '/root:' + encodeGraphPath_(path);
}

/** Percent-encode each path segment while keeping the slash separators. */
function encodeGraphPath_(path) {
  var clean = ('/' + path).replace(/\/{2,}/g, '/');
  return clean.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

/* ===========================================================================
 * NAMING / SANITIZING HELPERS
 * ======================================================================== */
function buildBaseName_(message) {
  var d = message.getDate();
  var stamp = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  var subject = sanitize_(message.getSubject() || 'no-subject');
  var shortId = message.getId().slice(-8);
  // Keep filenames comfortably short for Dropbox.
  return (stamp + '_' + subject).slice(0, 120) + '_' + shortId;
}

function datePart_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM');
}

function sanitize_(name) {
  return String(name)
    .replace(/[\/\\:*?"<>|]/g, '_')   // characters Dropbox/OS dislike
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');             // no trailing dots
}

function safeSubject_(thread) {
  try { return thread.getFirstMessageSubject(); } catch (e) { return '(unknown)'; }
}

/** Gmail search label operator: quote names that contain spaces. */
function toSearchLabel_(name) {
  return /\s/.test(name) ? '"' + name + '"' : name;
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/* ===========================================================================
 * SETUP / MAINTENANCE — run these once by hand from the editor.
 * ======================================================================== */

/**
 * Convenience one-shot config writer. Fill in the blanks, run once, then
 * DELETE the values from this function (they are now safely in Script
 * Properties). Alternatively set them via Project Settings ▸ Script Properties.
 */
function initConfig() {
  PropertiesService.getScriptProperties().setProperties({
    GMAIL_LABEL: 'Archive/ToDropbox',
    STORAGE_PROVIDER: 'dropbox',   // 'dropbox' | 'onedrive' | 'both'
    ARCHIVE_FOLDER: '/Gmail Archive',  // one destination folder for every provider
    SUBJECT_REGEX: '',             // e.g. '^(Invoice|Receipt)\\b' — blank archives everything
    SUBJECT_REGEX_FLAGS: 'i',      // regex flags (g/y ignored)
    PROCESSED_LABEL: 'Archived/Dropbox',
    MAX_THREADS_PER_RUN: '40',
    INCLUDE_ATTACHMENTS: 'true',
    RUN_SUMMARY_EMAIL: '',         // e.g. 'you@example.com' to get a per-run digest; blank = off

    // Dropbox (needed when STORAGE_PROVIDER is 'dropbox' or 'both')
    DROPBOX_APP_KEY: '',
    DROPBOX_APP_SECRET: '',
    DROPBOX_REFRESH_TOKEN: '',
    // DROPBOX_FOLDER: '',         // optional per-provider override of ARCHIVE_FOLDER

    // OneDrive / M365 (needed when STORAGE_PROVIDER is 'onedrive' or 'both')
    ONEDRIVE_CLIENT_ID: '',
    ONEDRIVE_CLIENT_SECRET: '',     // only for confidential (web) app registrations
    ONEDRIVE_REFRESH_TOKEN: '',
    ONEDRIVE_TENANT: 'common'
    // ONEDRIVE_FOLDER: '',        // optional per-provider override of ARCHIVE_FOLDER
  }, false); // false = merge, don't wipe other properties
  Logger.log('Config written. Remember to clear secrets out of initConfig().');
}

/** Create the daily trigger. Run once. Safe to re-run (it de-dupes first). */
function setupDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('archiveLabeledEmails')
    .timeBased()
    .everyDays(1)
    .atHour(2)          // ~2 AM in the script's timezone
    .create();
  Logger.log('Daily trigger installed (runs ~2 AM script-timezone).');
}

/** Remove all triggers for this project. */
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    ScriptApp.deleteTrigger(tr);
  });
  Logger.log('All triggers removed.');
}

/** Verify Dropbox credentials without touching Gmail. */
function testDropboxConnection() {
  var cfg = getConfig_();
  if (!cfg.useDropbox) {
    Logger.log('Dropbox is not enabled (STORAGE_PROVIDER=%s).', cfg.provider);
    return;
  }
  var token = getDropboxAccessToken_(cfg);
  var res = UrlFetchApp.fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }
  });
  Logger.log('Dropbox account check (%s): %s', res.getResponseCode(), res.getContentText());
}

/** Verify OneDrive/M365 credentials without touching Gmail. */
function testOneDriveConnection() {
  var cfg = getConfig_();
  if (!cfg.useOneDrive) {
    Logger.log('OneDrive is not enabled (STORAGE_PROVIDER=%s).', cfg.provider);
    return;
  }
  var token = getGraphAccessToken_(cfg);
  var res = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0' + cfg.onedriveDrivePrefix, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }
  });
  Logger.log('OneDrive drive check (%s): %s', res.getResponseCode(), res.getContentText());
}

/** Verify every enabled storage target in one call. */
function testConnections() {
  testDropboxConnection();
  testOneDriveConnection();
}

/** Dry run: archive the first subject-matching message so you can eyeball the
 *  result. Scans a handful of threads to find one that passes SUBJECT_REGEX. */
function testArchiveOne() {
  var cfg = getConfig_();
  var targets = buildTargets_(cfg);
  var threads = GmailApp.search('label:' + toSearchLabel_(cfg.gmailLabel) +
    ' -label:' + toSearchLabel_(cfg.processedLabel), 0, 10);
  if (!threads.length) { Logger.log('No unarchived threads found for that label.'); return; }

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!subjectMatches_(cfg, messages[m])) continue;
      var count = archiveMessage_(messages[m], cfg, targets);
      Logger.log('Archived %s file(s) from message "%s" to %s (thread NOT marked processed).',
        count, messages[m].getSubject(), providerLabel_(cfg));
      return;
    }
  }
  Logger.log('No message in the first %s thread(s) matched SUBJECT_REGEX.', threads.length);
}
