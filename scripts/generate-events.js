// generate-events.js — Magdeburg Events
// Nutzt Google Gemini API (kostenlos) mit Web-Suche

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY nicht gesetzt!"); process.exit(1); }

// ── Quellen laden ─────────────────────────────────────────────────────────────
const sourcesPath = path.join(__dirname, "..", "sources.json");
const sources     = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const sourceList  = sources.map(s => `- ${s.url} (${s.name})`).join("\n");
console.log(`📋 ${sources.length} Quellen geladen`);

// ── Prompt ────────────────────────────────────────────────────────────────────
const PROMPT = `Du bist ein Veranstaltungs-Assistent für Magdeburg (Sachsen-Anhalt, Deutschland).
Suche im Web nach aktuellen Veranstaltungen und Events in Magdeburg in den nächsten 60 Tagen.

Durchsuche diese Quellen:
${sourceList}

Suche auch nach: Flohmärkte Magdeburg, Märkte Magdeburg, Festivals Magdeburg, Open-Air Events Magdeburg.

DUPLIKATE: Gleiches Event auf mehreren Seiten → nur EINMAL aufnehmen, alle Quellen im Feld "sources" kommasepariert.

Gib NUR ein reines JSON-Array zurück. KEIN Markdown, KEINE Backticks, KEINE Erklärungen.

Format:
[
  {
    "id": 1,
    "name": "Name der Veranstaltung",
    "dateFrom": "YYYY-MM-DD",
    "dateTo": "YYYY-MM-DD",
    "sources": "Quellenname 1, Quellenname 2",
    "sourceUrl": "https://... oder null",
    "description": "2-4 Sätze Beschreibung aus der Quelle",
    "category": "Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges",
    "location": "Veranstaltungsort in Magdeburg"
  }
]

Mindestens 25 echte Veranstaltungen. Nur das JSON-Array, absolut nichts anderes.`;

// ── Fuzzy Dedup ───────────────────────────────────────────────────────────────
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
    const srcs = new Set((base.sources||"").split(",").map(s=>s.trim()).filter(Boolean));
    for (let j = i+1; j < events.length; j++) {
      if (merged.has(j)) continue;
      const other = events[j];
      if (base.dateFrom === other.dateFrom && similarity(base.name, other.name) > 0.6) {
        console.log(`  🔀 Zusammengeführt: "${base.name}" + "${other.name}"`);
        (other.sources||"").split(",").forEach(s => srcs.add(s.trim()));
        if ((other.description||"").length > (base.description||"").length) base.description = other.description;
        if (!base.sourceUrl && other.sourceUrl) base.sourceUrl = other.sourceUrl;
        merged.add(j);
      }
    }
    base.sources = [...srcs].filter(Boolean).join(", ");
    result.push(base);
  }
  return result;
}

// ── Gemini API Call ───────────────────────────────────────────────────────────
function callGemini() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }] }],
      tools: [{ google_search: {} }],  // Web-Suche aktivieren
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔍 Starte Veranstaltungssuche für Magdeburg (Gemini)...");
  console.log("📅", new Date().toISOString());

  const response = await callGemini();

  if (response.error) {
    throw new Error(`Gemini Fehler: ${response.error.message}`);
  }

  const fullText = response.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "").join("\n") || "";

  const jsonMatch = fullText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("❌ Kein JSON gefunden. Antwort:", fullText.slice(0,400));
    process.exit(1);
  }

  let events = JSON.parse(jsonMatch[0]);
  console.log(`✅ ${events.length} Events von Gemini erhalten`);

  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  events = events.map((e,i) => ({
    ...e,
    id: i+1,
    sources: e.sources || e.source || "",
    category: validCats.includes(e.category) ? e.category : "Sonstiges",
  }));

  console.log("🔀 Duplikat-Erkennung...");
  const deduped = dedup(events);
  const removed = events.length - deduped.length;
  deduped.forEach((e,i) => e.id = i+1);
  console.log(`✅ ${removed} Duplikate entfernt → ${deduped.length} Events`);

  const output = {
    generated: new Date().toISOString(),
    count: deduped.length,
    duplicatesRemoved: removed,
    sources: sources.map(s => s.name),
    events: deduped,
  };

  const outPath = path.join(__dirname, "..", "events.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`✅ events.json geschrieben: ${deduped.length} Events`);
  console.log("🎉 Fertig!");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
