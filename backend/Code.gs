/**
 * Max HQ -- data backend (Google Apps Script Web App)
 * ----------------------------------------------------------
 * AUTHENTICATED. Nothing is readable anonymously any more.
 *
 * Three ways to authenticate, all over POST (text/plain, so no CORS preflight):
 *   1. idToken  -- a Google Identity Services ID token from the dashboard.
 *                 Verified against Google, must match OAUTH_CLIENT_ID and an
 *                 address in ALLOWED_EMAILS.            -> scope: write
 *   2. key = SERVICE_KEY -- the scheduled tasks (headless). -> scope: write
 *   3. key = WIDGET_KEY  -- the lock-screen widget.         -> scope: summary
 *                 Can ONLY call action=summary, which returns counts, never
 *                 to-do text, notes or calendar labels.
 *
 * Secrets live in Script Properties (Project Settings > Script properties),
 * NOT in this file -- this repo is public. Required properties:
 *   OAUTH_CLIENT_ID, SERVICE_KEY, WIDGET_KEY
 *
 * POST body: {action, idToken|key, ...}
 *   action=state   -> {ok, state}
 *   action=all     -> {ok, state, events}
 *   action=cal     -> {ok, events}
 *   action=save    -> {ok, n}        body.items = [{k,v,t}]
 *   action=mail    -> {ok, sent}     body.to/subject/body
 *   action=summary -> {ok, ...counts}   (widget scope allowed)
 * GET ?action=ping -> {ok, pong}  -- the only unauthenticated route.
 *
 * TO INSTALL: paste over Code.gs, save, run authorizeAll() once to clear the new
 * permission, then Deploy > Manage deployments > (pencil) > Version: New version
 * > Deploy. Adding token verification introduces the external_request scope, so
 * that first run is what triggers the re-authorisation prompt.
 */

var SHEET_TAB = 'state';
var PROP_ID   = 'AGENDA_SHEET_ID';
var TZ        = 'America/Detroit';
var ALLOWED_EMAILS = ['max@prominato.com', 'msteinberg115@gmail.com'];

/** -- RUN THIS FIRST, ONCE, FROM THE EDITOR ----------------------------------
 *  Verifying ID tokens calls Google over the network, which needs a brand-new
 *  permission (script.external_request). Google only offers the consent screen
 *  when a run throws the permission error UNCAUGHT -- a try/catch silently
 *  suppresses the prompt (learned the hard way with MailApp). So: no try/catch
 *  here, and it sits first in the file so the editor's Run button selects it
 *  by default. Run it, click through the authorisation, then deploy.
 *  --------------------------------------------------------------------------*/
function authorizeAll() {
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=probe',
                              { muteHttpExceptions: true });
  var props = PropertiesService.getScriptProperties();
  return 'external_request OK (tokeninfo said ' + res.getResponseCode() + '). ' +
         'OAUTH_CLIENT_ID ' + (props.getProperty('OAUTH_CLIENT_ID') ? 'set' : 'MISSING') + ', ' +
         'SERVICE_KEY ' + (props.getProperty('SERVICE_KEY') ? 'set' : 'MISSING') + ', ' +
         'WIDGET_KEY ' + (props.getProperty('WIDGET_KEY') ? 'set' : 'MISSING') + '.';
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

/** Constant-time-ish compare so a wrong key can't be probed byte by byte. */
function sameSecret_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

/** Verify a Google ID token: real signature check via Google, then audience,
 *  expiry and address. Returns an email on success, null otherwise. */
function verifyIdToken_(token) {
  if (!token) return null;
  var clientId = prop_('OAUTH_CLIENT_ID');
  if (!clientId) return null;
  try {
    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var t = JSON.parse(res.getContentText());
    if (t.aud !== clientId) return null;                       // token minted for another app
    if (String(t.email_verified) !== 'true') return null;
    if (Number(t.exp) * 1000 < Date.now()) return null;        // expired
    var email = String(t.email || '').toLowerCase();
    if (ALLOWED_EMAILS.indexOf(email) < 0) return null;        // not you
    return email;
  } catch (err) {
    // Never throw from here -- but do leave a trail in Executions, otherwise a
    // missing external_request scope looks identical to a bad token.
    console.error('verifyIdToken_ failed: ' + err);
    return null;
  }
}

