# CurlingCalendar (CB BUTchers)

Jednoduchý týmový kalendář pro curling: zápasy z Excel/PDF/iCalu, ruční tréninky, přihlášení jménem + PINem a docházka Ano / Možná / Ne.

Projekt kombinuje statický frontend, Cloudflare Worker API a databázi D1. Umožňuje spravovat plán utkání, docházku a výsledky a zároveň exportovat události do `.ics`.

## Co projekt umí

- měsíční kalendář + seznam nejbližších událostí
- filtry zdrojů (`excel`, `pdf`, `ical`, `manual`)
- barevný přehled docházky (v kalendáři iniciály, v seznamu plná jména)
- export viditelných událostí do `.ics`
- přihlášení uživatele PINem a změna PINu
- správa ručních tréninků (jen uživatelé s oprávněním)
- zadávání výsledků zápasů `CB BUTchers : soupeř`
- statistiky zápasů na stránce `stats.html`
- mobilní long-press pro rychlou změnu účasti

## Struktura projektu

- `index.html`, `app.js`, `styles.css` - statický frontend
- `stats.html`, `stats.js`, `stats.css` - stránka se statistikami zápasů
- `config/config.json` - název webu a `apiBase`
- `scripts/build_events.py` - generátor `data/events.json` z Excel/PDF/iCal
- `cloudflare/src/index.js` - Worker API
- `cloudflare/migrations/0001_init.sql` - základní schema D1
- `cloudflare/migrations/0002_match_results.sql` - tabulka pro výsledky zápasů
- `cloudflare/users.example.json` - vzor pro nahrání uživatelů

## Zdroje ve složce `sources/`

- `sources/Brnensky_pohar_2026_27.xlsx` - Brněnský pohár 2026/27
- `sources/MCR_divize_2627.pdf` - MCR muži a ženy 2026/27 (divize)
- automatický import se provádí přes `scripts/build_events.py`

## Architektura

- frontend může běžet jako statický web (např. GitHub Pages)
- API běží na Cloudflare Workeru
- data uživatelů, událostí a docházky jsou v Cloudflare D1
- frontend při chybě API umí fallback na `data/events.json` (pouze pro události)
- výsledky zápasů jsou ukládány do samostatné D1 tabulky, takže je automatický import nepřepíše

## Mobilní long-press účast

Aktualizace pro mobilní zařízení:

1. Uživatel musí být přihlášený.
2. Na telefonu dlouze podrží událost přibližně 500 ms.
3. Objeví se volby Ano / Možná / Ne.
4. Bez zvednutí prstu přejede na požadovanou volbu.
5. Po puštění prstu se účast okamžitě uloží do D1.
6. Krátký tap dál normálně otevře detail události.
7. Pokud uživatel začne před uplynutím 500 ms scrollovat, long-press se zruší.

Poznámky:

- funkce se aktivuje pouze u událostí, které mají `attendanceEnabled=true`
- na desktopu zůstává chování beze změny
- pokud telefon podporuje vibrace, při otevření a změně volby dostane uživatel jemnou haptickou odezvu
- není potřeba měnit Worker, databázi ani spouštět migraci

## Lokální spuštění frontendu

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar
python -m http.server 8000
```

Potom otevři `http://localhost:8000`.

## Import událostí (Excel/PDF/iCal)

Instalace Python závislostí:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar
pip install -r requirements.txt
```

Generování `data/events.json`:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar
$env:ICAL_URL="https://..."
python scripts/build_events.py
```

Poznámky:

- iCal URL se bere z proměnné prostředí `ICAL_URL`
- volitelně lze použít `GOOGLE_SHEET_XLSX_URL` pro vzdálený XLSX export
- při chybě importu se drží poslední dostupná data pro daný zdroj

## Cloudflare Worker + D1 setup

V adresáři `cloudflare/`:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar\cloudflare
npm install
npx wrangler login
npx wrangler d1 create cb-butchers-calendar
```

Do `cloudflare/wrangler.toml` doplň `database_id` a nastav `ALLOWED_ORIGINS`.

Migrace DB:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar\cloudflare
npm run db:migrate:remote
```

Nastav secrets:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar\cloudflare
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PIN_PEPPER
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IMPORT_TOKEN
```

Deploy Workeru:

```powershell
cd C:\Users\<uzivatel>\WebstormProjects\CurlingCalendar\cloudflare
npm run deploy
```

Pak nastav `config/config.json` -> `apiBase` na URL Workeru.

## Uživatelé a PINy

Uprav `cloudflare/users.example.json` a nahraj přes admin endpoint:

```powershell
curl -X POST "https://TVE-API.workers.dev/api/admin/users" ^
  -H "Authorization: ******" ^
  -H "Content-Type: application/json" ^
  --data-binary "@cloudflare/users.example.json"
```

- PIN musí mít 4 až 12 číslic
- v DB se ukládá hash + salt (+ serverový pepper), ne otevřený PIN

## Výsledky zápasů + statistiky

Přidána funkce pro evidenci výsledků zápasů:

- výsledek lze po přihlášení zadat pro konkrétní zápas ve formátu `CB BUTchers : soupeř`
- výsledek je uložen v samostatné D1 tabulce, takže ho automatický import nepřepíše
- výsledek se ukazuje přímo v kalendáři a v seznamu nejbližších událostí
- nová stránka `stats.html` obsahuje:
  - počet zápasů, výher, proher, remíz
  - úspěšnost výher
  - celkové skóre a rozdíl
  - formu posledních 5 zápasů
  - statistiky podle soutěže
  - historii odehraných zápasů

Důležité pro upgrade:

1. Nahraď:
   - `index.html`
   - `app.js`
   - `styles.css`
   - `cloudflare/src/index.js`
2. Přidej:
   - `stats.html`
   - `stats.js`
   - `stats.css`
   - `cloudflare/migrations/0002_match_results.sql`
3. Jednou spusť migraci:

```powershell
cd cloudflare
npm run db:migrate:remote
```

4. Commit a push do `main`.

Oprávnění:

- výsledek může v této verzi zapsat nebo změnit kterýkoli přihlášený člen týmu
- později lze jednoduše omezit úpravu výsledků jen na kapitána

## API endpointy (aktuální)

- `GET /api/health`
- `GET /api/users`
- `POST /api/login`
- `GET /api/me`
- `POST /api/change-pin`
- `GET /api/events`
- `GET /api/attendance?eventId=...`
- `GET /api/attendance-summary`
- `PUT /api/attendance`
- `POST /api/trainings`
- `DELETE /api/trainings/:id`
- `POST /api/import`
- `POST /api/admin/users`

## Bezpečnostní pravidla

- nikdy neukládej `SESSION_SECRET`, `PIN_PEPPER`, `ADMIN_TOKEN`, `IMPORT_TOKEN` do repozitáře
- `ALLOWED_ORIGINS` omez jen na konkrétní domény
- `users.example.json` ber jako dočasný importní soubor (po produkčním importu v něm nenechávej reálné PINy)
- session token je uložen jen v `sessionStorage`

## Poznámka k D1 bindingu

Worker podporuje obě varianty názvu bindingu:

- `env.DB`
- `env.cb_butchers_calendar`

## Poznámka

Tento backend vychází i z předchozí opravy importu, která zachovává docházku při aktualizaci Excel/PDF/iCal.
