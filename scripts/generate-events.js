// generate-events.js — Magdeburg Events v5
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

const CATEGORIES = [
  { name: "Musik & Konzerte",     cat: "Musik",     keywords: "Konzerte Musik Bands Live-Musik" },
  { name: "Theater & Kultur",     cat: "Theater",   keywords: "Theater Oper Ballett Schauspiel Ausstellungen" },
  { name: "Sport & Familie",      cat: "Sport",     keywords: "Sport Fußball Kinder Familie" },
  { name: "Flohmärkte & Märkte",  cat: "Flohmarkt", keywords: "Flohmärkte Märkte Trödelmärkte Straßenfeste" },
  { name: "Festivals & Open-Air", cat: "Kultur",    keywords: "Festivals Open-Air Stadtfeste Volksfeste" },
];

function buildPrompt(category) {
  return `Suche nach ${category.name} Veranstaltungen in Magdeburg vom ${today} bis ${untilStr}. Suchbegriffe: ${category.keywords} Magdeburg 2026. Antworte NUR mit einem JSON-Array direkt beginnend mit [. Kein Text davor. Format: [{"id":1,"name":"Name","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","timeStart":"HH:MM oder null","category":"${category.cat}","location":"Ort"}] So viele echte Events wie möglich.`;
}

function fixJson(text) {
  if (!text) return null;
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
      system: "Du antwortest AUSSCHLIESSLICH mit einem JSON-Array. Direkt mit [ beginnen. Kein Text davor oder danach.",
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
        catch(e) { reject(new Error(data.slice(0,200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchCategory(category) {
  console.log(`\n🔍 Suche: ${category.name}...`);
  try {
    const response = await callClaude(buildPrompt(category));
    if (response.error) {
      console.error(`  ❌ API Fehler: ${response.error.message}`);
      return [];
    }
    const fullText = (response.content || []).map(b => b.type === "text" ? b.text : "").join("\n");
    const fixed = fixJson(fullText);
    if (!fixed) {
      console.log(`  ⚠️ Kein JSON — überspringe`);
      return [];
    }
    let events;
    try {
      events = JSON.parse(fixed);
    } catch(e) {
      console.log(`  ⚠️ JSON ungültig — überspringe`);
      return [];
    }
    console.log(`  ✅ ${events.length} Events`);
    return events.map(e => ({ ...e, category: category.cat }));
  } catch(e) {
    console.error(`  ❌ Fehler: ${e.message} — überspringe`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("🏰 Starte 5-Kategorien-Suche Magdeburg");
  console.log("📅", new Date().toISOString());

  let allEvents = [];
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];

  for (let i = 0; i < CATEGORIES.length; i++) {
    const category = CATEGORIES[i];
    const events = await fetchCategory(category);
    events.forEach(e => {
      allEvents.push({
        name:      e.name || "Unbekannte Veranstaltung",
        dateFrom:  e.dateFrom || today,
        dateTo:    e.dateTo || e.dateFrom || today,
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

  console.log(`\n🔀 Gesamt: ${allEvents.length} Events — dedupliziere...`);
  const deduped = dedup(allEvents);
  deduped.forEach((e,i) => e.id = i+1);
  deduped.sort((a,b) => a.dateFrom.localeCompare(b.dateFrom));
  console.log(`✅ ${deduped.length} Events nach Deduplizierung`);

  const output = {
    generated: new Date().toISOString(),
    count: deduped.length,
    sources: sources.map(s => s.name),
    events: deduped,
  };

  fs.writeFileSync(path.join(__dirname, "..", "events.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(`🎉 Fertig! ${deduped.length} Events gespeichert.`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
