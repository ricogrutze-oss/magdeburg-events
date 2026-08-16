// generate-events.js — Magdeburg Events (Kostenlos v2)
// Nur bewährte Quellen: ICS-Feeds + funktionierende HTML-Quellen
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const today = new Date(); today.setHours(0,0,0,0);
const todayStr = isoLocal(today);
const until = new Date(); until.setDate(until.getDate() + 90);
const untilStr = isoLocal(until);

console.log(`🏰 Magdeburg Events — Kostenloser Abruf v2`);
console.log(`📅 ${new Date().toISOString()}`);
console.log(`📆 ${todayStr} bis ${untilStr}`);

function isoLocal(d) {
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

function fetchUrl(url, maxSize=800000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MagdeburgEvents/2.0)" },
      timeout: 20000,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, maxSize).then(resolve).catch(reject);
      }
      let data = ""; let size = 0;
      res.on("data", chunk => { data += chunk; size += chunk.length; if(size > maxSize) res.destroy(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── ICS Parser ────────────────────────────────────────────────────────────────
function parseICS(text, sourceName, catOverride) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const get = k => { const m = b.match(new RegExp(k+"[^:]*:([^\\r\\n]+")); return m?m[1].trim():null; };
    const summary = get("SUMMARY"); if (!summary) continue;
    const dtstart = get("DTSTART"); if (!dtstart || dtstart.length < 8) continue;
    const y=dtstart.slice(0,4), mo=dtstart.slice(4,6), d=dtstart.slice(6,8);
    const dateFrom = `${y}-${mo}-${d}`;
    if (dateFrom < todayStr || dateFrom > untilStr) continue;
    let timeStart = null;
    if (dtstart.includes("T") && dtstart.length >= 15) timeStart = `${dtstart.slice(9,11)}:${dtstart.slice(11,13)}`;
    const dtend = get("DTEND");
    let dateTo = dateFrom;
    if (dtend && dtend.length >= 8) {
      const ey=dtend.slice(0,4),em=dtend.slice(4,6),ed=dtend.slice(6,8);
      if (!dtstart.includes("T")) {
        const end = new Date(parseInt(ey),parseInt(em)-1,parseInt(ed));
        end.setDate(end.getDate()-1);
        dateTo = isoLocal(end);
      } else dateTo = `${ey}-${em}-${ed}`;
    }
    const location = (get("LOCATION")||"Magdeburg").replace(/\\,/g,",").replace(/\\n/g," ").slice(0,100);
    const cleanName = summary.replace(/\\,/g,",").replace(/\\n/g," ").trim().slice(0,200);
    let cat = catOverride || "Sonstiges";
    if (!catOverride) {
      const t = cleanName.toLowerCase();
      if (/konzert|musik|band|live|jazz|rock|pop|party|dj|swing|song/.test(t)) cat="Musik";
      else if (/theater|oper|ballett|schauspiel|kabarett|comedy|lesung|reading/.test(t)) cat="Theater";
      else if (/flohmarkt|trödelmarkt|trodel/.test(t)) cat="Flohmarkt";
      else if (/sport|spiel|handball|fußball|laufen/.test(t)) cat="Sport";
      else if (/kinder|familie|jugend|dino/.test(t)) cat="Familie";
      else if (/festival|fest|ausstellung|kunst|museum|messe/.test(t)) cat="Kultur";
    }
    events.push({ name:cleanName, dateFrom, dateTo, timeStart, category:cat, location, sources:sourceName });
  }
  return events;
}

// ── Quellen ───────────────────────────────────────────────────────────────────

async function fetchDates() {
  console.log("\n🔍 DATEs Stadtmagazin (ICS)...");
  try {
    const data = await fetchUrl("https://www.dates-md.de/search/event/veranstaltungen-magdeburg/calendar.ics");
    const events = parseICS(data, "DATEs Stadtmagazin");
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchDatesUmland() {
  console.log("\n🔍 DATEs Umland (ICS)...");
  try {
    const data = await fetchUrl("https://www.dates-md.de/search/event/umland/calendar.ics");
    const events = parseICS(data, "DATEs Umland");
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchSCM() {
  console.log("\n🔍 SC Magdeburg Handball (ICS)...");
  try {
    const data = await fetchUrl("https://calovo.de/f/scm-handball/spielplan.ics");
    const raw = parseICS(data, "SC Magdeburg", "Sport");
    // Nur Heimspiele
    const home = raw.filter(e => e.name.includes("SC Magdeburg :") || e.name.startsWith("SC Magdeburg"));
    const events = home.map(e => ({...e, location:"GETEC Arena, Magdeburg"}));
    console.log(`  ✅ ${events.length} Heimspiele`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFCM() {
  console.log("\n🔍 1. FC Magdeburg (ICS)...");
  try {
    const data = await fetchUrl("https://calovo.de/f/fcmagdeburg/spielplan.ics");
    const raw = parseICS(data, "1. FC Magdeburg", "Sport");
    const home = raw.filter(e => e.name.includes("1. FC Magdeburg :") || e.name.startsWith("1. FC Magdeburg"));
    const events = home.map(e => ({...e, location:"MDCC-Arena, Magdeburg"}));
    console.log(`  ✅ ${events.length} Heimspiele`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMagdeburgRSS() {
  console.log("\n🔍 Magdeburg.de (RSS)...");
  try {
    const data = await fetchUrl("https://www.magdeburg.de/index.php?object=rss,37.7773.1&La=1");
    const events = [];
    const items = data.split("<item>");
    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      const getTag = tag => {
        const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`));
        return m?(m[1]||m[2]||"").trim():null;
      };
      const title = getTag("title"); if (!title || title.length < 3) continue;
      const pubDate = getTag("pubDate"); if (!pubDate) continue;
      const d = new Date(pubDate); if (isNaN(d)) continue;
      const dateFrom = isoLocal(d);
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      events.push({ name:title.slice(0,200), dateFrom, dateTo:dateFrom, timeStart:null, category:"Sonstiges", location:"Magdeburg", sources:"Landeshauptstadt Magdeburg" });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchSonntagsFlohmarkt() {
  console.log("\n🔍 Sonntags-Flohmarkt Wissenschaftshafen...");
  // Feste Termine: jeden 1. Sonntag im Monat
  const events = [];
  const cur = new Date(today);
  // Nächste 6 Monate durchsuchen
  for (let m = 0; m < 6; m++) {
    const month = new Date(cur.getFullYear(), cur.getMonth() + m, 1);
    // Ersten Sonntag finden
    const firstSun = new Date(month);
    while (firstSun.getDay() !== 0) firstSun.setDate(firstSun.getDate() + 1);
    const dateStr = isoLocal(firstSun);
    if (dateStr >= todayStr && dateStr <= untilStr) {
      events.push({
        name: "Magdeburger Sonntags-Flohmarkt",
        dateFrom: dateStr, dateTo: dateStr, timeStart: "10:00",
        category: "Flohmarkt", location: "Wissenschaftshafen, Sarajevo-Ufer, Magdeburg",
        sources: "Familienhaus Magdeburg"
      });
    }
  }
  console.log(`  ✅ ${events.length} Termine`);
  return events;
}

async function fetchMeineFM() {
  console.log("\n🔍 Meine Flohmarkt-Termine (HTML)...");
  try {
    const data = await fetchUrl("https://www.meine-flohmarkt-termine.de/flohmaerkte/sachsen-anhalt/magdeburg/");
    const events = [];
    // Datum-Pattern: dd.mm.yyyy
    const re = /(\d{2})\.(\d{2})\.(\d{4})[^<]{0,200}?<[^>]+class="[^"]*name[^"]*"[^>]*>([^<]{3,100})/gi;
    let m;
    while ((m = re.exec(data)) !== null && events.length < 30) {
      const dateFrom = `${m[3]}-${m[2]}-${m[1]}`;
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      events.push({
        name: m[4].trim().slice(0,200), dateFrom, dateTo:dateFrom,
        timeStart: null, category:"Flohmarkt",
        location:"Magdeburg", sources:"Meine Flohmarkt Termine"
      });
    }
    // Fallback: einfacher
    if (events.length === 0) {
      const dateRe = /(\d{2})\.(\d{2})\.(\d{4})/g;
      const titleRe = /<h[23][^>]*>([^<]{5,100})<\/h[23]>/gi;
      const dates = []; let dm;
      while ((dm = dateRe.exec(data)) !== null) {
        const df = `${dm[3]}-${dm[2]}-${dm[1]}`;
        if (df >= todayStr && df <= untilStr) dates.push(df);
      }
      const titles = []; let tm;
      while ((tm = titleRe.exec(data)) !== null) titles.push(tm[1].trim());
      for (let i = 0; i < Math.min(dates.length, titles.length, 20); i++) {
        events.push({ name:titles[i].slice(0,200), dateFrom:dates[i], dateTo:dates[i], timeStart:null, category:"Flohmarkt", location:"Magdeburg Umkreis", sources:"Meine Flohmarkt Termine" });
      }
    }
    console.log(`  ✅ ${events.length} Flohmärkte`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFlohmarktDE() {
  console.log("\n🔍 Flohmarkt.de Magdeburg (HTML)...");
  try {
    const data = await fetchUrl("https://www.flohmarkt.de/sachsen-anhalt/magdeburg/");
    const events = [];
    // Suche nach Datum + Name Kombinationen
    const re = /(\d{2})\.(\d{2})\.(\d{4})[^<]{0,500}?<strong>([^<]{5,100})<\/strong>/gi;
    let m;
    while ((m = re.exec(data)) !== null && events.length < 20) {
      const dateFrom = `${m[3]}-${m[2]}-${m[1]}`;
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      events.push({ name:m[4].trim().slice(0,200), dateFrom, dateTo:dateFrom, timeStart:null, category:"Flohmarkt", location:"Magdeburg", sources:"Flohmarkt.de" });
    }
    console.log(`  ✅ ${events.length} Flohmärkte`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMagdeburgTourist() {
  console.log("\n🔍 Magdeburg Tourist (HTML)...");
  try {
    const data = await fetchUrl("https://www.magdeburg-tourist.de/Tourismus-Freizeit/Veranstaltungen/Veranstaltungs-kalender/index.php?ModID=11&object=tx%7C557.6.1&La=1&NavID=115.20");
    const events = [];
    // Format: "DD.MM.YYYY" in Links
    const blocks = data.split(/<div[^>]+class="[^"]*event[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 30; i++) {
      const block = blocks[i].slice(0, 600);
      const dateM = block.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (!dateM) continue;
      const dateFrom = `${dateM[3]}-${dateM[2]}-${dateM[1]}`;
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      const titleM = block.match(/<a[^>]*>([^<]{5,100})<\/a>/i) || block.match(/<strong>([^<]{5,100})<\/strong>/i);
      if (!titleM) continue;
      const name = titleM[1].replace(/&amp;/g,"&").replace(/&#\d+;/g," ").trim();
      if (name.length < 3) continue;
      events.push({ name:name.slice(0,200), dateFrom, dateTo:dateFrom, timeStart:null, category:"Kultur", location:"Magdeburg", sources:"Magdeburg Tourist" });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

// ── Deduplizierung ────────────────────────────────────────────────────────────
function similarity(a, b) {
  if (!a || !b) return 0;
  const w = s => new Set(s.toLowerCase().replace(/[^a-zäöü0-9 ]/g,"").split(/\s+/).filter(w=>w.length>2));
  const wA=w(a), wB=w(b);
  if (!wA.size||!wB.size) return 0;
  const inter=[...wA].filter(x=>wB.has(x)).length;
  return inter/new Set([...wA,...wB]).size;
}

function dedup(events) {
  const result=[], merged=new Set();
  for (let i=0;i<events.length;i++) {
    if (merged.has(i)) continue;
    const base={...events[i]};
    const srcs=new Set((base.sources||"").split(",").map(s=>s.trim()));
    for (let j=i+1;j<events.length;j++) {
      if (merged.has(j)) continue;
      const other=events[j];
      if (base.dateFrom===other.dateFrom && similarity(base.name,other.name)>0.6) {
        (other.sources||"").split(",").forEach(s=>srcs.add(s.trim()));
        if (!base.timeStart&&other.timeStart) base.timeStart=other.timeStart;
        merged.add(j);
      }
    }
    base.sources=[...srcs].filter(Boolean).join(", ");
    result.push(base);
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];

  const results = await Promise.allSettled([
    fetchDates(),
    fetchDatesUmland(),
    fetchSCM(),
    fetchFCM(),
    fetchMagdeburgRSS(),
    fetchSonntagsFlohmarkt(),
    fetchMeineFM(),
    fetchFlohmarktDE(),
    fetchMagdeburgTourist(),
  ]);

  let allEvents = [];
  let ok = 0;
  for (const r of results) {
    if (r.status==="fulfilled" && r.value.length>0) {
      ok++;
      r.value.forEach(e => {
        if (!e.name||!e.dateFrom) return;
        allEvents.push({
          name: String(e.name).slice(0,200),
          dateFrom: e.dateFrom, dateTo: e.dateTo||e.dateFrom,
          timeStart: e.timeStart||null,
          category: validCats.includes(e.category)?e.category:"Sonstiges",
          location: e.location||"Magdeburg",
          sources: e.sources||"Unbekannt",
        });
      });
    }
  }

  console.log(`\n📊 ${ok}/${results.length} Quellen erfolgreich, ${allEvents.length} Events gesammelt`);
  const deduped = dedup(allEvents);
  deduped.sort((a,b)=>a.dateFrom.localeCompare(b.dateFrom));
  deduped.forEach((e,i)=>e.id=i+1);
  console.log(`✅ ${deduped.length} Events nach Deduplizierung`);

  const outPath = path.join(__dirname,"..","events.json");
  fs.writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    count: deduped.length,
    method: "kostenlos (ICS + RSS + HTML)",
    sources: ["DATEs Stadtmagazin","DATEs Umland","SC Magdeburg","1. FC Magdeburg","Landeshauptstadt Magdeburg","Sonntags-Flohmarkt","Meine Flohmarkt Termine","Flohmarkt.de","Magdeburg Tourist"],
    events: deduped,
  }, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events — KOSTENLOS!`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
