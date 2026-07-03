# 🏰 Magdeburg Events

Veranstaltungskalender für Magdeburg — täglich automatisch aus 20+ Quellen aggregiert.

---

## Einrichtung (einmalig, ~5 Minuten)

### 1. GitHub Repo anlegen
- github.com → „New repository" → Name: `magdeburg-events` → Public → Create

### 2. Alle Dateien hochladen
```
magdeburg-events/
├── index.html
├── sources.json
├── .github/
│   └── workflows/
│       └── update-events.yml
└── scripts/
    └── generate-events.js
```

### 3. API Key hinterlegen
- console.anthropic.com → API Keys → Create Key → kopieren
- GitHub Repo → Settings → Secrets → Actions → New secret
- Name: `ANTHROPIC_API_KEY` · Value: dein Key

### 4. GitHub Pages aktivieren
- Repo → Settings → Pages → Branch: main / (root) → Save
- App erreichbar unter: `https://USERNAME.github.io/magdeburg-events`

### 5. Ersten Lauf starten
- Repo → Actions → „Magdeburg Events täglich aktualisieren" → Run workflow

---

## Neue Quellen hinzufügen

Einfach `sources.json` öffnen und einen neuen Eintrag hinzufügen:

```json
{
  "url": "neue-seite.de/magdeburg",
  "name": "Name der Seite",
  "beschreibung": "Was diese Seite enthält"
}
```

Beim nächsten täglichen Lauf wird sie automatisch mitdurchsucht.

---

## Kosten

| Was | Kosten |
|---|---|
| GitHub (Repo + Pages + Actions) | 0 €/Monat |
| Anthropic API (~1 Aufruf/Tag) | ~2–4 €/Monat |
