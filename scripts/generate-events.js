// generate-events.js — Magdeburg Events v6
// 5 Aufrufe pro Kategorie — nur konkrete Einzeltermine, keine Dauerveranstaltungen
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("❌ ANTHROPIC_API_KEY nicht gesetzt!"); process.exit(1); }

const sourcesPath = path.join(__dirname, "..", "sources.json");
const sources     = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
console.log(`📋 ${sources.length} Quellen geladen`);

const today = new Date().toISOString().split("T")[0];
const until = new Date(); until.setDate(until.getDate() + 60);
const untilStr = until.toISOString().split("T")[0];

// Flohmarkt-Quellen extra hervorheben
const flohmarktSources = sources
  .filter(s => s.name.toLowerCase().includes('flohmarkt') || s.name.toLowerCase().includes('kleinanzeigen'))
  .map(s => `- ${s.url} (${s.name})`).join("\n");

const allSourceList = sources.map(s => `- ${s.url} (${s.name})`).join("\n");

const CATEGORIES = [
  { name: "Familie & Kinder",     cat: "Familie",   keywords: "Familie Kinder Jugend Kinderfest Familientag Spielplatz" },
  {
    name: "Flohmärkte & Märkte",
    cat: "Flohmarkt",
    keywords: "Flohmarkt Trödelmarkt Markt Straßenfest Bauernmarkt",
    extraSources: flohmarktSources,
    umkreis: true
  },
  { name: "Musik & Konzerte",     cat: "Musik",     keywords: "Konzert Musik Band Live Open-Air Musikfestival" },
  { name: "Theater & Kultur",     cat: "Theater",   keywords: "Theater Oper Ballett Schauspiel Ausstellung Museum Lesung" },
  { name: "Festivals & Sport",    cat: "Kultur",    keywords: "Festival Stadtfest Volksfest Sport Fußball Laufen" },
];

function buildPrompt(category) {
  const sources = category.extraSources
    ? `Durchsuche BESONDERS diese spezialisierten Quellen:\n${category.extraSources}\n\nUnd auch:\n${allSourceList}`
    : `Durchsuche:\n${allSourceList}`;

  const gebiet = category.umkreis
    ? `Magdeburg UND Umkreis 30km (Schönebeck, Staßfurt, Bernburg, Haldensleben, Wolmirstedt, Zerbst, Burg, Barleben, Gommern, Oschersleben, Egeln, Calbe)`
    : `Magdeburg Sachsen-Anhalt`;

  return `Suche im Web nach "${category.keywords}" Veranstaltungen in ${gebiet} vom ${today} bis ${untilStr}.

${sources}

WICHTIGE REGELN:
- Nur KONKRETE EINZELTERMINE mit genauen Daten
- KEINE Dauerveranstaltungen wie "jeden Mittwoch" oder "täglich"
- Wenn ein Wochenmarkt jeden Mittwoch stattfindet: jeden einzelnen Mittwoch als SEPARATEN Termin eintragen (z.B. 09.07., 16.07., 23.07., 30.07.)
- Wenn ein Event "vom 1. bis 31." läuft aber nur bestimmte Tage: nur die konkreten Tage eintragen
- dateFrom und dateTo dürfen maximal 3 Tage auseinanderliegen (außer bei Festivals die wirklich mehrere Tage durchgehend laufen)
- Im Feld "location" immer den genauen Ort angeben (z.B. "Schönebeck" oder "Zerbst", nicht nur "Magdeburg")

Antworte NUR mit einem JSON-Array. Direkt mit [ beginnen.
Format: [{"id":1,"name":"Eventname","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","timeStart":"HH:MM oder null","category":"${category.cat}","location":"Genauer Ort"}]
Finde so viele echte Einzeltermine wie möglich.`;
}

