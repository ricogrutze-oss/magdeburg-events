// generate-events.js — Magdeburg Events
// Nutzt Google Gemini API mit Web-Suche

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("❌ GEMINI_API_KEY nicht gesetzt!"); process.exit(1); }

const sourcesPath = path.join(__dirname, "..", "sources.json");
const sources     = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const sourceList  = sources.map(s => `- ${s.url} (${s.name})`).join("\n");
console.log(`📋 ${sources.length} Quellen geladen`);

const PROMPT = `Du bist ein Veranstaltungs-Assistent für Magdeburg (Sachsen-Anhalt, Deutschland).
Suche im Web nach aktuellen Veranstaltungen und Events in Magdeburg in den naechsten 60 Tagen.

Durchsuche diese Quellen:
${sourceList}

Suche auch nach: Flohmärkte Magdeburg, Märkte Magdeburg, Festivals Magdeburg, Open-Air Events Magdeburg.

DUPLIKATE: Gleiches Event auf mehreren Seiten nur EINMAL aufnehmen, alle Quellen kommasepariert im Feld sources.

WICHTIG: Gib NUR ein reines JSON-Array zurück. KEIN Markdown, KEINE Backticks, KEINE Erklärungen.

Format:
[{"id":1,"name":"Name","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","sources":"Quelle1, Quelle2","sourceUrl":"https://... oder null","description":"Beschreibung","category":"Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges","location":"Ort"}]

Mindestens 25 echte Veranstaltungen. Nur das JSON-Array.`;

function sanitizeJSON(text) {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/\r/g, " ");
}

function similarity(a, b) {
  const w = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g,"").split(/\s+/).filter(w=>w.length>2));
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

function callGemini() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
    });
    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("🔍 Starte Veranstaltungssuche für Magdeburg (Gemini)...");
  console.log("📅", new Date().toISOString());
  const response = await callGemini();
  if (response.error) throw new Error(`Gemini Fehler: ${response.error.message}`);
  const fullText = (response.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const cleaned = sanitizeJSON(fullText);
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) { console.error("❌ Kein JSON gefunden:", fullText.slice(0,400)); process.exit(1); }
  let events = JSON.parse(jsonMatch[0]);
  console.log(`✅ ${events.length} Events erhalten`);
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  events = events.map((e,i) => ({ ...e, id:i+1, sources:e.sources||e.source||"", category:validCats.includes(e.category)?e.category:"Sonstiges" }));
  const deduped = dedup(events);
  deduped.forEach((e,i) => e.id = i+1);
  console.log(`✅ ${deduped.length} Events nach Deduplizierung`);
  const output = { generated: new Date().toISOString(), count: deduped.length, sources: sources.map(s=>s.name), events: deduped };
  fs.writeFileSync(path.join(__dirname, "..", "events.json"), JSON.stringify(output, null, 2), "utf8");
  console.log("🎉 Fertig!");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
