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

const SYSTEM = `Du bist ein Daten-Extraktions-Assistent. Du antwortest AUSSCHLIESSLICH mit einem JSON-Array. Kein Text davor, kein Text danach, keine Erklärungen, keine Markdown-Formatierung. Nur das reine JSON-Array.`;

const PROMPT = `Suche mit dem Web-Search-Tool nach aktuellen Veranstaltungen in Magdeburg (Sachsen-Anhalt) in den nächsten 60 Tagen ab ${today}.

Durchsuche: ${sourceList}

Antworte NUR mit einem JSON-Array. Kein Text davor oder danach.

Format:
[{"id":1,"name":"Name","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","timeStart":"HH:MM oder null","timeEnd":"HH:MM oder null","sources":"Quellenname","sourceUrl":"URL oder null","description":"Beschreibung","category":"Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges","location":"Ort"}]

Mindestens 25 echte Veranstaltungen. NUR das JSON-Array.`;

function fixJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
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
    const srcs = new Set((base.sources||"").split(",").map(s=>s.trim()).filter(Boolean));
    for (let j = i+1; j < events.length; j++) {
      if (merged.has(j)) continue;
      const other = events[j];
      if (base.dateFrom === other.dateFrom && similarity(base.name, other.name) > 0.6) {
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
      system: SYSTEM,
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
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); } });
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
  console.log("📝 Rohtext (erste 200 Zeichen):", fullText.slice(0,200));

  const fixed = fixJson(fullText);
  if (!fixed) { console.error("❌ Kein JSON gefunden"); process.exit(1); }

  let events;
  try {
    events = JSON.parse(fixed);
  } catch(e) {
    console.error("❌ JSON Fehler:", e.message);
    console.error("JSON:", fixed.slice(0,400));
    process.exit(1);
  }

  console.log(`✅ ${events.length} Events erhalten`);
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  events = events.map((e,i) => ({
    ...e, id:i+1,
    sources: e.sources||e.source||"",
    timeStart: e.timeStart||null,
    timeEnd: e.timeEnd||null,
    category: validCats.includes(e.category) ? e.category : "Sonstiges",
  }));

  const deduped = dedup(events);
  deduped.forEach((e,i) => e.id = i+1);
  console.log(`✅ ${deduped.length} Events nach Deduplizierung`);

  const output = { generated: new Date().toISOString(), count: deduped.length, sources: sources.map(s=>s.name), events: deduped };
  fs.writeFileSync(path.join(__dirname, "..", "events.json"), JSON.stringify(output, null, 2), "utf8");
  console.log("🎉 Fertig!");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
