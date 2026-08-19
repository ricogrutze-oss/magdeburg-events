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
function unfoldICS(text) {
  // RFC5545: Zeilenumbrüche gefolgt von Leerzeichen/Tab sind reine Zeilenfaltung, kein echtes Zeilenende
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseICSDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  const y = raw.slice(0,4), mo = raw.slice(4,6), d = raw.slice(6,8);
  if (!/^\d{8}/.test(raw)) return null;
  return { dateStr: `${y}-${mo}-${d}`, hasTime: raw.includes("T"), timeStart: raw.includes("T") ? `${raw.slice(9,11)}:${raw.slice(11,13)}` : null };
}

function addDays(dateStr, days) {
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate()+days);
  return isoLocal(dt);
}

const DAY_MAP = {SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};

function daysBetween(fromStr, toStr) {
  const [fy,fm,fd] = fromStr.split("-").map(Number);
  const [ty,tm,td] = toStr.split("-").map(Number);
  return Math.round((new Date(ty,tm-1,td) - new Date(fy,fm-1,fd)) / 86400000);
}

function expandRRule(startDateStr, rruleStr, capUntil, windowStart) {
  const parts = {};
  rruleStr.split(";").forEach(p => { const [k,v] = p.split("="); if(k) parts[k]=v; });
  const freq = parts.FREQ;
  const interval = parseInt(parts.INTERVAL || "1") || 1;
  const untilParsed = parts.UNTIL ? parseICSDate(parts.UNTIL) : null;
  let until = untilParsed ? untilParsed.dateStr : capUntil;
  if (until > capUntil) until = capUntil;
  const count = parts.COUNT ? parseInt(parts.COUNT) : null;
  const byday = parts.BYDAY ? parts.BYDAY.split(",") : null;
  const dates = [];
  const maxIter = 400;

  if (freq === "DAILY" || (freq === "WEEKLY" && !(byday && byday.length))) {
    const stepDays = freq === "DAILY" ? interval : 7*interval;
    let cur = startDateStr, n = 0;
    // Läuft die Wiederholung schon lange (z.B. seit 2016) und hat kein COUNT-Limit,
    // rechnerisch direkt ins Zeitfenster vorspulen statt jede einzelne Wiederholung durchzuzählen
    if (!count && cur < windowStart) {
      const diffDays = daysBetween(cur, windowStart);
      const steps = Math.floor(diffDays / stepDays);
      if (steps > 0) cur = addDays(cur, steps*stepDays);
    }
    let iter = 0;
    while (iter++ < maxIter && cur <= until) {
      if (count && n >= count) break;
      if (cur >= windowStart) dates.push(cur);
      n++;
      cur = addDays(cur, stepDays);
    }
  } else if (freq === "WEEKLY" && byday && byday.length) {
    // Bei BYDAY nur ohne COUNT vorspulen (COUNT-Zählung bräuchte den echten Startpunkt)
    let cur = (!count && startDateStr < windowStart) ? windowStart : startDateStr;
    let iter = 0, n = 0;
    while (iter++ < maxIter && cur <= until) {
      if (count && n >= count) break;
      const [y,m,d] = cur.split("-").map(Number);
      const dow = new Date(y,m-1,d).getDay();
      const dowKey = Object.keys(DAY_MAP).find(k => DAY_MAP[k]===dow);
      if (byday.includes(dowKey)) { if (cur >= windowStart) dates.push(cur); n++; }
      cur = addDays(cur, 1);
    }
  } else {
    dates.push(startDateStr); // MONTHLY/YEARLY etc. nicht unterstützt — nur Starttermin
  }
  return dates;
}

