// generate-events.js — Magdeburg Events (Anthropic Claude)
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("❌ ANTHROPIC_API_KEY nicht gesetzt!"); process.exit(1); }

const sourcesPath = path.join(__dirname, "..", "sources.json");
const sources     = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const sourceList  = sources.map(s => `- ${s.url} (${s.name})`).join("\n");
console.log(`📋 ${sources.length} Quellen geladen`);

const today = new Date().toISOString().split("T")[0];

const PROMPT = `Du bist ein Veranstaltungs-Assistent für Magdeburg (Sachsen-Anhalt, Deutschland).
Heute ist der ${today}. Suche mit dem Web-Search-Tool nach aktuellen Veranstaltungen in Magdeburg in den nächsten 60 Tagen.

Durchsuche ALLE folgenden Quellen:
${sourceList}

Suche auch gezielt nach:
- Flohmärkte Magdeburg ${today.slice(0,7)}
- Konzerte Magdeburg ${today.slice(0,7)}
- Festivals Magdeburg ${today.slice(0,7)}
- Theater Magdeburg Spielplan
- Open-Air Events Magdeburg

DUPLIKATE: Gleiches Event auf mehreren Seiten nur EINMAL, alle Quellen kommasepariert in "sources".

Gib NUR ein reines JSON-Array zurück. KEIN Markdown, KEINE Backticks, KEINE Erklärungen.

Jedes Objekt:
{
  "id": <Zahl>,
  "name": "<Veranstaltungsname>",
  "dateFrom": "<YYYY-MM-DD>",
  "dateTo": "<YYYY-MM-DD>",
  "timeStart": "<HH:MM oder null wenn unbekannt>",
  "timeEnd": "<HH:MM oder null wenn unbekannt>",
  "sources": "<Quellenname 1, Quellenname 2>",
  "sourceUrl": "<direkte URL zur Veranstaltungsseite oder null>",
  "description": "<2-4 Sätze Beschreibung aus der Quelle>",
  "category": "<Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges>",
  "location": "<Veranstaltungsort in Magdeburg>"
}

Mindestens 25 echte Veranstaltungen mit korrekten Daten. Nur das JSON-Array zurückgeben.`;

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
        console.log(`  🔀 Duplikat: "${base.name}" + "${other.name}"`);
        (other.sources||"").split(",").forEach(s => srcs.add(s.trim()));
        if ((other.description||"").length > (base.description||"").length) base.description = other.description;
        if (!base.sourceUrl && other.sourceUrl) base.sourceUrl = other.sourceUrl;
        if (!base.timeStart && other.timeStart) base.timeStart = other.timeStart;
        merged.add(j);
      }
    }
    base.sources = [...srcs].filter(Boolean).join(", ");
    result.push(base);
  }
  return result;
}

function callClaude() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: PROMPT }],
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
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("🔍 Starte Veranstaltungssuche Magdeburg (Claude)...");
  console.log("📅", new Date().toISOString());

  const response = await callClaude();
  if (response.error) throw new Error(response.error.message);

  const fullText = (response.content || []).map(b => b.type === "text" ? b.text : "").join("\n");
  const jsonMatch = fullText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) { console.error("❌ Kein JSON gefunden:", fullText.slice(0,400)); process.exit(1); }

  let events = JSON.parse(jsonMatch[0]);
  console.log(`✅ ${events.length} Events erhalten`);

  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  events = events.map((e,i) => ({
    ...e,
    id: i+1,
    sources: e.sources || e.source || "",
    timeStart: e.timeStart || null,
    timeEnd: e.timeEnd || null,
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

  fs.writeFileSync(path.join(__dirname, "..", "events.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(`✅ events.json geschrieben: ${deduped.length} Events`);
  console.log("🎉 Fertig!");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
