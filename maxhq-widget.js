// ── Max HQ · iOS lock-screen + home-screen widgets ───────────────────────────
// Runs in Scriptable (free, App Store). Talks to the dashboard's Apps Script API
// with a widget key: today's timeline, open primary to-dos, challenge progress.
//
// THREE WIDGETS, ONE SCRIPT. Which one you get is set by the widget's Parameter
// field (long-press the widget → Edit Widget → Parameter):
//
//     agenda      today's timeline, with the block you are in right now
//     challenge   the 21-day challenge
//     master      the Master to-do list
//
// Leave Parameter empty and it picks a sensible default for the size. You can also
// put the key there instead of entering it when prompted, and both together in any
// order: "master wid_abc123..."
//
// Home-screen widgets follow whatever colourway the dashboard is set to. Lock-screen
// widgets are forced monochrome by iOS, so those are drawn in white and opacity.

const SYNC = "https://script.google.com/macros/s/AKfycbyic_f4k-yyeE50v45XhZ4_PkDvqkPxUGlSecj9BbbOuYer6ZZQBZBk2FRvl6WfTkuw/exec";

// LEAVE THIS LINE ALONE. Run the script once and it asks for the key, then keeps it
// in this device's Keychain. Editing code on a phone is how a key ends up truncated,
// autocapitalised, or - seen in the wild - replaced by the entire script, because a
// single-line field eats a multi-line paste.
const WIDGET_KEY = "PASTE_YOUR_WIDGET_KEY_HERE";
const KEY_STORE  = "maxhq_widget_key";
const CH_ITEMS   = 8;                    // habits in the 21-day challenge

// The dashboard's eight colourways, lifted from its CSS so the widget cannot drift
// from the app. The backend reports which one is active.
const THEMES = {
  dark:     { bg:"#16130F", ink:"#E9E2D6", mut:"#8F8471", acc:"#C9A96A", sage:"#6FA396", red:"#C2705C", line:"#2E2820" },
  light:    { bg:"#EFEBE3", ink:"#2A251C", mut:"#7A7060", acc:"#8A6E3A", sage:"#3E7A6C", red:"#A04A36", line:"#DBD3C2" },
  forest:   { bg:"#0F1512", ink:"#E2EADF", mut:"#85947F", acc:"#C2A24E", sage:"#7FB489", red:"#C86F5E", line:"#25322B" },
  midnight: { bg:"#0E1219", ink:"#DDE6F2", mut:"#7E8CA0", acc:"#63C6DB", sage:"#5FC3A6", red:"#E2736B", line:"#233040" },
  steel:    { bg:"#F0F2F5", ink:"#171C23", mut:"#5C6570", acc:"#16687C", sage:"#1D6350", red:"#943E34", line:"#DADEE5" },
  ember:    { bg:"#14100E", ink:"#F2E7E0", mut:"#9C8578", acc:"#FF6B35", sage:"#4ECDC4", red:"#E01E37", line:"#33251F" },
  citrus:   { bg:"#FFF6EE", ink:"#26160C", mut:"#7A5A44", acc:"#E85D04", sage:"#0B7A5E", red:"#C1121F", line:"#F0DCC8" },
  sunset:   { bg:"#F4573F", ink:"#1B0F0C", mut:"#7C574C", acc:"#C2300F", sage:"#0A7057", red:"#A50E1E", line:"#F2D9D2" }
};
function palette(name){ return THEMES[String(name || "dark")] || THEMES.dark; }
function C(hex, alpha){ return alpha === undefined ? new Color(hex) : new Color(hex, alpha); }

// ── key handling ─────────────────────────────────────────────────────────────
// A key is 40-ish characters of url-safe base64. Anything else - a stray newline,
// a smart quote, a whole file - is rejected before it can be stored or sent.
// The placeholder has to be excluded by name: PASTE_YOUR_WIDGET_KEY_HERE is itself
// 26 legal characters, so a shape check alone happily waves it through.
function looksLikeKey(s){
  s = String(s || "").trim();
  if (s.indexOf("PASTE_") === 0) return false;
  return /^[A-Za-z0-9_-]{20,80}$/.test(s);
}

const VIEWS = { agenda:"agenda", today:"agenda", timeline:"agenda",
                challenge:"challenge", habits:"challenge",
                master:"master", todo:"master", todos:"master" };