/** -> {ok, scope, who} */
function authorize_(body) {
  var svc = prop_('SERVICE_KEY'), wid = prop_('WIDGET_KEY');
  if (body.key && svc && sameSecret_(body.key, svc)) return { ok: true, scope: 'write', who: 'service' };
  if (body.key && wid && sameSecret_(body.key, wid)) return { ok: true, scope: 'summary', who: 'widget' };
  var email = verifyIdToken_(body.idToken);
  if (email) return { ok: true, scope: 'write', who: email };
  return { ok: false };
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'ping') return json_({ ok: true, pong: Date.now() });
  return json_({ ok: false, error: 'unauthorized', hint: 'Max HQ now requires sign-in; use POST with idToken or key.' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var auth = authorize_(body);
    if (!auth.ok) return json_({ ok: false, error: 'unauthorized' });

    var action = body.action || (body.items ? 'save' : 'all');

    if (action === 'summary') return json_(summary_());          // widget-safe
    if (auth.scope !== 'write') return json_({ ok: false, error: 'forbidden' });

    if (action === 'state') return json_({ ok: true, state: liveState_() });
    if (action === 'cal')   return json_({ ok: true, events: calEvents_() });
    if (action === 'save')  return json_({ ok: true, n: saveBatch_(body.items || []) });
    if (action === 'mail')  return json_(sendMail_(body));
    if (action === 'undo')  return json_({ ok: true, undo: undoState_() });   // the __prev snapshots
    return json_({ ok: true, state: liveState_(), events: calEvents_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Counts only -- deliberately no to-do text, note bodies or event titles, so a
 *  leaked widget key exposes progress numbers and nothing personal. */
function summary_() {
  var st = loadState_(), today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  function j(k, f) { try { return st[k] ? JSON.parse(st[k].v) : f; } catch (e) { return f; } }
  var L = j('cc_lists', {}), ch = j('cc_challenge', { start: today, checks: {} });
  var dayIdx = 0;
  if (ch.start) dayIdx = Math.round((new Date(today + 'T00:00:00') - new Date(ch.start + 'T00:00:00')) / 86400000);
  var checks = ch.checks || {}, CH = 8, todayDone = 0;
  for (var i = 0; i < CH; i++) if (checks[i + '::' + dayIdx]) todayDone++;
  var total = Object.keys(checks).length;
  var possible = Math.max(1, (Math.min(Math.max(dayIdx, 0), 20) + 1) * CH);
  var primary = 0, urgent = 0;
  ['todo', 'work', 'house', 'routine'].forEach(function (b) {
    (L[b] || []).forEach(function (it) {
      if (it.done) return;
      if (it.pri !== 'secondary') primary++;
      if (it.urgent) urgent++;
    });
  });
  var dcAll = (L.dconst || []).length || 13;
  var dcT = j('cc_dc_state', {})[today] || {}, dcDone = 0;
  Object.keys(dcT).forEach(function (k) { if (dcT[k]) dcDone++; });
  var water = 0;
  for (var n = 0; n < 4; n++) if (st['water::' + today + '::' + n] && st['water::' + today + '::' + n].v === '1') water++;
  return { ok: true, day: Math.min(Math.max(dayIdx, 0) + 1, 21), todayDone: todayDone, items: CH,
           pct: Math.round(total / possible * 100), primary: primary, urgent: urgent,
           dcDone: dcDone, dcAll: dcAll, water: water };
}

/** Send a real email FROM this account. Only to Max's own addresses -- this web app
 *  is "anyone with the link", so the allow-list stops it being used as a relay. */
/** RUN THIS ONCE from the editor (Run > authorizeMail) to grant the send-mail scope.
 *  MailApp is a NEW permission -- until it's approved, sendMail_ throws and no mail goes out.
 *  Underscore-suffixed helpers are hidden from the Run menu, hence this plain-named wrapper. */
function authorizeMail() {
  MailApp.sendEmail({
    to: 'max@prominato.com',
    subject: '\u2705 Max HQ can now email you',
    body: 'Mail sending is authorized. Your scheduled tasks can now deliver real email to this inbox instead of leaving drafts.\n\nmaxhq.netlify.app',
    name: 'Max HQ'
  });
  saveBatch_([{ k: 'cc_last_mail', v: JSON.stringify({ to: 'max@prominato.com', subject: '\u2705 Max HQ can now email you', at: Date.now() }), t: Date.now() }]);
  return 'sent; quota left: ' + MailApp.getRemainingDailyQuota();
}

var MAIL_ALLOW = ['max@prominato.com', 'msteinberg115@gmail.com'];
function sendMail_(b) {
  var to = String(b.to || '').trim().toLowerCase();
  if (MAIL_ALLOW.indexOf(to) < 0) return { ok: false, error: 'recipient not allowed' };
  var subj = String(b.subject || '(no subject)').slice(0, 250);
  var text = String(b.body || '');
  if (!text) return { ok: false, error: 'empty body' };
  MailApp.sendEmail({ to: to, subject: subj, body: text, name: 'Max HQ' });
  // Record the send in state. POST responses are unreadable through Apps Script's
  // redirect, so callers confirm success by GETting ?action=state and checking this.
  try {
    saveBatch_([{ k: 'cc_last_mail', v: JSON.stringify({ to: to, subject: subj, at: Date.now() }), t: Date.now() }]);
  } catch (e) {}
  return { ok: true, sent: to, quotaLeft: MailApp.getRemainingDailyQuota() };
}

/** Same backing spreadsheet as before (created on first use). */
function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_ID);
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Agenda Book \u2014 Data');
    props.setProperty(PROP_ID, ss.getId());
  }
  var sh = ss.getSheetByName(SHEET_TAB);
  if (!sh) {
    sh = ss.insertSheet(SHEET_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['key', 'value', 'ts']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** State as the app should see it: the undo snapshots are for recovery, not for
 *  syncing down onto every device. Ask for them explicitly with action=undo. */
function liveState_() {
  var all = loadState_(), out = {};
  for (var k in all) if (k.slice(-6) !== '__prev') out[k] = all[k];
  return out;
}
function undoState_() {
  var all = loadState_(), out = {};
  for (var k in all) if (k.slice(-6) === '__prev') out[k] = all[k];
  return out;
}

function loadState_() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < vals.length; i++) {
    var k = vals[i][0];
    if (k === '' || k === null) continue;
    out[k] = { v: String(vals[i][1]), t: Number(vals[i][2]) || 0 };
  }
  return out;
}

/** How many list items a cc_lists blob holds, or -1 if it will not parse. */
function listCount_(s) {
  try {
    var o = JSON.parse(s || '{}'), n = 0;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] && o[k].length !== undefined) n += o[k].length;
    return n;
  } catch (e) { return -1; }
}

