# CB BUTchers – týmový curling kalendář

Tento projekt je webová aplikace pro tým CB BUTchers. Slouží jako společný kalendář, seznam událostí, nástroj pro docházku a statistiky zápasů. Celý projekt je navržen tak, aby členové týmu měli v jednom místě přehled o plánovaných zápasech, trénincích a aktuální účasti.

## Co se děje na stránkách

### 1) Hlavní stránka (`index.html`)

Na hlavní stránce se zobrazují:

- měsíční kalendář s událostmi
- filtry podle zdroje (`excel`, `pdf`, `ical`, `manual`)
- seznam nejbližších událostí
- detail konkrétní události po kliknutí
- přehled účasti členů pro danou akci
- tlačítka pro přihlášení, odhlášení, změnu PINu a export `.ics`

Uživatel si zde může:

- prohlížet zápasy a tréninky
- zobrazit detaily události
- označit svou účast jako Ano / Možná / Ne
- přidat nebo smazat ruční trénink (pokud má oprávnění)
- zadat výsledek zápasu a uložit ho do systému

### 2) Stránka statistik (`stats.html`)

Na stránce statistik se ukazují:

- celkový počet zápasů, výher, proher a remíz
- úspěšnost a skóre
- rozdíl branek
- forma posledních 5 utkání
- statistiky podle soutěže
- historie odehraných zápasů

Tato stránka čte výsledky zápasů z API a zobrazuje je v přehledné tabulce a kartách.

## Co projekt načítá

### Události

Aplikace načítá seznam událostí z API endpointu `GET /api/events`.

Do kalendáře se načítá:

- datum a čas události
- název a popis
- zdroj (`excel`, `pdf`, `ical`, `manual`)
- typ události (zápas, trénink, apod.)
- informace o výsledku, pokud zápas už má zaznamenaný výsledek

Pokud API není dostupné, frontend se pokusí načíst fallback data z `data/events.json`.

### Uživatelské účty

Aplikace načítá seznam uživatelů z `GET /api/users`.

V seznamu je možné vybrat jméno a přihlásit se PINem. Každý uživatel má:

- unikátní `id`
- jméno
- PIN (uložený v hashované podobě)
- příznak, zda může spravovat tréninky

### Docházka

Při otevření detailu události se načítá data o účasti z `GET /api/attendance?eventId=...` a přehled z `GET /api/attendance-summary`.

Na stránce se pak zobrazuje:

- kdo je přihlášen
- kdo má Ano / Možná / Ne
- celkový souhrn účasti na dané události

### Výsledky zápasů

Výsledky se načítají jako součást API pro události i zvlášť přes `GET /api/stats`.

Zápas může mít:

- skóre CB BUTchers : soupeř
- poznámku ke zápasu
- čas poslední úpravy

## Co projekt ukládá

### Docházka

Při změně účasti se uloží data do D1 databáze přes endpoint `PUT /api/attendance`.

Ukládá se:

- `eventId`
- `userId`
- `status` (`yes`, `maybe`, `no`)
- čas úpravy

### Výsledky zápasů

Výsledky zápasů se ukládají do tabulky `match_results` přes endpoint `PUT /api/results`.

Ukládá se:

- id zápasu
- skóre pro CB BUTchers
- skóre soupeře
- poznámka
- uživatel, který výsledek upravil
- čas poslední změny

Výsledek je oddělený od importovaných dat, takže se nevymaže ani nepřepíše při přepnutí nebo opětovném importu eventů.

### Tréninky

Ruční tréninky se zapisují přes `POST /api/trainings` a mažou přes `DELETE /api/trainings/:id`.

Ukládají se pole jako:

- datum
- začátek a konec
- místo a dráha
- poznámka
- zdroj typu `manual`

### Session a přihlášení

Po přihlášení se v prohlížeči uloží session token do `sessionStorage`. Tento token se používá pro autorizaci dalších požadavků na API.

## Jak se používá aplikace

### Přihlášení

Uživatel vybere své jméno a zadá PIN. Poté se přihlásí do systému. Každý přihlášený člen může:

- zobrazit kalendář
- měnit svůj PIN
- označit účast
- zadat výsledek zápasu

### Změna PINu

Přihlášený uživatel může změnit svůj PIN v dialogu „Změnit PIN“.

PIN se ověřuje proti uloženému hashu a saltu, ne v otevřené podobě.

### Přístup pro správu tréninků

Uživatelé s příznakem `can_manage_trainings` mohou přidávat a mazat ruční tréninky. To je odděleno od běžné účasti na zápasech.

## Informace o datových zdrojích

Projekt pracuje se zdroji:

- Excel (`.xlsx`)
- PDF
- iCal/ICS
- ruční data vytvořená v aplikaci

Importní skript `scripts/build_events.py` z těchto zdrojů vytváří datovou sadu, která se pak použije pro kalendář.

## Struktura projektu

- `index.html` – hlavní stránka kalendáře
- `app.js` – logika kalendáře, přihlášení, docházky, výsledků a exportu
- `styles.css` – styl hlavní stránky
- `stats.html` – stránka statistik
- `stats.js` – výpočet a zobrazení statistik
- `stats.css` – styl Statistik
- `config/config.json` – základní konfigurace webu a API
- `data/` – data pro fallback a import
- `sources/` – zdrojové soubory pro import
- `cloudflare/src/index.js` – API Worker
- `cloudflare/migrations/` – SQL migrace pro databázi
- `cloudflare/users.example.json` – vzor uživatelských dat

## Jaká data má projekt v sobě

Projekt obsahuje:

- plánované zápasy a tréninky
- seznam členů týmu
- docházku jednotlivých členů
- výsledky zápasů
- souhrn statistik za sezonu

Všechny tyto informace jsou propojené do jednoho rozhraní, aby tým nemusel pracovat ve více nástrojích.

## Bezpečnostní základ

- přihlášení je přes jméno a PIN
- PIN se neukládá v čisté podobě
- token přihlášení je uložen jen v prohlížeči
- API omezuje přístup podle session tokenu a oprávnění

## Shrnutí

Aplikace je týmový curling kalendář, který:

- načítá zápasy a tréninky z různých zdrojů,
- zobrazuje je v kalendáři,
- umožňuje členům přihlásit se a označit účast,
- ukládá výsledky zápasů a statistiky,
- poskytuje jednoduchý přehled pro celý tým.

Cílem projektu není jen plánování, ale i evidování týmové aktivity v jednom systému.
