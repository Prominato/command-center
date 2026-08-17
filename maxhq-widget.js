// ── Max HQ · iOS lock-screen + home-screen widget ────────────────────────────
// Runs in Scriptable (free, App Store). Reads the same Apps Script JSON API the
// dashboard uses, so it needs no login and no extra backend.
//
// Supports: accessoryCircular, accessoryRectangular, accessoryInline (lock screen)
//           small, medium (home screen)

const SYNC = "https://script.google.com/macros/s/AKfycbyic_f4k-yyeE50v45XhZ4_PkDvqkPxUGlSecj9BbbOuYer6ZZQBZBk2FRvl6WfTkuw/exec";
// Paste your widget key here (Max HQ → I gave it to you privately; it is NOT in this repo).
// This key can ONLY fetch progress counts — never to-do text, notes or calendar titles.
const WIDGET_KEY = "PASTE_YOUR_WIDGET_KEY_HERE";
const CH_ITEMS = 8;                    // habits in the 21-day challenge
const BRASS = new Color("#C9A96A");
const SAGE  = new Color("#6FA396");
const RED   = new Color("#C2705C");
const MUT   = new Color("#8F8471");

function iso(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

async function getSummary(){
  const req = new Request(SYNC);
  req.method = "POST";
  req.headers = { "Content-Type": "text/plain;charset=utf-8" };   // simple type → no CORS preflight
  req.body = JSON.stringify({ action: "summary", key: WIDGET_KEY });
  req.timeoutInterval = 20;
  const j = await req.loadJSON();
  if (!j || !j.ok) throw new Error(j && j.error ? j.error : "unauthorized");
  return { dayIdx: j.day - 1, day: j.day, todayDone: j.todayDone, chPct: j.pct,
           primary: j.primary, urgent: j.urgent, dcDone: j.dcDone, dcAll: j.dcAll, water: j.water };
}

// progress ring for the circular lock-screen widget
function ring(pct, label, sub){
  const size = 190, lw = 18;
  const c = new DrawContext();
  c.size = new Size(size, size);
  c.opaque = false; c.respectScreenScale = true;
  c.setStrokeColor(new Color("#ffffff", 0.25));
  c.setLineWidth(lw);
  c.strokeEllipse(new Rect(lw/2, lw/2, size-lw, size-lw));
  // arc
  c.setStrokeColor(new Color("#ffffff", 0.95));
  const steps = Math.max(1, Math.round(pct / 100 * 90));
  for (let i = 0; i < steps; i++){
    const a = (-90 + i * 4) * Math.PI / 180;
    const r = (size - lw) / 2, cx = size/2, cy = size/2;
    const p = new Path();
    p.addEllipse(new Rect(cx + r*Math.cos(a) - lw/2, cy + r*Math.sin(a) - lw/2, lw, lw));
    c.addPath(p); c.fillPath();
  }
  c.setTextAlignedCenter();
  c.setTextColor(new Color("#ffffff"));
  c.setFont(Font.boldSystemFont(46));
  c.drawTextInRect(label, new Rect(0, size/2 - 42, size, 52));
  c.setFont(Font.systemFont(26));
  c.drawTextInRect(sub, new Rect(0, size/2 + 8, size, 32));
  return c.getImage();
}

function bar(w, widget, pct, color){
  const track = widget.addStack();
  track.size = new Size(w, 4);
  track.cornerRadius = 2;
  track.backgroundColor = new Color("#ffffff", 0.22);
  const fill = track.addStack();
  fill.size = new Size(Math.max(2, Math.round(w * pct / 100)), 4);
  fill.cornerRadius = 2;
  fill.backgroundColor = color;
}

async function build(){
  let d;
  try { d = await getSummary(); }
  catch (e) {
    const w = new ListWidget();
    w.addText("Max HQ").font = Font.boldSystemFont(12);
    const msg = String(e).indexOf("unauthorized") >= 0 ? "key rejected" : "offline";
    const t = w.addText(msg); t.font = Font.systemFont(11); t.textColor = MUT;
    return w;
  }

  const fam = config.widgetFamily || "accessoryRectangular";
  const w = new ListWidget();
  w.url = "https://maxhq.netlify.app";           // tap the widget → open the dashboard
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  if (fam === "accessoryCircular"){
    w.backgroundImage = ring(d.chPct, d.todayDone + "/" + CH_ITEMS, "d" + d.day);
    return w;
  }

  if (fam === "accessoryInline"){
    w.addText("⌁ " + d.todayDone + "/" + CH_ITEMS + " · " + d.primary + " open" + (d.urgent ? " · " + d.urgent + "!" : ""));
    return w;
  }

  if (fam === "accessoryRectangular"){
    w.setPadding(0,0,0,0);
    const top = w.addStack(); top.centerAlignContent();
    const t1 = top.addText("MAX HQ");
    t1.font = Font.mediumSystemFont(11); t1.textOpacity = 0.7;
    top.addSpacer();
    const t2 = top.addText("DAY " + d.day + "/21");
    t2.font = Font.mediumSystemFont(11); t2.textOpacity = 0.7;
    w.addSpacer(3);
    const mid = w.addText(d.todayDone + "/" + CH_ITEMS + " habits · " + d.dcDone + "/" + d.dcAll + " daily");
    mid.font = Font.boldSystemFont(14);
    w.addSpacer(3);
    bar(150, w, Math.round(d.todayDone / CH_ITEMS * 100), new Color("#ffffff", 0.95));
    w.addSpacer(3);
    const bot = w.addText(d.primary + " primary" + (d.urgent ? " · " + d.urgent + " urgent" : "") + " · " + d.water + "/4 water");
    bot.font = Font.systemFont(11); bot.textOpacity = 0.75;
    return w;
  }

  // ---- home screen (small / medium): full colour ----
  w.backgroundColor = new Color("#16130F");
  w.setPadding(14,14,14,14);
  const head = w.addStack(); head.centerAlignContent();
  const h = head.addText("MAX HQ");
  h.font = Font.boldMonospacedSystemFont(10); h.textColor = BRASS;
  head.addSpacer();
  const dd = head.addText("DAY " + d.day + "/21");
  dd.font = Font.mediumMonospacedSystemFont(10); dd.textColor = MUT;
  w.addSpacer(8);

  const big = w.addText(d.todayDone + "/" + CH_ITEMS);
  big.font = Font.boldSystemFont(30); big.textColor = new Color("#E9E2D6");
  const cap = w.addText("habits today");
  cap.font = Font.systemFont(11); cap.textColor = MUT;
  w.addSpacer(8);
  bar(fam === "medium" ? 280 : 120, w, Math.round(d.todayDone / CH_ITEMS * 100), SAGE);
  w.addSpacer(8);

  const row = w.addStack();
  const mk = (label, value, color) => {
    const s = row.addStack(); s.layoutVertically();
    const v = s.addText(String(value)); v.font = Font.boldSystemFont(15); v.textColor = color;
    const l = s.addText(label); l.font = Font.mediumMonospacedSystemFont(8); l.textColor = MUT;
    row.addSpacer();
  };
  mk("PRIMARY", d.primary, new Color("#E9E2D6"));
  mk("URGENT", d.urgent, d.urgent ? RED : MUT);
  mk("DAILY", d.dcDone + "/" + d.dcAll, new Color("#E9E2D6"));
  mk("WATER", d.water + "/4", d.water >= 4 ? SAGE : new Color("#E9E2D6"));
  w.addSpacer(4);
  const foot = w.addText(d.chPct + "% of the challenge banked");
  foot.font = Font.systemFont(10); foot.textColor = MUT;
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
