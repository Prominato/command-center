/**
 * Command Center — data backend (Google Apps Script Web App)
 * ----------------------------------------------------------
 * Serves JSON to maxhq.netlify.app via fetch(): saved state (cross-device
 * sync) and Google Calendar events (read-only). Storage = the same
 * "Agenda Book — Data" spreadsheet this script project already owns.
 *
 * TO INSTALL: paste this file over the ENTIRE contents of Code.gs in the
 * existing Apps Script project, save (⌘S), then re-deploy the SAME deployment:
 *   Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy
 * (Saving alone changes nothing — /exec serves the last deployed version.)
 * First deploy will ask to re-authorize (it now reads your Calendar too).
 *
 * Endpoints:
 *   GET  ?action=state → {ok, state:{key:{v,t}}}
 *   GET  ?action=cal   → {ok, events:[… next 90 days …]}
 *   GET  ?action=all   → {ok, state, events}   (default)
 *   GET  ?action=ping  → {ok, pong}
 *   POST {items:[{k,v,t}]} as text/plain → {ok, n}   · last-write-wins per key
 */

var SHEET_TAB = 'state';
var PROP_ID   = 'AGENDA_SHEET_ID';
var TZ        = 'America/Detroit';

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'all';
  try {
    if (action === 'state') return json_({ ok: true, state: loadState_() });
    if (action === 'cal')   return json_({ ok: true, events: calEvents_() });
    if (action === 'ping')  return json_({ ok: true, pong: Date.now() });
    return json_({ ok: true, state: loadState_(), events: calEvents_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var n = saveBatch_(body.items || []);
    return json_({ ok: true, n: n });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Same backing spreadsheet as before (created on first use). */
function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_ID);
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Agenda Book — Data');
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

/** Upsert [{k,v,t}] — newer timestamp wins; locked against concurrent devices. */
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
        index[data[i][0]] = { row: i + 2, t: Number(data[i][2]) || 0 };
      }
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

/** Next 90 days of the default Google Calendar — read-only, declined dropped. */
function calEvents_() {
  var now = new Date();
  var end = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
  var out = [];
  CalendarApp.getDefaultCalendar().getEvents(now, end).forEach(function (ev) {
    var status = '';
    try { status = String(ev.getMyStatus() || ''); } catch (e) {}
    if (status === 'NO') return;                       // declined → never shown
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
      status: status,                                  // OWNER/YES · INVITED/MAYBE → shown as tentative ⏳
      allDay: allDay
    });
  });
  return out;
}
