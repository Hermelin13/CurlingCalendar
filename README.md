# CurlingCalendar (CB BUTchers)

Jednoduchy tymovy kalendar pro curling: zapasy z Excel/PDF/iCalu, rucni treningy, prihlaseni jmenem + PINem a dochazka Ano/Mozna/Ne.

Tento soubor je hlavni dokumentace projektu.

## Co projekt umi

- mesicni kalendar + seznam nejblizsich udalosti
- filtry zdroju (`excel`, `pdf`, `ical`, `manual`)
- barevny prehled dochazky (v kalendari iniciály, v seznamu plna jmena)
- export viditelnych udalosti do `.ics`
- prihlaseni uzivatele PINem, zmena PINu
- sprava rucnich treningu (jen uzivatele s opravnenim)

## Struktura projektu

- `index.html`, `app.js`, `styles.css` - staticky frontend
- `config/config.json` - nazev webu + `apiBase`
- `scripts/build_events.py` - generator `data/events.json` z Excel/PDF/iCal
- `cloudflare/src/index.js` - Worker API
- `cloudflare/migrations/0001_init.sql` - schema D1
- `cloudflare/users.example.json` - vzor pro nahrani uzivatelu

## Zdroje ve slozce `sources/`

- `sources/Brnensky_pohar_2026_27.xlsx` - Brnensky pohar 2026/27
- `sources/MCR_divize_2627.pdf` - MCR muzu a zen 2026/27 (divize)
- automaticky import je v `scripts/build_events.py`

## Architektura

- frontend muze bezet jako staticky web (napr. GitHub Pages)
- API bezi na Cloudflare Workeru
- data uzivatelu, udalosti a dochazky jsou v Cloudflare D1
- frontend pri chybe API umi fallback na `data/events.json` (pouze pro udalosti)

## Lokalni spusteni frontendu

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar
python -m http.server 8000
```

Potom otevri `http://localhost:8000`.

## Import udalosti (Excel/PDF/iCal)

Instalace Python zavislosti:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar
pip install -r requirements.txt
```

Generovani `data/events.json`:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar
$env:ICAL_URL="https://..."
python scripts/build_events.py
```

Poznamky:

- iCal URL se bere z promenne prostredi `ICAL_URL`
- volitelne lze pouzit `GOOGLE_SHEET_XLSX_URL` pro vzdaleny XLSX export
- pri chybe importu se drzi posledni dostupna data pro dany zdroj

## Cloudflare Worker + D1 setup

V adresari `cloudflare/`:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar\cloudflare
npm install
npx wrangler login
npx wrangler d1 create cb-butchers-calendar
```

Do `cloudflare/wrangler.toml` dopln `database_id` a nastav `ALLOWED_ORIGINS`.

Migrace DB:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar\cloudflare
npm run db:migrate:remote
```

Nastav secrets:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar\cloudflare
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PIN_PEPPER
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IMPORT_TOKEN
```

Deploy Workeru:

```powershell
cd C:\Users\adjur\WebstormProjects\CurlingCalendar\cloudflare
npm run deploy
```

Pak nastav `config/config.json` -> `apiBase` na URL Workeru.

## Uzivatele a PINy

Uprav `cloudflare/users.example.json` a nahraj pres admin endpoint:

```powershell
curl -X POST "https://TVE-API.workers.dev/api/admin/users" ^
  -H "Authorization: Bearer TVUJ_ADMIN_TOKEN" ^
  -H "Content-Type: application/json" ^
  --data-binary "@cloudflare/users.example.json"
```

- PIN musi mit 4 az 12 cislic
- v DB se uklada hash + salt (+ serverovy pepper), ne otevreny PIN

## API endpointy (aktualni)

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
- `POST /api/import` (Bearer `IMPORT_TOKEN`)
- `POST /api/admin/users` (Bearer `ADMIN_TOKEN`)

## Bezpecnostni pravidla

- nikdy neukladej `SESSION_SECRET`, `PIN_PEPPER`, `ADMIN_TOKEN`, `IMPORT_TOKEN` do repozitare
- `ALLOWED_ORIGINS` omez jen na konkretni domeny
- `users.example.json` ber jako docasny importni soubor (po produkcnim importu v nem nenechavej realne PINy)
- session token je ulozen jen v `sessionStorage`

## Poznamka k D1 bindingu

Worker podporuje obe varianty nazvu bindingu:

- `env.DB`
- `env.cb_butchers_calendar`
