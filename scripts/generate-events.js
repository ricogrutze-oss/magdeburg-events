// generate-events.js — Magdeburg Events v7
// Pro Quelle ein eigener API-Aufruf — maximale Qualität, nichts wird übersprungen
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("❌ ANTHROPIC_API_KEY nicht gesetzt!"); process.exit(1); }

const sourcesPath = path.join(__dirname, "..", "sources.json");
const sources     = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
console.log(`📋 ${sources.length} Quellen geladen — jede wird einzeln abgefragt`);

const today = new Date().toISOString().split("T")[0];
const until = new Date(); until.setDate(until.getDate() + 60);
const untilStr = until.toISOString().split("T")[0];

// Kategorie automatisch aus Quellenname/URL erkennen
function guessCategory(source) {
  const t = (source.name + " " + source.url + " " + (source.beschreibung||"")).toLowerCase();
  if (/flohmarkt|trödelmarkt|trodel|markt|kleinanzeigen/.test(t)) return "Flohmarkt";
  if (/theater|oper|ballett|schauspiel|moritzhof|kulturzentrum|museum|ausstellung/.test(t)) return "Theater";
  if (/konzert|musik|band|factory|stadthalle|eventim|bandsintown/.test(t)) return "Musik";
  if (/familie|kinder|jugend|spielplatz/.test(t)) return "Familie";
  if (/sport|fußball|laufen|fitness/.test(t)) return "Sport";
  if (/festival|stadtfest|volksfest|elbauenpark|seebühne/.test(t)) return "Kultur";
  return null; // Alle Kategorien suchen
}

// Umkreis für Flohmarkt-Quellen
function needsUmkreis(source) {
  const t = (source.name + " " + source.url).toLowerCase();
  return /flohmarkt|trödelmarkt|kleinanzeigen/.test(t);
}