function fixJson(text) {
  if (!text || typeof text !== "string") return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let json = text.slice(start, end + 1);
  json = json
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " ")
    .replace(/\t/g, " ").replace(/\\n/g, " ").replace(/\\t/g, " ")
    .replace(/\s+/g, " ");
  return json;
}

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
    for (let j = i+1; j < events.length; j++) {
      if (merged.has(j)) continue;
      const other = events[j];
      if (base.dateFrom === other.dateFrom && similarity(base.name, other.name) > 0.6) {
        if (!base.timeStart && other.timeStart) base.timeStart = other.timeStart;
        merged.add(j);
      }
    }
    result.push(base);
  }
  return result;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: "Du bist ein Datenassistent. Antworte AUSSCHLIESSLICH mit einem JSON-Array. Beginne direkt mit [ und ende mit ]. Kein Text davor oder danach.",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,200))); }
      });
    });
    req.on("error", err => { console.error("  ⚠️ Netzwerkfehler:", err.message); resolve({ content: [] }); });
    req.write(body);
    req.end();
  });
}

async function fetchCategory(category) {
  console.log(`\n🔍 Suche: ${category.name}...`);
  try {
    const response = await callClaude(buildPrompt(category));
    if (response.error) { console.log(`  ⚠️ API Fehler: ${response.error.message}`); return []; }
    const fullText = (response.content || []).map(b => b.type === "text" ? b.text : "").join("\n");
    if (!fullText.trim()) { console.log(`  ⚠️ Leere Antwort`); return []; }
    const fixed = fixJson(fullText);
    if (!fixed) { console.log(`  ⚠️ Kein JSON`); return []; }
    let events;
    try { events = JSON.parse(fixed); } catch(e) { console.log(`  ⚠️ JSON ungültig`); return []; }
    if (!Array.isArray(events)) { console.log(`  ⚠️ Kein Array`); return []; }

    // Dauerveranstaltungen filtern: dateFrom und dateTo max 3 Tage auseinander
    // AUSNAHME: Festivals die wirklich mehrere Tage laufen (name enthält "festival", "messe", etc.)
    const filtered = events.filter(e => {
      if (!e.dateFrom || !e.dateTo) return true;
      const diff = (new Date(e.dateTo) - new Date(e.dateFrom)) / (1000*60*60*24);
      const isFestival = /festival|messe|woche|openair|open.air/i.test(e.name||"");
      return diff <= 3 || isFestival;
    });

    const removed = events.length - filtered.length;
    if (removed > 0) console.log(`  🗑 ${removed} Dauerveranstaltungen gefiltert`);
    console.log(`  ✅ ${filtered.length} Events`);
    return filtered;
  } catch(e) {
    console.log(`  ⚠️ Fehler: ${e.message}`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("🏰 Magdeburg Events — Starte Suche");
  console.log("📅", new Date().toISOString());
  console.log(`📆 ${today} bis ${untilStr}`);

  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  let allEvents = [];

  for (let i = 0; i < CATEGORIES.length; i++) {
    const category = CATEGORIES[i];
    const raw = await fetchCategory(category);
    raw.forEach(e => {
      if (!e.name || !e.dateFrom) return;
      allEvents.push({
        name:      String(e.name).slice(0, 200),
        dateFrom:  e.dateFrom,
        dateTo:    e.dateTo || e.dateFrom,
        timeStart: e.timeStart || null,
        category:  validCats.includes(e.category) ? e.category : category.cat,
        location:  e.location || "Magdeburg",
      });
    });
    if (i < CATEGORIES.length - 1) {
      console.log("  ⏳ 3 Sekunden warten...");
      await sleep(3000);
    }
  }

  console.log(`\n📊 Gesamt: ${allEvents.length} Events`);
  const deduped = dedup(allEvents);
  deduped.forEach((e, i) => e.id = i + 1);
  deduped.sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
  console.log(`✅ Nach Deduplizierung: ${deduped.length} Events`);

  const output = {
    generated: new Date().toISOString(),
    count: deduped.length,
    sources: sources.map(s => s.name),
    events: deduped,
  };

  const outPath = path.join(__dirname, "..", "events.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events gespeichert.`);
}

main().catch(err => {
  console.error("❌ Kritischer Fehler:", err.message);
  process.exit(1);
});
