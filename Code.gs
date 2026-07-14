/**
 * Gmail → Dropbox PDF Archiver
 * ---------------------------------------------------------------------------
 * Archives Gmail messages that carry a specific label by:
 *   1. Rendering each message (headers + body) to a PDF.
 *   2. Uploading that PDF — and any real file attachments — to Dropbox.
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
 *   DROPBOX_APP_KEY        Dropbox app key       (required)
 *   DROPBOX_APP_SECRET     Dropbox app secret    (required)
 *   DROPBOX_REFRESH_TOKEN  Dropbox refresh token (required)
 *   GMAIL_LABEL            Gmail label to archive, e.g. "Archive/ToDropbox" (required)
 *   DROPBOX_FOLDER         Dropbox destination folder, e.g. "/Gmail Archive" (default "/Gmail Archive")
 *   PROCESSED_LABEL        Label applied after archiving      (default "Archived/Dropbox")
 *   MAX_THREADS_PER_RUN    Safety cap per execution           (default "40")
 *   INCLUDE_ATTACHMENTS    "true"/"false"                     (default "true")
 *   RUN_SUMMARY_EMAIL      Address to email a per-run digest; blank = off (default "")
 */
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var p = props.getProperties();

  var required = ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'GMAIL_LABEL'];
  var missing = required.filter(function (k) { return !p[k]; });
  if (missing.length) {
    throw new Error('Missing Script Properties: ' + missing.join(', ') +
      '. Run initConfig() or set them under Project Settings ▸ Script Properties.');
  }

  return {
    appKey: p.DROPBOX_APP_KEY,
    appSecret: p.DROPBOX_APP_SECRET,
    refreshToken: p.DROPBOX_REFRESH_TOKEN,
    gmailLabel: p.GMAIL_LABEL,
    dropboxFolder: (p.DROPBOX_FOLDER || '/Gmail Archive').replace(/\/+$/, ''),
    processedLabel: p.PROCESSED_LABEL || 'Archived/Dropbox',
    maxThreads: parseInt(p.MAX_THREADS_PER_RUN || '40', 10),
    includeAttachments: (p.INCLUDE_ATTACHMENTS || 'true').toLowerCase() !== 'false',
    summaryEmail: (p.RUN_SUMMARY_EMAIL || '').trim()
  };
}

/* ===========================================================================
 * MAIN ENTRY POINT — this is the function the daily trigger calls.
 * ======================================================================== */
function archiveLabeledEmails() {
  var cfg = getConfig_();
  var accessToken = getDropboxAccessToken_(cfg);

  var processedLabel = getOrCreateLabel_(cfg.processedLabel);

  // Only pick up threads that carry the source label but NOT the processed label.
  var query = 'label:' + toSearchLabel_(cfg.gmailLabel) +
              ' -label:' + toSearchLabel_(cfg.processedLabel);

  var threads = GmailApp.search(query, 0, cfg.maxThreads);
  Logger.log('Found %s thread(s) to archive for query: %s', threads.length, query);

  var archivedThreads = 0;
  var archivedFiles = 0;
  var errors = [];

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    try {
      var messages = thread.getMessages();
      for (var m = 0; m < messages.length; m++) {
        archivedFiles += archiveMessage_(messages[m], cfg, accessToken);
      }
      // Tag the thread only after every message uploaded successfully.
      thread.addLabel(processedLabel);
      archivedThreads++;
    } catch (err) {
      // Leave the thread untagged so the next run retries it.
      Logger.log('ERROR archiving thread "%s": %s', safeSubject_(thread), err);
      errors.push({ subject: safeSubject_(thread), error: String(err) });
    }
  }

  Logger.log('Done. Archived %s file(s) across %s thread(s). %s error(s).',
    archivedFiles, archivedThreads, errors.length);

  var summary = {
    found: threads.length,
    threads: archivedThreads,
    files: archivedFiles,
    errors: errors
  };
  maybeSendSummary_(cfg, summary);
  return summary;
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
    var lines = [
      'Gmail → Dropbox archive run complete.',
      '',
      'Threads found:    ' + summary.found,
      'Threads archived: ' + summary.threads,
      'Files uploaded:   ' + summary.files,
      'Errors:           ' + summary.errors.length
    ];
    if (summary.errors.length) {
      lines.push('', 'Failed threads (will retry next run):');
      summary.errors.forEach(function (e) {
        lines.push('  • ' + e.subject + ' — ' + e.error);
      });
    }
    var subject = 'Gmail→Dropbox archive: ' + summary.files + ' file(s), ' +
      summary.errors.length + ' error(s)';
    MailApp.sendEmail(cfg.summaryEmail, subject, lines.join('\n'));
  } catch (err) {
    Logger.log('Could not send run summary email: %s', err);
  }
}

/**
 * Archive a single message: body PDF + (optionally) attachments.
 * Returns the number of files uploaded.
 */
function archiveMessage_(message, cfg, accessToken) {
  var uploaded = 0;
  var baseName = buildBaseName_(message);
  var folder = cfg.dropboxFolder + '/' + datePart_(message.getDate());

  // 1) The email itself as a PDF.
  var pdf = messageToPdf_(message, baseName);
  uploadToDropbox_(accessToken, folder + '/' + pdf.getName(), pdf);
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
      uploadToDropbox_(accessToken, folder + '/attachments/' + attName, att.copyBlob());
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
    DROPBOX_APP_KEY: '',
    DROPBOX_APP_SECRET: '',
    DROPBOX_REFRESH_TOKEN: '',
    GMAIL_LABEL: 'Archive/ToDropbox',
    DROPBOX_FOLDER: '/Gmail Archive',
    PROCESSED_LABEL: 'Archived/Dropbox',
    MAX_THREADS_PER_RUN: '40',
    INCLUDE_ATTACHMENTS: 'true',
    RUN_SUMMARY_EMAIL: ''   // e.g. 'you@example.com' to get a per-run digest; blank = off
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
  var token = getDropboxAccessToken_(cfg);
  var res = UrlFetchApp.fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }
  });
  Logger.log('Dropbox account check (%s): %s', res.getResponseCode(), res.getContentText());
}

/** Dry run: archive at most one message so you can eyeball the result. */
function testArchiveOne() {
  var cfg = getConfig_();
  var token = getDropboxAccessToken_(cfg);
  var threads = GmailApp.search('label:' + toSearchLabel_(cfg.gmailLabel) +
    ' -label:' + toSearchLabel_(cfg.processedLabel), 0, 1);
  if (!threads.length) { Logger.log('No unarchived threads found for that label.'); return; }
  var count = archiveMessage_(threads[0].getMessages()[0], cfg, token);
  Logger.log('Uploaded %s file(s) from one message (thread NOT marked processed).', count);
}