/** Upsert [{k,v,t}] -- newer timestamp wins; locked against concurrent devices.
 *  Precious keys also get a server-side undo: whatever is about to be replaced is
 *  copied to <key>__prev first. On 2026-08-18 a phone running a cached old build
 *  published seed-shaped lists over a month of real ones, and the only surviving copy
 *  happened to be in a laptop tab that had not refreshed yet. A client-side guard was
 *  the wrong answer to that - it refused legitimate deletions and resurrected them.
 *  One previous copy, kept where the data actually lives, is the right one. Nothing is
 *  ever refused here: the newest write still wins, it is just recoverable. */
var UNDO_KEYS = { cc_lists: 1, cc_gcal: 1, cc_challenge: 1 };
function saveBatch_(items) {
  if (!items.length) return 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_();
    var last = sh.getLastRow();
    var index = {};
    if (last >= 2) {
      var data = sh.getRange(2, 1, last - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        index[data[i][0]] = { row: i + 2, t: Number(data[i][2]) || 0, v: String(data[i][1]) };
      }
    }
    // Snapshot pass first, so an undo copy exists before anything is overwritten.
    for (var u = 0; u < items.length; u++) {
      var it0 = items[u];
      if (!it0 || typeof it0.k !== 'string' || !UNDO_KEYS[it0.k]) continue;
      var cur = index[it0.k];
      if (!cur || cur.v === it0.v || it0.t < cur.t) continue;
      if (it0.k === 'cc_lists') {
        var before = listCount_(cur.v), after = listCount_(it0.v);
        if (before > 4 && after >= 0 && after < before * 0.7) {
          console.warn('cc_lists shrinking ' + before + ' -> ' + after + ' items; previous copy kept in cc_lists__prev');
        }
      }
      var pk = it0.k + '__prev', hitU = index[pk];
      if (hitU && hitU.row > 0) { sh.getRange(hitU.row, 2, 1, 2).setValues([[cur.v, cur.t || 1]]); hitU.t = cur.t || 1; hitU.v = cur.v; }
      else { sh.appendRow([pk, cur.v, cur.t || 1]); index[pk] = { row: sh.getLastRow(), t: cur.t || 1, v: cur.v }; }
    }
    var appends = [], n = 0;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (!it || typeof it.k !== 'string') continue;
      var hit = index[it.k];
      if (hit && hit.row > 0) {
        if (it.t >= hit.t) { sh.getRange(hit.row, 2, 1, 2).setValues([[it.v, it.t]]); hit.t = it.t; n++; }
      } else if (!hit) {
        appends.push([it.k, it.v, it.t]);
        index[it.k] = { row: -1, t: it.t };
        n++;
      }
    }
    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, 3).setValues(appends);
    }
    return n;
  } finally {
    lock.releaseLock();
  }
}

