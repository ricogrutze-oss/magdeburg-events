// generate-events.js — Magdeburg Events v6
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

// Familie & Kinder zuerst, dann Rest
const CATEGORIES = [
  { name: "Familie & Kinder",     cat: "Familie",   keywords: "Familie Kinder Jugend Schule Spielplatz Kinderfest Familientag" },
  { name: "Flohmärkte & Märkte",  cat: "Flohmarkt", keywords: "Flohmarkt Trödelmarkt Markt Straßenfest Bauernmarkt" },
  { name: "Musik & Konzerte",     cat: "Musik",     keywords: "Konzert Musik Band Live Open-Air Musikfestival" },
  { name: "Theater & Kultur",     cat: "Theater",   keywords: "Theater Oper Ballett Schauspiel Ausstellung Museum Lesung" },
  { name: "Festivals & Sport",    cat: "Kultur",    keywords: "Festival Stadtfest Volksfest Sport Fußball Laufen" },
];

function buildPrompt(category) {
  return `Suche im Web nach "${category.keywords}" Veranstaltungen in Magdeburg Sachsen-Anhalt vom ${today} bis ${untilStr}. Finde echte aktuelle Events. Antworte NUR mit einem JSON-Array. Direkt mit [ beginnen, mit ] enden. Kein Text davor oder danach. Format: [{"id":1,"name":"Eventname","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","timeStart":"HH:MM oder null","category":"${category.cat}","location":"Veranstaltungsort Magdeburg"}] Finde so viele echte Veranstaltungen wie möglich.`;
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
      system: "Du bist ein Datenassistent. Antworte AUSSCHLIESSLICH mit einem JSON-Array. Beginne direkt mit [ und ende mit ]. Kein Text davor oder danach. Keine Erklärungen.",
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
        catch(e) { reject(new Error("Parse error: " + data.slice(0,100))); }
      });
    });
    req.on("error", err => {
      console.error("  ⚠️ Netzwerkfehler:", err.message);
      resolve({ content: [] }); // Nie abbrechen
    });
    req.write(body);
    req.end();
  });
}

async function fetchCategory(category) {
  console.log(`\n🔍 Suche: ${category.name}...`);
  try {
    const response = await callClaude(buildPrompt(category));

    // API Fehler abfangen aber weitermachen
    if (response.error) {
      console.log(`  ⚠️ API Fehler: ${response.error.message} — überspringe`);
      return [];
    }

    const fullText = (response.content || [])
      .map(b => b.type === "text" ? b.text : "")
      .join("\n");

    if (!fullText.trim()) {
      console.log(`  ⚠️ Leere Antwort — überspringe`);
      return [];
    }

    const fixed = fixJson(fullText);
    if (!fixed) {
      console.log(`  ⚠️ Kein JSON gefunden — überspringe`);
      return [];
    }

    let events;
    try {
      events = JSON.parse(fixed);
    } catch(e) {
      console.log(`  ⚠️ JSON ungültig — überspringe`);
      return [];
    }

    if (!Array.isArray(events)) {
      console.log(`  ⚠️ Kein Array — überspringe`);
      return [];
    }

    console.log(`  ✅ ${events.length} Events gefunden`);
    return events;

  } catch(e) {
    console.log(`  ⚠️ Unbekannter Fehler: ${e.message} — überspringe`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("🏰 Magdeburg Events — Starte Suche");
  console.log("📅", new Date().toISOString());
  console.log(`📆 Zeitraum: ${today} bis ${untilStr}`);

  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  let allEvents = [];

  for (let i = 0; i < CATEGORIES.length; i++) {
    const category = CATEGORIES[i];
    const raw = await fetchCategory(category);

    raw.forEach(e => {
      if (!e.name || !e.dateFrom) return; // Ungültige Events überspringen
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

  console.log(`\n📊 Gesamt gesammelt: ${allEvents.length} Events`);

  if (allEvents.length === 0) {
    console.log("⚠️ Keine Events gefunden — schreibe leere Liste");
  }

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
  // Trotzdem leere events.json schreiben damit die App nicht abstürzt
  const outPath = path.join(__dirname, "..", "events.json");
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
  if (!existing) {
    fs.writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), count: 0, events: [] }, null, 2));
  }
  process.exit(1);
});
