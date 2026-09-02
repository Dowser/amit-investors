# AMIT Investors

Aktietävling mellan kollegor, som webbsida. Varje deltagare "satsar" på en svensk
aktie; den med bäst procentuell utveckling från öppningskursen den första
handelsdagen till sista stängning före julafton vinner. Ingen insats — bara äran.

**Sidan är statisk och gratis att driva.** Ett schemalagt GitHub Actions-jobb
hämtar kurser och nyheter, och publicerar resultatet till GitHub Pages.

---

## Ändra deltagare

Allt som styr tävlingen ligger i **[`config/competition.json`](config/competition.json)**.
Det är den enda filen du normalt behöver röra.

```jsonc
{
  "title": "AMIT Investors",
  "startDate": "2026-09-07",   // baslinjen är öppningskursen denna dag
  "endDate":   "2026-12-23",   // sista handelsdagen före julafton

  "participants": [
    {
      "id": "ada",                 // unikt, små bokstäver, används internt
      "name": "Ada",               // visas i tabellen
      "ticker": "ERIC-B.ST",       // Yahoo Finance-symbol, se nedan
      "company": "Ericsson B",
      "avatar": "📡",              // valfri emoji
      "motto": "Allt är radio till slut.",
      "about": "Kort text om bolaget som visas när raden fälls ut.",

      // Valfritt:
      "newsQuery": "Ericsson",     // om nyhetssökningen blir dålig, se nedan
      "color": "#ffb454"           // annars tilldelas en färg automatiskt
    }
  ]
}
```

Kontrollera alltid att symbolerna finns innan du committar:

```bash
node scripts/update.mjs --validate
```

### Referensdeltagare

En deltagare med `"benchmark": true` tävlar inte — den fungerar som måttstock:

```jsonc
{
  "id": "moderskeppet",
  "name": "Moderskeppet",
  "ticker": "ACAD.ST",
  "company": "AcadeMedia",
  "benchmark": true
}
```

Referensen rankas inte, kan inte leda tävlingen och räknas inte in i antalet
deltagare. I grafen ritas den som en streckad grå linje bakom fältet, i
tabellen ligger den sist märkt `REF`, och varje tävlandes utfällda rad visar
skillnaden mot den i procentenheter.

Ta bort raden `"benchmark": true` för att göra den till en vanlig deltagare.

### Hitta rätt ticker

Sök bolaget på [finance.yahoo.com](https://finance.yahoo.com) och använd symbolen
därifrån. Svenska aktier slutar på `.ST` och aktieslaget skrivs med bindestreck:

| Bolag | Symbol |
|---|---|
| Ericsson B | `ERIC-B.ST` |
| Volvo B | `VOLV-B.ST` |
| Evolution | `EVO.ST` |
| Hexagon B | `HEXA-B.ST` |

Avnoterade bolag försvinner ur Yahoo — `--validate` fångar det.

### Om nyheterna blir irrelevanta

Sökningen använder bolagsnamnet utan aktieslag (`"Hexagon B"` → `"Hexagon"`).
Har bolaget ett tvetydigt eller mycket vanligt namn kan träffarna bli dåliga.
Sätt då `newsQuery` till en bättre sökterm.

---

## Publicera

1. Skapa ett **publikt** GitHub-repo (t.ex. `amit-investors`) och pusha koden.
2. **Settings → Pages → Source:** välj **GitHub Actions**.
3. **Actions**-fliken → *Uppdatera ställning* → **Run workflow** för första körningen.

Sidan hamnar på `https://<användare>.github.io/<repo>/`.

Därefter uppdateras den automatiskt var 30:e minut på vardagar under
börsens öppettider, plus en avslutande körning efter stängning.

> Publikt repo ger obegränsat med Actions-minuter. Deltagarnas namn blir
> offentliga — använd förnamn eller smeknamn om det känns bättre.

---

## Köra lokalt

```bash
node scripts/update.mjs        # hämta kurser + nyheter
python3 -m http.server 8765 --directory docs
```

Öppna <http://localhost:8765>.

### Förhandsvisning före start

Innan tävlingen börjar är grafen tom. Så här ser du hur sidan kommer att se ut
under tävlingen — den kör samma deltagare som om starten låg 90 dagar bakåt:

```bash
node scripts/update.mjs --preview
```

Öppna sedan <http://localhost:8765/?preview=1>.

---

## Så fungerar det

```
config/competition.json          deltagare, datum, texter
        │
        ▼
scripts/update.mjs               Node, inga beroenden
        │  ├─ Yahoo Finance      dagsstaplar + aktuell kurs
        │  └─ Google Nyheter     rubriker (RSS), endast länkar
        ▼
docs/data/standings.json         statisk JSON
docs/data/news.json
        │
        ▼
docs/index.html + assets         ren HTML/CSS/JS, ingen byggkedja
```

**Skriptet är tillståndslöst.** Hela kurshistoriken räknas om från Yahoos
dagsstaplar vid varje körning i stället för att byggas på. En misslyckad
körning kan därför aldrig lämna ett hål i grafen — nästa lyckade körning
återskapar allt. Det gör också att du kan ändra `startDate` i efterhand och få
en korrekt omräknad tävling.

**Baslinjen** är öppningskursen den första handelsdagen. Utdelningar och spliter
räknas inte om — det är avsiktligt, det ska vara enkelt att kontrollera för hand.

### Kostnad

Noll. Publika repon har obegränsat med Actions-minuter, GitHub Pages är gratis,
och både Yahoo Finance och Google Nyheter används utan API-nyckel. Frekvensen är
medvetet vald för att ligga långt under alla gränser.

---

## Filer

| Fil | Vad |
|---|---|
| `config/competition.json` | **Redigera denna.** Deltagare, datum, texter. |
| `scripts/update.mjs` | Hämtar data, skriver JSON. |
| `docs/index.html` | Sidans struktur. |
| `docs/assets/styles.css` | Design. |
| `docs/assets/app.js` | Diagram, tabell, interaktion. |
| `.github/workflows/update.yml` | Schema och publicering. |

---

Sidan är underhållning. Kurserna är fördröjda och avrundade, och inget här är
investeringsrådgivning.