function parseICS(text, sourceName, catOverride) {
  const events = [];
  const unfolded = unfoldICS(text);
  const blocks = unfolded.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i].split("END:VEVENT")[0];
    const get = k => { const m = b.match(new RegExp(k+"[^:\\n]*:([^\\r\\n]+)")); return m?m[1].trim():null; };
    const summary = get("SUMMARY"); if (!summary) continue;
    const dtstartRaw = get("DTSTART"); if (!dtstartRaw || dtstartRaw.length < 8) continue;
    const start = parseICSDate(dtstartRaw); if (!start) continue;
    const dtendRaw = get("DTEND");
    const rruleRaw = get("RRULE");
    const rdateRaw = get("RDATE");
    const exdateRaw = get("EXDATE");

    // Alle Kandidaten-Termine sammeln: Starttermin + RDATE-Liste + RRULE-Expansion
    let candidateDates = new Set([start.dateStr]);
    if (rdateRaw) rdateRaw.split(",").forEach(v => { const p = parseICSDate(v); if (p) candidateDates.add(p.dateStr); });
    if (rruleRaw) expandRRule(start.dateStr, rruleRaw, untilStr, todayStr).forEach(d => candidateDates.add(d));
    if (exdateRaw) exdateRaw.split(",").forEach(v => { const p = parseICSDate(v); if (p) candidateDates.delete(p.dateStr); });

    const isRecurring = !!(rdateRaw || rruleRaw);
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

    for (const dateFrom of candidateDates) {
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      let dateTo = dateFrom;
      if (!isRecurring && dtendRaw && dtendRaw.length >= 8 && !start.hasTime) {
        // Mehrtägiger Einzeltermin ohne Wiederholung (z.B. Ausstellung über X Tage)
        const end = parseICSDate(dtendRaw);
        if (end) {
          const [ey,em,ed] = end.dateStr.split("-").map(Number);
          const endD = new Date(ey, em-1, ed);
          endD.setDate(endD.getDate()-1);
          dateTo = isoLocal(endD);
        }
      }
      events.push({ name:cleanName, dateFrom, dateTo, timeStart: start.hasTime?start.timeStart:null, category:cat, location, sources:sourceName });
    }
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
      const description = getTag("description") || "";
      // Eventdatum steht meist in der Beschreibung (dd.mm.yyyy), NICHT im pubDate
      // (pubDate = Veröffentlichungsdatum des Artikels, nicht das Veranstaltungsdatum)
      const dateM = description.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      let dateFrom;
      if (dateM) {
        dateFrom = `${dateM[3]}-${dateM[2].padStart(2,"0")}-${dateM[1].padStart(2,"0")}`;
      } else {
        const pubDate = getTag("pubDate"); if (!pubDate) continue;
        const d = new Date(pubDate); if (isNaN(d)) continue;
        dateFrom = isoLocal(d);
      }
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
    // Seite wurde 2025/26 relauncht — neue URL-Struktur ohne "www", mit Bundesland+Kategorie-Pfad
    const data = await fetchUrl("https://meine-flohmarkt-termine.de/de/bundesland/sachsen-anhalt/veranstaltungsart/floh-troedelmarkt");
    const events = [];
    // Pro Eintrag: Link auf .../details mit Titel als Linktext, davor irgendwo "dd.mm.yyyy" und Ort/PLZ
    const re = /(\d{2})\.(\d{2})\.(\d{4})[\s\S]{0,300}?<a[^>]+href="(https:\/\/meine-flohmarkt-termine\.de\/[^"]+\/details)"[^>]*>([^<]{5,120})<\/a>[\s\S]{0,300}?(\d{5})\s+([^,<]{2,60}),/gi;
    let m;
    while ((m = re.exec(data)) !== null && events.length < 40) {
      const dateFrom = `${m[3]}-${m[2]}-${m[1]}`;
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      const ort = m[7].trim();
      if (!/magdeburg/i.test(ort)) continue; // nur Magdeburg selbst, Umland kommt über DATEs Umland
      events.push({
        name: m[5].trim().slice(0,200), dateFrom, dateTo:dateFrom,
        timeStart: null, category:"Flohmarkt",
        location: `${ort}, ${m[6]}`, sources:"Meine Flohmarkt Termine"
      });
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

const MONTHS_DE = {"januar":1,"februar":2,"märz":3,"maerz":3,"april":4,"mai":5,"juni":6,"juli":7,"august":8,"september":9,"oktober":10,"november":11,"dezember":12};
function parseGermanShortDate(day, monthName, timeStr) {
  // Datum ohne Jahr ("16. August" / "16. August, 10:00 Uhr") -> nächstes passendes Jahr ermitteln
  const mo = MONTHS_DE[monthName.toLowerCase()];
  if (!mo) return null;
  let year = today.getFullYear();
  let d = new Date(year, mo-1, parseInt(day));
  if (d < today) d = new Date(year+1, mo-1, parseInt(day));
  return { dateFrom: isoLocal(d), timeStart: timeStr || null };
}

async function fetchMagdeburgTourist() {
  console.log("\n🔍 Magdeburg Tourist (HTML)...");
  try {
    // Altes CMS (index.php) ist tot/veraltet — echtes Kalendersystem läuft über diese Subdomain (RCE-Event)
    const data = await fetchUrl("https://veranstaltungen.magdeburg-tourist.de/magdeburg/");
    const events = [];
    // Pro Eintrag: Titel-Link, dann "DD. Monat[, HH:MM Uhr] | Ort | Stadt"-Zeile mit gleichem Link
    const re = /<a[^>]+href="(https?:\/\/veranstaltungen\.magdeburg-tourist\.de\/magdeburg\/[^"]+\.html)"[^>]*>([^<]{5,150})<\/a>[\s\S]{0,200}?(\d{1,2})\.\s*([A-Za-zäöüÄÖÜß]+)(?:,\s*(\d{1,2}:\d{2})\s*Uhr)?\s*\|\s*([^|<]{2,80})\s*\|\s*([^<]{2,40})/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(data)) !== null && events.length < 40) {
      const url = m[1];
      if (seen.has(url)) continue; // Titel-Link + Zeilen-Link zeigen aufs selbe Event
      seen.add(url);
      const name = m[2].trim();
      const parsed = parseGermanShortDate(m[3], m[4], m[5]);
      if (!parsed) continue;
      const { dateFrom, timeStart } = parsed;
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      events.push({
        name: name.slice(0,200), dateFrom, dateTo:dateFrom, timeStart,
        category:"Kultur", location: `${m[6].trim()}, ${m[7].trim()}`, sources:"Magdeburg Tourist"
      });
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
    sources: ["DATEs Stadtmagazin","DATEs Umland","SC Magdeburg","Landeshauptstadt Magdeburg","Sonntags-Flohmarkt","Meine Flohmarkt Termine","Flohmarkt.de","Magdeburg Tourist"],
    events: deduped,
  }, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events — KOSTENLOS!`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
