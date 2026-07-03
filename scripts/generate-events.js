// generate-events.js v3
// Quellen aus sources.json · KI-Deduplizierung + Fuzzy-Matching als Sicherheitsnetz

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("❌ ANTHROPIC_API_KEY nicht gesetzt!"); process.exit(1); }

// ── Quellen laden ─────────────────────────────────────────────────────────────
const sourcesPath = path.join(__dirname, "..", "sources.json");
if (!fs.existsSync(sourcesPath)) { console.error("❌ sources.json fehlt!"); process.exit(1); }
const sources    = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const sourceList = sources.map(s => `- ${s.url}  (${s.name})`).join("\n");
console.log(`📋 ${sources.length} Quellen geladen`);

// ── Prompt ────────────────────────────────────────────────────────────────────
const PROMPT = `Du bist ein Veranstaltungs-Assistent für Magdeburg (Sachsen-Anhalt, Deutschland).
Suche mit dem Web-Search-Tool nach aktuellen Veranstaltungen in Magdeburg in den nächsten 60 Tagen.

Durchsuche ALLE folgenden Quellen:
${sourceList}

Suche auch gezielt nach: Flohmärkte Magdeburg, Märkte Magdeburg, Festivals Magdeburg, Open-Air Events Magdeburg.

WICHTIGE REGELN FÜR DUPLIKATE:
- Wenn dasselbe Event auf mehreren Seiten vorkommt: NUR EINMAL aufnehmen
- Im Feld "sources" alle gefundenen Quellen kommasepariert angeben, z.B. "DATEs Stadtmagazin, Moritzhof, Eventfinder"
- Gleiches Event = gleicher Name (oder sehr ähnlich) + gleiches Datum + gleicher Ort

Gib das Ergebnis NUR als reines JSON-Array zurück. KEIN Markdown, KEINE Backticks.

Jedes Objekt:
{
  "id": <Zahl ab 1>,
  "name": "<Veranstaltungsname>",
  "dateFrom": "<YYYY-MM-DD>",
  "dateTo": "<YYYY-MM-DD>",
  "sources": "<alle Quellen kommasepariert>",
  "sourceUrl": "<URL oder null>",
  "description": "<2-4 Sätze aus der Quelle>",
  "category": "<Musik|Theater|Sport|Kultur|Familie|Flohmarkt|Sonstiges>",
  "location": "<Ort in Magdeburg>"
}

Mindestens 25 echte Veranstaltungen. Nur das JSON-Array zurückgeben.`;

// ── Fuzzy-Matching: Duplikate nach KI-Antwort nochmal prüfen ─────────────────

// Einfache Textähnlichkeit (Jaccard auf Wörtern)
function similarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-zäöü0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-zäöü0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2));
  if (!wordsA.size || !wordsB.size) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function isSameDate(a, b) {
  return a.dateFrom === b.dateFrom;
}

function deduplicateFuzzy(events) {
  const result  = [];
  const merged  = new Set();

  for (let i = 0; i < events.length; i++) {
    if (merged.has(i)) continue;
    const base = { ...events[i] };
    const allSources = new Set(base.sources ? base.sources.split(",").map(s => s.trim()) : []);

    for (let j = i + 1; j < events.length; j++) {
      if (merged.has(j)) continue;
      const other = events[j];

      // Duplikat wenn: gleiches Datum UND Namensähnlichkeit > 60%
      const sim = similarity(base.name, other.name);
      if (isSameDate(base, other) && sim > 0.6) {
        console.log(`  🔀 Zusammengeführt: "${base.name}" + "${other.name}" (${Math.round(sim*100)}%)`);
        // Quellen zusammenführen
        if (other.sources) other.sources.split(",").forEach(s => allSources.add(s.trim()));
        // Längere Beschreibung bevorzugen
        if ((other.description || "").length > (base.description || "").length) {
          base.description = other.description;
        }
        // Bessere URL nehmen
        if (!base.sourceUrl && other.sourceUrl) base.sourceUrl = other.sourceUrl;
        merged.add(j);
      }
    }

    base.sources = [...allSources].filter(Boolean).join(", ");
    result.push(base);
  }

  return result;
}

// ── API Call ──────────────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔍 Starte Veranstaltungssuche für Magdeburg...");
  console.log("📅", new Date().toISOString());

  const response = await callClaude();
  if (response.error) throw new Error(response.error.message);

  const fullText = (response.content || []).map(b => b.type === "text" ? b.text : "").join("\n");
  const jsonMatch = fullText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) { console.error("❌ Kein JSON gefunden\n", fullText.slice(0,400)); process.exit(1); }

  let events = JSON.parse(jsonMatch[0]);
  console.log(`✅ ${events.length} Events von KI erhalten`);

  // Kategorien normalisieren
  const validCats = ["Musik","Theater","Sport","Kultur","Familie","Flohmarkt","Sonstiges"];
  events = events.map((e, i) => ({
    ...e,
    id:       i + 1,
    sources:  e.sources || e.source || "",  // beide Feldnamen akzeptieren
    category: validCats.includes(e.category) ? e.category : "Sonstiges",
  }));

  // Fuzzy-Deduplizierung
  console.log("🔀 Starte Duplikat-Erkennung...");
  const deduped = deduplicateFuzzy(events);
  const removed = events.length - deduped.length;
  console.log(`✅ ${removed} Duplikate entfernt → ${deduped.length} einzigartige Events`);

  // IDs neu vergeben
  deduped.forEach((e, i) => e.id = i + 1);

  const output = {
    generated:    new Date().toISOString(),
    count:        deduped.length,
    countRaw:     events.length,
    duplicatesRemoved: removed,
    sources:      sources.map(s => s.name),
    events:       deduped,
  };

  const outPath = path.join(__dirname, "..", "events.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`✅ events.json geschrieben: ${deduped.length} Events (${removed} Duplikate entfernt)`);
  console.log("🎉 Fertig!");
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