function buildPrompt(source, existingEvents) {
  const cat = guessCategory(source);
  const umkreis = needsUmkreis(source);

  const gebiet = umkreis
    ? `Magdeburg UND Umkreis 30km (Schönebeck, Staßfurt, Bernburg, Haldensleben, Wolmirstedt, Zerbst, Burg, Barleben, Gommern, Oschersleben, Egeln, Calbe)`
    : `Magdeburg Sachsen-Anhalt`;

  const catFilter = cat
    ? `Suche NUR nach Kategorie: ${cat}`
    : `Suche nach allen Veranstaltungstypen (Musik, Theater, Sport, Kultur, Familie, Flohmärkte)`;

  // Bekannte Events NUR von dieser Quelle überspringen — spart Token
  const known = existingEvents
    .filter(e => {
      const src = (e.sources||"").toLowerCase();
      return src.includes(source.name.toLowerCase()) ||
             src.includes(source.url.toLowerCase().split('/')[0]);
    })
    .map(e => `${e.name} ${e.dateFrom}`)
    .slice(0, 15)
    .join(" | ");

  const knownSection = known
    ? `\nBEREITS BEKANNTE EVENTS — nicht nochmal zurückgeben:\n${known}\n`
    : "";

  return `Rufe die folgende Webseite auf und extrahiere alle Veranstaltungen:

QUELLE: ${source.url}
BESCHREIBUNG: ${source.beschreibung || source.name}

Suche nach Veranstaltungen in ${gebiet} vom ${today} bis ${untilStr}.
${catFilter}
${knownSection}
REGELN:
- Nur KONKRETE EINZELTERMINE mit genauen Daten
- KEINE Dauerveranstaltungen (jeden Mittwoch, täglich usw.)
- Wiederkehrende Events: jeden Termin einzeln eintragen
- dateFrom und dateTo max 3 Tage auseinander (außer echte mehrtägige Festivals)
- Genauen Ort im Feld location angeben

Antworte NUR mit JSON-Array direkt beginnend mit [:
[{"id":1,"name":"Eventname","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","timeStart":"HH:MM oder null","category":"Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges","location":"Genauer Ort","sources":"${source.name}"}]

Finde alle Einzeltermine auf dieser Seite.`;
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
        // Quellen zusammenführen
        const srcA = (base.sources||"").split(",").map(s=>s.trim());
        const srcB = (other.sources||"").split(",").map(s=>s.trim());
        base.sources = [...new Set([...srcA,...srcB])].filter(Boolean).join(", ");
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
      max_tokens: 4000,
      system: "Du bist ein Datenassistent. Antworte AUSSCHLIESSLICH mit einem JSON-Array. Beginne direkt mit [. Kein Text davor oder danach.",
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

async function fetchSource(source, existingEvents) {
  console.log(`\n🔍 ${source.name} (${source.url})...`);
  try {
    const response = await callClaude(buildPrompt(source, existingEvents));
    if (response.error) {
      console.log(`  ⚠️ API Fehler: ${response.error.message}`);
      return [];
    }
    const fullText = (response.content || []).map(b => b.type === "text" ? b.text : "").join("\n");
    if (!fullText.trim()) { console.log(`  ⚠️ Leere Antwort`); return []; }
    const fixed = fixJson(fullText);
    if (!fixed) { console.log(`  ⚠️ Kein JSON`); return []; }
    let events;
    try { events = JSON.parse(fixed); } catch(e) { console.log(`  ⚠️ JSON ungültig`); return []; }
    if (!Array.isArray(events)) return [];

    // Dauerveranstaltungen filtern
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
  console.log("🏰 Magdeburg Events v7 — Pro-Quelle-Suche");
  console.log("📅", new Date().toISOString());
  console.log(`📆 ${today} bis ${untilStr}`);

  // Alte Events laden
  const outPath = path.join(__dirname, "..", "events.json");
  let existingEvents = [];
  if (fs.existsSync(outPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(outPath, "utf8"));
      existingEvents = (old.events || []).filter(e => e.dateTo >= today);
      console.log(`📂 ${existingEvents.length} bestehende Events geladen`);
    } catch(e) {
      console.log("⚠️ Alte events.json nicht lesbar — starte frisch");
    }
  }

  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  let newEvents = [];
  let successCount = 0;

  // Jede Quelle einzeln abfragen
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const raw = await fetchSource(source, existingEvents);

    raw.forEach(e => {
      if (!e.name || !e.dateFrom) return;
      const cat = e.category && validCats.includes(e.category)
        ? e.category
        : (guessCategory(source) || "Sonstiges");
      newEvents.push({
        name:      String(e.name).slice(0, 200),
        dateFrom:  e.dateFrom,
        dateTo:    e.dateTo || e.dateFrom,
        timeStart: e.timeStart || null,
        category:  cat,
        location:  e.location || "Magdeburg",
        sources:   e.sources || source.name,
      });
    });

    if (raw.length > 0) successCount++;

    // 2 Sekunden warten zwischen Anfragen
    if (i < sources.length - 1) await sleep(2000);
  }

  console.log(`\n📊 ${successCount}/${sources.length} Quellen erfolgreich`);
  console.log(`📊 ${existingEvents.length} alte + ${newEvents.length} neue = ${existingEvents.length + newEvents.length} gesamt`);

  const combined = [...existingEvents, ...newEvents];
  const deduped = dedup(combined);
  deduped.forEach((e, i) => e.id = i + 1);
  deduped.sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));

  const added = deduped.length - existingEvents.length;
  console.log(`✅ ${deduped.length} Events gesamt (+${Math.max(0,added)} neu)`);

  const output = {
    generated: new Date().toISOString(),
    count: deduped.length,
    sources: sources.map(s => s.name),
    events: deduped,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events gespeichert.`);
}

main().catch(err => {
  console.error("❌ Kritischer Fehler:", err.message);
  process.exit(1);
});