/** The Parameter field may hold a view, a key, or both in either order. */
function parseParam(){
  let raw = "";
  try { raw = String(args.widgetParameter || ""); } catch (e) {}
  let view = "", key = "";
  raw.split(/[\s,;|]+/).forEach(function (tok) {
    tok = tok.trim(); if (!tok) return;
    const low = tok.toLowerCase();
    if (VIEWS[low]) view = VIEWS[low];
    else if (looksLikeKey(tok)) key = tok;
  });
  return { view: view, key: key };
}

/* Key resolution, best source first: the Parameter field, this device's Keychain,
   the constant above, then ask - which can only happen when the script is run by
   hand, since a widget has nowhere to show a prompt. The winner is written back to
   the Keychain, so it is entered exactly once. */
async function resolveKey(fromParam){
  let k = fromParam || "";
  if (!looksLikeKey(k)) { try { if (Keychain.contains(KEY_STORE)) k = Keychain.get(KEY_STORE).trim(); } catch (e) {} }
  if (!looksLikeKey(k) && looksLikeKey(WIDGET_KEY)) k = String(WIDGET_KEY).trim();
  if (!looksLikeKey(k) && !config.runsInWidget) {
    const a = new Alert();
    a.title = "Max HQ widget key";
    a.message = "Paste the key from maxhq.netlify.app/widget.html.\n\nIt is kept in this device's Keychain, never in the code.";
    a.addTextField("wid_...", "");
    a.addAction("Save");
    a.addCancelAction("Cancel");
    if (await a.presentAlert() === 0) {
      const typed = a.textFieldValue(0).trim();
      if (looksLikeKey(typed)) k = typed;
      else await showAlert("That does not look like a key", typed.length + " characters. The key is about 40, and starts wid_.");
    }
  }
  if (looksLikeKey(k)) { try { Keychain.set(KEY_STORE, k); } catch (e) {} }
  return looksLikeKey(k) ? k : "";
}

async function showAlert(title, msg){
  const a = new Alert(); a.title = title; a.message = msg; a.addAction("OK");
  await a.presentAlert();
}

let KEY = "";

async function fetchPanel(view){
  const req = new Request(SYNC);
  req.method = "POST";
  req.headers = { "Content-Type": "text/plain;charset=utf-8" };   // simple type → no CORS preflight
  req.body = JSON.stringify({ action: "panel", view: view, key: KEY });
  req.timeoutInterval = 20;
  const j = await req.loadJSON();
  if (!j || !j.ok) throw new Error(j && j.error ? j.error : "unauthorized");
  return j;
}