/** Next 90 days of events -- read-only, declined dropped. Reads BOTH calendars:
 *    * max@prominato.com   -> cal:'prominato' (work color) -- where Mom & Dad, trips, golf live
 *    * msteinberg115@gmail -> cal:'personal'  (personal color) -- Koloff, tournaments
 *  This Web App runs as msteinberg115, so the Prominato calendar must be SHARED to it:
 *  Google Calendar > hover "max@prominato.com" under My/Other calendars > : Settings and
 *  sharing > Share with specific people > add msteinberg115@gmail.com > "See all event
 *  details". Then redeploy: Deploy > Manage deployments > edit > Version: New version > Deploy. */
var WORK_CAL_ID = 'max@prominato.com';
var PERSONAL_CAL_ID = 'msteinberg115@gmail.com';
function calEvents_() {
  var now = new Date();
  var end = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
  var out = [];
  var seen = {}, sources = [];
  function addCal(getter, tag) {
    try { var c = getter(); if (c && !seen[c.getId()]) { sources.push({ cal: c, tag: tag }); seen[c.getId()] = 1; } } catch (e) {}
  }
  addCal(function () { return CalendarApp.getCalendarById(WORK_CAL_ID); }, 'prominato');      // real schedule lives here
  addCal(function () { return CalendarApp.getCalendarById(PERSONAL_CAL_ID); }, 'personal');
  addCal(function () { return CalendarApp.getDefaultCalendar(); }, 'personal');               // fallback: whichever account runs this
  try {
    CalendarApp.getAllCalendars().forEach(function (c) {
      var id = c.getId(); if (seen[id] || /holiday/i.test(id)) return;
      if (/prominato/i.test((c.getName() || '') + ' ' + id)) { sources.push({ cal: c, tag: 'prominato' }); seen[id] = 1; }
    });
  } catch (e) {}
  sources.forEach(function (src) {
    src.cal.getEvents(now, end).forEach(function (ev) {
      var status = '';
      try { status = String(ev.getMyStatus() || ''); } catch (e) {}
      if (status === 'NO') return;                     // declined -> never shown
      var allDay = ev.isAllDayEvent();
      var st = ev.getStartTime(), en = ev.getEndTime();
      var endAdj = allDay ? new Date(en.getTime() - 24 * 3600 * 1000) : en;
      if (endAdj < st) endAdj = st;
      out.push({
        id: 'cal-' + ev.getId(),
        label: ev.getTitle() || '(busy)',
        start: Utilities.formatDate(st, TZ, 'yyyy-MM-dd'),
        end: Utilities.formatDate(endAdj, TZ, 'yyyy-MM-dd'),
        startTime: allDay ? '' : Utilities.formatDate(st, TZ, 'HH:mm'),
        endTime: allDay ? '' : Utilities.formatDate(en, TZ, 'HH:mm'),
        loc: ev.getLocation() || '',
        status: status,                                // OWNER/YES / INVITED/MAYBE -> shown as tentative (tentative)
        allDay: allDay,
        cal: src.tag                                   // 'personal' | 'prominato' -> drives the color family
      });
    });
  });
  return out;
}
