// generate-events.js — Magdeburg Events (Komplett kostenlos)
// Liest ICS-Feeds + HTML-Scraping — kein API nötig
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const today = new Date();
today.setHours(0,0,0,0);
const todayStr = isoLocal(today);
const until = new Date(); until.setDate(until.getDate() + 90);
const untilStr = isoLocal(until);

console.log(`🏰 Magdeburg Events — Kostenloser Abruf`);
console.log(`📅 ${new Date().toISOString()}`);
console.log(`📆 ${todayStr} bis ${untilStr}`);

function isoLocal(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth()+1).padStart(2,"0") + "-" +
    String(d.getDate()).padStart(2,"0");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP Fetch ────────────────────────────────────────────────────────────────
function fetchUrl(url, maxSize=500000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MagdeburgEvents/1.0)",
        "Accept": "text/html,application/xhtml+xml,text/calendar,application/xml,*/*",
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, maxSize).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > maxSize) res.destroy(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── ICS Parser ────────────────────────────────────────────────────────────────
function parseICS(icsText, sourceName) {
  const events = [];
  const blocks = icsText.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const m = block.match(new RegExp(`${key}[^:]*:([^\\r\\n]+)`));
      return m ? m[1].trim() : null;
    };
    const summary = get("SUMMARY");
    if (!summary) continue;

    // Datum parsen
    const dtstart = get("DTSTART");
    if (!dtstart) continue;

    let dateFrom, timeStart = null;
    if (dtstart.length >= 8) {
      const y = dtstart.slice(0,4);
      const mo = dtstart.slice(4,6);
      const d = dtstart.slice(6,8);
      dateFrom = `${y}-${mo}-${d}`;
      if (dtstart.includes("T") && dtstart.length >= 15) {
        const t = dtstart.slice(9,15);
        timeStart = `${t.slice(0,2)}:${t.slice(2,4)}`;
      }
    } else continue;

    // Enddatum
    const dtend = get("DTEND");
    let dateTo = dateFrom;
    if (dtend && dtend.length >= 8) {
      const y = dtend.slice(0,4);
      const mo = dtend.slice(4,6);
      const d = dtend.slice(6,8);
      const endDate = `${y}-${mo}-${d}`;
      // Bei ganztägigen Events ist DTEND der Tag danach
      if (!dtstart.includes("T")) {
        const endD = new Date(parseInt(y), parseInt(mo)-1, parseInt(d));
        endD.setDate(endD.getDate() - 1);
        dateTo = isoLocal(endD);
      } else {
        dateTo = endDate;
      }
    }

    // Nur zukünftige Events
    if (dateFrom < todayStr || dateFrom > untilStr) continue;

    const location = get("LOCATION") || "Magdeburg";
    const desc = get("DESCRIPTION") || "";

    // Kategorie erraten
    let category = "Sonstiges";
    const text = (summary + " " + desc + " " + location).toLowerCase();
    if (/konzert|musik|band|live|jazz|rock|pop|electronic|party|dj/.test(text)) category = "Musik";
    else if (/theater|oper|ballett|schauspiel|kabarett|comedy|lesung/.test(text)) category = "Theater";
    else if (/flohmarkt|trödelmarkt|trodel|markt/.test(text)) category = "Flohmarkt";
    else if (/sport|fußball|handball|laufen|turnier|spiel/.test(text)) category = "Sport";
    else if (/kinder|familie|jugend|zoo|dinosaur/.test(text)) category = "Familie";
    else if (/festival|stadtfest|volksfest|messe|ausstellung|kunst|museum/.test(text)) category = "Kultur";

    events.push({
      name: summary.replace(/\\n/g," ").replace(/\\,/g,",").slice(0,200),
      dateFrom, dateTo, timeStart, category,
      location: location.replace(/\\n/g," ").replace(/\\,/g,",").slice(0,100),
      sources: sourceName,
    });
  }
  return events;
}