// ── small helpers ────────────────────────────────────────────────────────────
function nowMinutes(){ const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function hhmm(m){
  let h = Math.floor(m / 60) % 24, mm = m % 60;
  const ap = h < 12 ? "a" : "p";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + (mm < 10 ? "0" : "") + mm + ap;
}
/** Split today's blocks into what is happening now and what is next. */
function splitDay(blocks){
  const n = nowMinutes();
  let cur = null, next = [];
  for (let i = 0; i < blocks.length; i++){
    const b = blocks[i];
    if (n >= b.s && n < Math.max(b.e, b.s + 1)) { if (!cur) cur = b; }
    else if (b.s > n) next.push(b);
  }
  return { cur: cur, next: next };
}
function bar(host, w, pct, color, track){
  const t = host.addStack();
  t.size = new Size(w, 4); t.cornerRadius = 2;
  t.backgroundColor = track;
  const f = t.addStack();
  f.size = new Size(Math.max(2, Math.round(w * Math.max(0, Math.min(100, pct)) / 100)), 4);
  f.cornerRadius = 2; f.backgroundColor = color;
}

/* Errors name the failure and show the shape of the key actually used: length plus
   the first four characters gives away every common mistake at a glance. Four
   characters of a 42-character random key reveal nothing. Tapping opens the guide. */
function errWidget(head, detail){
  const w = new ListWidget();
  w.url = "https://maxhq.netlify.app/widget.html";
  const a = w.addText("MAX HQ"); a.font = Font.boldSystemFont(11); a.textOpacity = 0.7;
  const b = w.addText(head); b.font = Font.boldSystemFont(13);
  if (detail){ const c = w.addText(detail); c.font = Font.systemFont(9.5); c.textOpacity = 0.7; }
  return w;
}

// ── lock screen (monochrome: white + opacity only) ───────────────────────────
function ring(pct, label, sub){
  const size = 190, lw = 18;
  const c = new DrawContext();
  c.size = new Size(size, size);
  c.opaque = false; c.respectScreenScale = true;
  c.setStrokeColor(new Color("#ffffff", 0.25));
  c.setLineWidth(lw);
  c.strokeEllipse(new Rect(lw / 2, lw / 2, size - lw, size - lw));
  c.setStrokeColor(new Color("#ffffff", 0.95));
  const steps = Math.max(1, Math.round(pct / 100 * 90));
  for (let i = 0; i < steps; i++){
    const ang = (-90 + i * 4) * Math.PI / 180;
    const r = (size - lw) / 2, cx = size / 2, cy = size / 2;
    const p = new Path();
    p.addEllipse(new Rect(cx + r * Math.cos(ang) - lw / 2, cy + r * Math.sin(ang) - lw / 2, lw, lw));
    c.addPath(p); c.fillPath();
  }
  c.setTextAlignedCenter();
  c.setTextColor(new Color("#ffffff"));
  c.setFont(Font.boldSystemFont(46));
  c.drawTextInRect(label, new Rect(0, size / 2 - 42, size, 52));
  c.setFont(Font.systemFont(26));
  c.drawTextInRect(sub, new Rect(0, size / 2 + 8, size, 32));
  return c.getImage();
}

function lockCircular(d, view){
  const w = new ListWidget();
  if (view === "master") w.backgroundImage = ring(d.primary ? 100 : 0, String(d.primary), d.urgent ? d.urgent + "!" : "open");
  else w.backgroundImage = ring(d.pct, d.todayDone + "/" + CH_ITEMS, "d" + d.day);
  return w;
}

function lockInline(d, view){
  const w = new ListWidget();
  if (view === "agenda"){
    const s = splitDay(d.blocks || []);
    w.addText(s.cur ? "▸ " + s.cur.l + " · until " + hhmm(s.cur.e)
                    : (s.next[0] ? "▸ next " + hhmm(s.next[0].s) + " " + s.next[0].l : "▸ nothing scheduled"));
  } else if (view === "master"){
    w.addText("▸ " + d.primary + " open" + (d.urgent ? " · " + d.urgent + "!" : "") +
              ((function(){ const L = Array.isArray(d.list) ? d.list : (Array.isArray(d.items) ? d.items : []); return L[0] ? " · " + L[0].t : ""; })()));
  } else {
    w.addText("⌁ " + d.todayDone + "/" + CH_ITEMS + " · day " + d.day + "/21");
  }
  return w;
}

function lockRect(d, view){
  const w = new ListWidget();
  w.setPadding(0, 0, 0, 0);
  const head = w.addStack(); head.centerAlignContent();
  const h1 = head.addText("MAX HQ"); h1.font = Font.mediumSystemFont(11); h1.textOpacity = 0.7;
  head.addSpacer();

  if (view === "agenda"){
    const s = splitDay(d.blocks || []);
    const h2 = head.addText(s.cur ? hhmm(s.cur.s) + "–" + hhmm(s.cur.e) : "today");
    h2.font = Font.mediumSystemFont(11); h2.textOpacity = 0.7;
    w.addSpacer(3);
    const t = w.addText(s.cur ? s.cur.l : (d.stale ? "open Max HQ to refresh" : "nothing scheduled"));
    t.font = Font.boldSystemFont(15); t.lineLimit = 1;
    w.addSpacer(2);
    const nx = w.addText(s.next[0] ? "next " + hhmm(s.next[0].s) + "  " + s.next[0].l : "nothing after this");
    nx.font = Font.systemFont(11); nx.textOpacity = 0.75; nx.lineLimit = 1;
    return w;
  }
  if (view === "master"){
    const h2 = head.addText(d.primary + " open"); h2.font = Font.mediumSystemFont(11); h2.textOpacity = 0.7;
    w.addSpacer(3);
    const list = (Array.isArray(d.list) ? d.list : (Array.isArray(d.items) ? d.items : [])).slice(0, 3);
    if (!list.length){ const t = w.addText("all clear"); t.font = Font.boldSystemFont(14); return w; }
    list.forEach(function (it, i){
      const t = w.addText((it.u ? "! " : "· ") + it.t);
      t.font = i === 0 ? Font.boldSystemFont(13) : Font.systemFont(11.5);
      t.textOpacity = i === 0 ? 1 : 0.8; t.lineLimit = 1;
    });
    return w;
  }
  const h2 = head.addText("DAY " + d.day + "/21"); h2.font = Font.mediumSystemFont(11); h2.textOpacity = 0.7;
  w.addSpacer(3);
  const mid = w.addText(d.todayDone + "/" + CH_ITEMS + " habits · " + d.dcDone + "/" + d.dcAll + " daily");
  mid.font = Font.boldSystemFont(14);
  w.addSpacer(3);
  bar(w, 150, Math.round(d.todayDone / CH_ITEMS * 100), new Color("#ffffff", 0.95), new Color("#ffffff", 0.22));
  w.addSpacer(3);
  const bot = w.addText(d.primary + " primary" + (d.urgent ? " · " + d.urgent + " urgent" : "") + " · " + d.water + "/4 water");
  bot.font = Font.systemFont(11); bot.textOpacity = 0.75;
  return w;
}

// ── home screen (full colour, follows the dashboard's colourway) ─────────────
function homeShell(p){
  const w = new ListWidget();
  w.backgroundColor = C(p.bg);
  w.setPadding(14, 14, 14, 14);
  return w;
}
function homeHead(w, p, left, right){
  const s = w.addStack(); s.centerAlignContent();
  const a = s.addText(left); a.font = Font.boldSystemFont(10); a.textColor = C(p.acc);
  s.addSpacer();
  if (right){ const b = s.addText(right); b.font = Font.mediumSystemFont(10); b.textColor = C(p.mut); }
  return s;
}

function homeAgenda(d, p, fam){
  const w = homeShell(p);
  const s = splitDay(d.blocks || []);
  homeHead(w, p, "TODAY", s.cur ? hhmm(s.cur.s) + "–" + hhmm(s.cur.e) : "");
  w.addSpacer(7);

  if (d.stale || !(d.blocks || []).length){
    const t = w.addText("No timeline yet"); t.font = Font.boldSystemFont(15); t.textColor = C(p.ink);
    const u = w.addText("Open Max HQ once to publish today.");
    u.font = Font.systemFont(11); u.textColor = C(p.mut); u.lineLimit = 2;
    return w;
  }

  const now = w.addText(s.cur ? s.cur.l : "Between blocks");
  now.font = Font.boldSystemFont(fam === "small" ? 15 : 18);
  now.textColor = C(p.ink); now.lineLimit = 2; now.minimumScaleFactor = 0.8;

  if (s.cur){
    w.addSpacer(5);
    const span = Math.max(1, s.cur.e - s.cur.s);
    bar(w, fam === "small" ? 120 : 290, Math.round((nowMinutes() - s.cur.s) / span * 100), C(p.acc), C(p.line));
  }
  w.addSpacer(8);

  const rows = s.next.slice(0, fam === "small" ? 2 : 4);
  if (!rows.length){
    const t = w.addText("nothing after this"); t.font = Font.systemFont(11); t.textColor = C(p.mut);
  }
  rows.forEach(function (b){
    const r = w.addStack(); r.centerAlignContent();
    const tt = r.addText(hhmm(b.s));
    tt.font = Font.mediumSystemFont(10.5); tt.textColor = C(p.mut);
    r.addSpacer(8);
    const ll = r.addText(b.l);
    ll.font = Font.systemFont(11.5); ll.textColor = C(p.ink); ll.lineLimit = 1;
    if (b.v){ r.addSpacer(4); const c = r.addText("cal"); c.font = Font.systemFont(8.5); c.textColor = C(p.sage); }
    r.addSpacer();
    w.addSpacer(3);
  });
  return w;
}

function homeChallenge(d, p, fam){
  const w = homeShell(p);
  homeHead(w, p, "21-DAY CHALLENGE", "DAY " + d.day + "/21");
  w.addSpacer(8);
  const big = w.addText(d.todayDone + "/" + CH_ITEMS);
  big.font = Font.boldSystemFont(30); big.textColor = C(p.ink);
  const cap = w.addText("habits today");
  cap.font = Font.systemFont(11); cap.textColor = C(p.mut);
  w.addSpacer(8);
  bar(w, fam === "small" ? 120 : 290, Math.round(d.todayDone / CH_ITEMS * 100), C(p.sage), C(p.line));
  w.addSpacer(9);

  // One column per day: fuller column = more habits ticked that day.
  const grid = d.grid || [];
  if (grid.length){
    const strip = w.addStack(); strip.centerAlignContent();
    const cw = fam === "small" ? 4 : 11;
    for (let day = 0; day < 21; day++){
      let done = 0;
      for (let i = 0; i < grid.length; i++) if (grid[i][day]) done++;
      const cell = strip.addStack();
      cell.size = new Size(cw, 12); cell.cornerRadius = 1.5;
      cell.backgroundColor = done ? C(p.sage, 0.25 + 0.75 * (done / CH_ITEMS))
                                  : C(p.line, day === d.dayIdx ? 1 : 0.55);
      strip.addSpacer(fam === "small" ? 1 : 2);
    }
  }
  w.addSpacer(6);
  const foot = w.addText(d.pct + "% banked");
  foot.font = Font.systemFont(10); foot.textColor = C(p.mut);
  return w;
}

function homeMaster(d, p, fam){
  const w = homeShell(p);
  homeHead(w, p, "MASTER", d.primary + " open" + (d.urgent ? " · " + d.urgent + "!" : ""));
  w.addSpacer(7);
  // list is the unambiguous field; items is the older name for the same array, and
  // is a plain count in other views - so only trust it when it really is an array.
  const items = Array.isArray(d.list) ? d.list : (Array.isArray(d.items) ? d.items : []);
  if (!items.length){
    const t = w.addText("All clear"); t.font = Font.boldSystemFont(16); t.textColor = C(p.ink);
    return w;
  }
  const max = fam === "small" ? 5 : 8;
  items.slice(0, max).forEach(function (it){
    const r = w.addStack(); r.centerAlignContent();
    const dot = r.addText(it.u ? "●" : "·");
    dot.font = Font.systemFont(it.u ? 8 : 12); dot.textColor = it.u ? C(p.red) : C(p.mut);
    r.addSpacer(5);
    const t = r.addText(it.t);
    t.font = it.u ? Font.mediumSystemFont(11.5) : Font.systemFont(11.5);
    t.textColor = it.u ? C(p.red) : C(p.ink);
    t.lineLimit = 1; t.minimumScaleFactor = 0.85;
    r.addSpacer();
    w.addSpacer(fam === "small" ? 3 : 4);
  });
  const hidden = (items.length - Math.min(items.length, max)) + (d.more || 0);
  if (hidden > 0){
    const m = w.addText("+" + hidden + " more");
    m.font = Font.systemFont(10); m.textColor = C(p.mut);
  }
  return w;
}

// ── assembly ─────────────────────────────────────────────────────────────────
async function build(){
  const param = parseParam();
  KEY = await resolveKey(param.key);
  if (!KEY) return errWidget("no key yet", config.runsInWidget ? "open Scriptable, tap play" : "run again to enter it");

  const fam = config.widgetFamily || (config.runsInWidget ? "accessoryRectangular" : "medium");
  const lock = fam.indexOf("accessory") === 0;
  // Default per size: the small slots he asked for are the two summaries, the long
  // ones are the agenda.
  const view = param.view || (fam === "small" ? "challenge" : "agenda");

  let d;
  try { d = await fetchPanel(view); }
  catch (e){
    const s = String(e);
    const shape = KEY.length + " chars, starts " + KEY.slice(0, 4);
    if (s.indexOf("unauthorized") >= 0){
      try { Keychain.remove(KEY_STORE); } catch (e2) {}   // forget a dud so the next run re-asks
      return errWidget("key rejected", shape);
    }
    if (s.indexOf("forbidden") >= 0) return errWidget("wrong key type", "needs the widget key");
    return errWidget("offline", "no answer from the backend");
  }

  let w;
  if (lock){
    w = fam === "accessoryCircular" ? lockCircular(d, view)
      : fam === "accessoryInline"   ? lockInline(d, view)
      : lockRect(d, view);
  } else {
    const p = palette(d.theme);
    w = view === "challenge" ? homeChallenge(d, p, fam)
      : view === "master"    ? homeMaster(d, p, fam)
      : homeAgenda(d, p, fam);
  }
  w.url = "https://maxhq.netlify.app";           // tap → open the dashboard
  // Re-render on the hour boundary of the current block where that is sooner than
  // 15 minutes, so "now" flips over promptly rather than lagging a whole refresh.
  let mins = 15;
  if (view === "agenda" && d.blocks){
    const s = splitDay(d.blocks);
    if (s.cur) mins = Math.max(2, Math.min(15, s.cur.e - nowMinutes()));
  }
  w.refreshAfterDate = new Date(Date.now() + mins * 60 * 1000);
  return w;
}

const widget = await build();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // previewing inside the Scriptable app — match the family you're testing
  const fam = config.widgetFamily || "medium";
  if (fam === "accessoryRectangular" && widget.presentAccessoryRectangular) await widget.presentAccessoryRectangular();
  else if (fam === "accessoryCircular" && widget.presentAccessoryCircular) await widget.presentAccessoryCircular();
  else if (fam === "accessoryInline" && widget.presentAccessoryInline) await widget.presentAccessoryInline();
  else if (widget.presentMedium) await widget.presentMedium();
}
Script.complete();
