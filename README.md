# CB BUTchers – týmový kalendář

Webový kalendář pro **CB BUTchers**. Zápasy se skládají z Excelu, PDF a iCalu, tréninky se přidávají přímo na webu a šest hráčů odpovídá **Ano / Možná / Ne** pomocí jména a PINu. Hráči nepotřebují GitHub účet.

## Architektura

- **GitHub Pages** – statický web (`index.html`, `app.js`, `styles.css`).
- **GitHub Actions** – pravidelně sestaví zápasy z Excelu/PDF/iCalu.
- **Cloudflare Worker** – bezpečné API pro přihlášení, tréninky a docházku.
- **Cloudflare D1** – SQL databáze uživatelů, událostí a docházky.

V prohlížeči není žádný GitHub ani Cloudflare tajný token. Uživatel dostane po přihlášení krátkodobý podepsaný session token.

## 1. Vytvoř Cloudflare D1 a Worker

Potřebuješ Node.js a Cloudflare účet. V adresáři `cloudflare/` spusť:

```bash
npm install
npx wrangler login
npx wrangler d1 create cb-butchers-calendar
```

Cloudflare vypíše `database_id`. Vlož ho do `cloudflare/wrangler.toml` místo `DOPLN_PO_VYTVORENI_D1`.

Pak vytvoř databázové tabulky:

```bash
npm run db:migrate:remote
```

Nastav čtyři tajné hodnoty. Pro každou spusť příkaz a vlož dlouhý náhodný řetězec:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PIN_PEPPER
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IMPORT_TOKEN
```

`SESSION_SECRET`, `PIN_PEPPER`, `ADMIN_TOKEN` a `IMPORT_TOKEN` musí být různé a dlouhé. Neukládej je do Git repozitáře.

V `cloudflare/wrangler.toml` nastav `ALLOWED_ORIGINS` na adresu GitHub Pages, například:

```toml
ALLOWED_ORIGINS = "https://TVUJ-UCET.github.io,http://localhost:8000"
```

Nasazení API:

```bash
npm run deploy
```

Wrangler vypíše URL podobnou:

```text
https://cb-butchers-api.TVOJE-SUBDOMENA.workers.dev
```

Tuto URL vlož do `config/config.json` do `apiBase`.

## 2. Založ 6 hráčů a PINy

Uprav `cloudflare/users.example.json`: změň jména, ID a hlavně PINy. PIN může mít 4 až 12 číslic. `canManageTrainings` určuje, kdo smí přidávat a mazat tréninky.

Pak uživatele nahraj do API:

```bash
curl -X POST "https://TVE-API.workers.dev/api/admin/users" \
  -H "Authorization: Bearer TVUJ_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @cloudflare/users.example.json
```

PIN se do D1 neukládá otevřeně. Worker uloží pouze hash se saltem a serverovým pepperem.

## 3. GitHub Secrets pro automatický import

V GitHub repozitáři otevři **Settings → Secrets and variables → Actions** a přidej:

- `ICAL_URL` – celý EOS iCal odkaz.
- `CALENDAR_API_BASE` – URL Workeru, např. `https://cb-butchers-api....workers.dev`.
- `CALENDAR_IMPORT_TOKEN` – stejná hodnota jako Cloudflare `IMPORT_TOKEN`.

Volitelně v **Variables**:

- `GOOGLE_SHEET_XLSX_URL` – přímý export Google tabulky do XLSX. Pokud není nastaven, použije se `sources/Brnensky_pohar_2026_27.xlsx`.

Workflow `.github/workflows/update-calendar.yml` jednou denně:

1. načte Excel,
2. načte PDF,
3. stáhne iCal,
4. vytvoří `data/events.json` jako statickou zálohu,
5. odešle Excel/PDF/iCal události do Cloudflare D1.

Ruční tréninky workflow nemaže – jsou uloženy jen v D1 jako `source.type = manual`.

## 4. GitHub Pages

Repozitář nahraj na GitHub a v **Settings → Pages** zvol nasazení z hlavní větve / root adresáře. Web může dál běžet celý jako statický frontend na GitHub Pages; Cloudflare slouží jen jako API a databáze.

## Co umí API

- `GET /api/events` – všechny události z D1.
- `GET /api/users` – veřejný seznam jmen pro přihlašovací formulář.
- `POST /api/login` – přihlášení jméno + PIN.
- `GET /api/attendance?eventId=...` – docházka k tréninku.
- `PUT /api/attendance` – přihlášený hráč mění jen svou odpověď.
- `POST /api/trainings` – oprávněný hráč přidá trénink.
- `DELETE /api/trainings/:id` – oprávněný hráč smaže ruční trénink.
- `POST /api/import` – chráněný import Excel/PDF/iCal z GitHub Actions.
- `POST /api/admin/users` – chráněné vytvoření/změna hráčů a PINů.

## Lokální kontrola webu

V kořeni projektu lze spustit například:

```bash
python -m http.server 8000
```

Pak otevři `http://localhost:8000`. Aby fungoval Worker z localhostu, musí být `http://localhost:8000` v `ALLOWED_ORIGINS`.

## Důležité bezpečnostní poznámky

- Nikdy nedávej `ADMIN_TOKEN`, `IMPORT_TOKEN`, `SESSION_SECRET` nebo `PIN_PEPPER` do `app.js`, `config.json` ani GitHub repozitáře.
- `users.example.json` obsahuje pouze ukázkové PINy. Před reálným použitím je změň a ideálně tento soubor po nahrání uživatelů smaž nebo v něm nenechávej skutečné PINy.
- Session token se v prohlížeči ukládá jen do `sessionStorage` a po zavření relace prohlížeče zmizí.