// ── RSS Parser ────────────────────────────────────────────────────────────────
function parseRSS(rssText, sourceName) {
  const events = [];
  const items = rssText.split("<item>");
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const getTag = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`));
      return m ? (m[1] || m[2] || "").trim() : null;
    };
    const title = getTag("title");
    if (!title || title.length < 3) continue;

    // Datum aus pubDate
    const pubDate = getTag("pubDate");
    if (!pubDate) continue;
    const d = new Date(pubDate);
    if (isNaN(d)) continue;
    const dateFrom = isoLocal(d);
    if (dateFrom < todayStr || dateFrom > untilStr) continue;

    events.push({
      name: title.slice(0,200),
      dateFrom, dateTo: dateFrom,
      timeStart: null, category: "Sonstiges",
      location: "Magdeburg", sources: sourceName,
    });
  }
  return events;
}

// ── HTML Scraper Helfer ───────────────────────────────────────────────────────
function extractText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ").replace(/&#\d+;/g," ").replace(/\s+/g," ").trim();
}

function findDates(text) {
  // DD.MM.YYYY oder YYYY-MM-DD
  const matches = [];
  const re1 = /(\d{2})\.(\d{2})\.(\d{4})/g;
  const re2 = /(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    matches.push(`${m[3]}-${m[2]}-${m[1]}`);
  }
  while ((m = re2.exec(text)) !== null) {
    matches.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return matches.filter(d => d >= todayStr && d <= untilStr);
}

function findTime(text) {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(Uhr)?/);
  if (m) return `${m[1].padStart(2,"0")}:${m[2]}`;
  return null;
}

// ── QUELLEN ───────────────────────────────────────────────────────────────────

async function fetchDatesICS() {
  console.log("\n🔍 DATEs Stadtmagazin (ICS)...");
  try {
    const ics = await fetchUrl("https://www.dates-md.de/search/event/veranstaltungen-magdeburg/calendar.ics");
    const events = parseICS(ics, "DATEs Stadtmagazin");
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMagdeburgRSS() {
  console.log("\n🔍 Magdeburg.de (RSS)...");
  try {
    const rss = await fetchUrl("https://www.magdeburg.de/index.php?object=rss,37.7773.1&La=1");
    const events = parseRSS(rss, "Landeshauptstadt Magdeburg");
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchSCMICS() {
  console.log("\n🔍 SC Magdeburg Handball (ICS)...");
  try {
    const ics = await fetchUrl("https://calovo.de/f/scm-handball/spielplan.ics");
    const raw = parseICS(ics, "SC Magdeburg");
    const events = raw.map(e => ({...e, category:"Sport", name: e.name.replace("| Opel HBL |","").replace("| EHF Champions League Men 2026/2027 |","").trim()}));
    console.log(`  ✅ ${events.length} Spiele`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFCMICS() {
  console.log("\n🔍 1. FC Magdeburg (ICS)...");
  try {
    const ics = await fetchUrl("https://calovo.de/f/fcmagdeburg/spielplan.ics");
    const raw = parseICS(ics, "1. FC Magdeburg");
    const events = raw.map(e => ({...e, category:"Sport"}));
    console.log(`  ✅ ${events.length} Spiele`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFlohmarktRSS() {
  console.log("\n🔍 Flohmarkt-Termine (ICS)...");
  try {
    const ics = await fetchUrl("https://meine-flohmarkt-termine.de/ort/magdeburg.ics");
    const events = parseICS(ics, "Meine Flohmarkt Termine");
    const filtered = events.map(e => ({...e, category:"Flohmarkt"}));
    console.log(`  ✅ ${filtered.length} Flohmärkte`);
    return filtered;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchTheater() {
  console.log("\n🔍 Theater Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://www.theater-magdeburg.de/spielplan/spielplan");
    const events = [];
    // Events aus strukturiertem HTML extrahieren
    const blocks = html.split(/class="[^"]*event[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 50; i++) {
      const block = blocks[i].slice(0, 1000);
      const titleM = block.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)/i) ||
                     block.match(/<h[23][^>]*>([^<]+)/i) ||
                     block.match(/<strong[^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0],
        dateTo: dates[dates.length-1], timeStart: findTime(block),
        category: "Theater", location: "Theater Magdeburg", sources: "Theater Magdeburg"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMoritzhof() {
  console.log("\n🔍 Moritzhof (HTML)...");
  try {
    const html = await fetchUrl("https://www.moritzhof-magdeburg.de/programm");
    const events = [];
    const blocks = html.split(/class="[^"]*event[^"]*"|class="[^"]*program[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 40; i++) {
      const block = blocks[i].slice(0, 800);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i) || block.match(/<strong[^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0],
        dateTo: dates[0], timeStart: findTime(block),
        category: "Kultur", location: "Moritzhof Magdeburg", sources: "Kulturzentrum Moritzhof"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchElbauenpark() {
  console.log("\n🔍 Elbauenpark (HTML)...");
  try {
    const html = await fetchUrl("https://www.elbauenpark.de/de/events");
    const events = [];
    const blocks = html.split(/class="[^"]*event[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 30; i++) {
      const block = blocks[i].slice(0, 800);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i) || block.match(/<strong[^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0],
        dateTo: dates[dates.length-1], timeStart: findTime(block),
        category: "Kultur", location: "Elbauenpark Magdeburg", sources: "Elbauenpark & Seebühne"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMVGM() {
  console.log("\n🔍 MVGM / Messe Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://www.mvgm.de/de/events/");
    const events = [];
    // MVGM hat strukturierte Event-Cards
    const datePattern = /(\d{2})\s*\.\s*([A-Za-zäöü]+)\s*\.\s*(\d{4})/g;
    const monthMap = {jan:1,feb:2,"mär":3,mar:3,apr:4,mai:5,jun:6,jul:7,aug:8,sep:9,okt:10,nov:11,dez:12};
    const blocks = html.split(/class="[^"]*event[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 30; i++) {
      const block = blocks[i].slice(0, 1000);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      // MVGM nutzt "05 · Jul · Konzert" Format
      const dates = findDates(block);
      if (!dates.length) continue;
      let cat = "Kultur";
      const t = title.toLowerCase();
      if (/konzert|musik/.test(t)) cat = "Musik";
      else if (/kinder|familie/.test(t)) cat = "Familie";
      else if (/sport/.test(t)) cat = "Sport";
      events.push({
        name: title.slice(0,200), dateFrom: dates[0],
        dateTo: dates[dates.length-1], timeStart: findTime(block),
        category: cat, location: "MVGM Magdeburg", sources: "MVGM (GETEC Arena, Messe, AMO)"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchZoo() {
  console.log("\n🔍 Zoo Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://www.zoo-magdeburg.de/veranstaltungen/");
    const events = [];
    const blocks = html.split(/<article|<div class="[^"]*event/i);
    for (let i = 1; i < blocks.length && events.length < 20; i++) {
      const block = blocks[i].slice(0, 1000);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3 || title.toLowerCase().includes("veranstaltung")) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0],
        dateTo: dates[0], timeStart: findTime(block),
        category: "Familie", location: "Zoo Magdeburg", sources: "Zoo Magdeburg"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchMagdeboogie() {
  console.log("\n🔍 Magdeboogie (HTML)...");
  try {
    const html = await fetchUrl("https://magdeboogie.de/heute/");
    const events = [];
    // WordPress EventON Plugin — Events haben data-attributes
    const re = /data-event-start="(\d+)"[\s\S]{0,500}?<[^>]*class="[^"]*evcal_event_title[^"]*"[^>]*>([^<]+)/gi;
    let m;
    while ((m = re.exec(html)) !== null && events.length < 40) {
      const ts = parseInt(m[1]) * 1000;
      const d = new Date(ts);
      const dateFrom = isoLocal(d);
      if (dateFrom < todayStr || dateFrom > untilStr) continue;
      const title = extractText(m[2]).trim();
      if (title.length < 3) continue;
      events.push({
        name: title.slice(0,200), dateFrom, dateTo: dateFrom,
        timeStart: null, category: "Musik",
        location: "Magdeburg", sources: "Magdeboogie"
      });
    }
    // Fallback: Datum-basiert
    if (events.length === 0) {
      const blocks = html.split(/class="[^"]*event[^"]*"/i);
      for (let i = 1; i < blocks.length && events.length < 30; i++) {
        const block = blocks[i].slice(0, 600);
        const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i) || block.match(/<strong[^>]*>([^<]+)/i);
        if (!titleM) continue;
        const title = extractText(titleM[1]).trim();
        if (title.length < 3) continue;
        const dates = findDates(block);
        if (!dates.length) continue;
        events.push({
          name: title.slice(0,200), dateFrom: dates[0], dateTo: dates[0],
          timeStart: findTime(block), category: "Musik",
          location: "Magdeburg", sources: "Magdeboogie"
        });
      }
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFactory() {
  console.log("\n🔍 Factory Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://factory-magdeburg.de/programm");
    const events = [];
    const blocks = html.split(/class="[^"]*event[^"]*"|class="[^"]*program[^"]*"/i);
    for (let i = 1; i < blocks.length && events.length < 30; i++) {
      const block = blocks[i].slice(0, 600);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i) || block.match(/<strong[^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0], dateTo: dates[0],
        timeStart: findTime(block), category: "Musik",
        location: "Factory Magdeburg", sources: "Factory Magdeburg"
      });
    }
    console.log(`  ✅ ${events.length} Events`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchSonntagsFlohmarkt() {
  console.log("\n🔍 Sonntags-Flohmarkt (HTML)...");
  try {
    const html = await fetchUrl("https://familienhaus-magdeburg.de/standorte/magdeburger-sonntags-flohmarkt/");
    const events = [];
    const dates = findDates(html);
    const unique = [...new Set(dates)].filter(d => d >= todayStr && d <= untilStr);
    for (const d of unique.slice(0, 6)) {
      events.push({
        name: "Magdeburger Sonntags-Flohmarkt", dateFrom: d, dateTo: d,
        timeStart: "10:00", category: "Flohmarkt",
        location: "Wissenschaftshafen, Sarajevo-Ufer, Magdeburg",
        sources: "Familienhaus Magdeburg"
      });
    }
    console.log(`  ✅ ${events.length} Termine`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFlohmarktDE() {
  console.log("\n🔍 Flohmarkt.de Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://www.flohmarkt.de/magdeburg");
    const events = [];
    const blocks = html.split(/<article|<li class="[^"]*market/i);
    for (let i = 1; i < blocks.length && events.length < 20; i++) {
      const block = blocks[i].slice(0, 800);
      const titleM = block.match(/<h[1-4][^>]*>([^<]+)/i) || block.match(/<a[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0], dateTo: dates[0],
        timeStart: findTime(block), category: "Flohmarkt",
        location: "Magdeburg", sources: "Flohmarkt.de"
      });
    }
    console.log(`  ✅ ${events.length} Flohmärkte`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

async function fetchFlohmarktKalender() {
  console.log("\n🔍 Flohmarktkalender Magdeburg (HTML)...");
  try {
    const html = await fetchUrl("https://www.flohmarktkalender.de/magdeburg");
    const events = [];
    const blocks = html.split(/<tr|<article|<li class="[^"]*event/i);
    for (let i = 1; i < blocks.length && events.length < 20; i++) {
      const block = blocks[i].slice(0, 600);
      const text = extractText(block);
      if (text.length < 5) continue;
      const dates = findDates(block);
      if (!dates.length) continue;
      const titleM = block.match(/<a[^>]*>([^<]{5,80})<\/a>/i) || block.match(/<td[^>]*>([^<]{5,80})<\/td>/i);
      if (!titleM) continue;
      const title = extractText(titleM[1]).trim();
      if (title.length < 3) continue;
      events.push({
        name: title.slice(0,200), dateFrom: dates[0], dateTo: dates[0],
        timeStart: null, category: "Flohmarkt",
        location: "Magdeburg Umkreis", sources: "Flohmarktkalender"
      });
    }
    console.log(`  ✅ ${events.length} Flohmärkte`);
    return events;
  } catch(e) { console.log(`  ⚠️ ${e.message}`); return []; }
}

// ── Deduplizierung ────────────────────────────────────────────────────────────
function similarity(a, b) {
  if (!a || !b) return 0;
  const w = s => new Set(s.toLowerCase().replace(/[^a-zäöü0-9 ]/g,"").split(/\s+/).filter(w=>w.length>2));
  const wA = w(a), wB = w(b);
  if (!wA.size || !wB.size) return 0;
  const inter = [...wA].filter(x => wB.has(x)).length;
  return inter / new Set([...wA,...wB]).size;
}

function dedup(events) {
  const result = [], merged = new Set();
  for (let i = 0; i < events.length; i++) {
    if (merged.has(i)) continue;
    const base = {...events[i]};
    const srcs = new Set((base.sources||"").split(",").map(s=>s.trim()));
    for (let j = i+1; j < events.length; j++) {
      if (merged.has(j)) continue;
      const other = events[j];
      if (base.dateFrom === other.dateFrom && similarity(base.name, other.name) > 0.6) {
        (other.sources||"").split(",").forEach(s => srcs.add(s.trim()));
        if (!base.timeStart && other.timeStart) base.timeStart = other.timeStart;
        merged.add(j);
      }
    }
    base.sources = [...srcs].filter(Boolean).join(", ");
    result.push(base);
  }
  return result;
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────
async function main() {
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];

  // Alle Quellen abrufen
  const results = await Promise.allSettled([
    fetchDatesICS(),
    fetchMagdeburgRSS(),
    fetchSCMICS(),
    fetchFCMICS(),
    fetchFlohmarktRSS(),
    fetchTheater(),
    fetchMoritzhof(),
    fetchElbauenpark(),
    fetchMVGM(),
    fetchZoo(),
    fetchMagdeboogie(),
    fetchFactory(),
    fetchSonntagsFlohmarkt(),
    fetchFlohmarktDE(),
    fetchFlohmarktKalender(),
  ]);

  let allEvents = [];
  let successCount = 0;

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.length > 0) {
      successCount++;
      r.value.forEach(e => {
        if (!e.name || !e.dateFrom) return;
        allEvents.push({
          name: String(e.name).slice(0,200),
          dateFrom: e.dateFrom,
          dateTo: e.dateTo || e.dateFrom,
          timeStart: e.timeStart || null,
          category: validCats.includes(e.category) ? e.category : "Sonstiges",
          location: e.location || "Magdeburg",
          sources: e.sources || "Unbekannt",
        });
      });
    }
  }

  console.log(`\n📊 ${successCount}/15 Quellen erfolgreich`);
  console.log(`📊 ${allEvents.length} Events gesammelt`);

  const deduped = dedup(allEvents);
  deduped.sort((a,b) => a.dateFrom.localeCompare(b.dateFrom));
  deduped.forEach((e,i) => e.id = i+1);

  console.log(`✅ ${deduped.length} Events nach Deduplizierung`);

  const outPath = path.join(__dirname, "..", "events.json");
  const output = {
    generated: new Date().toISOString(),
    count: deduped.length,
    method: "kostenlos (ICS + RSS + HTML-Scraping)",
    sources: [
      "DATEs Stadtmagazin", "Landeshauptstadt Magdeburg",
      "SC Magdeburg", "1. FC Magdeburg", "Flohmarkt-Termine",
      "Theater Magdeburg", "Moritzhof", "Elbauenpark",
      "MVGM", "Zoo Magdeburg", "Magdeboogie",
      "Factory Magdeburg", "Sonntags-Flohmarkt",
      "Flohmarkt.de", "Flohmarktkalender"
    ],
    events: deduped,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events gespeichert — KOSTENLOS!`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
