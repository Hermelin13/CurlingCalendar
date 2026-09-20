AKTUALIZACE CB BUTchers kalendáře
================================

Nové funkce:
1) Přehled docházky na první pohled
   - u každé události s docházkou jsou barevné iniciály hráčů
   - zelená = ano, žlutá = možná, červená = ne, šedá = bez odpovědi
   - přehled je v měsíčním kalendáři i v seznamu nejbližších událostí

2) Export kalendáře
   - tlačítko "Export .ics"
   - exportuje aktuálně zapnuté kategorie (Pohár / MČR / iCal / Tréninky)
   - výsledný soubor lze importovat do Google Calendar, Apple Calendar, Outlook apod.

3) Změna PINu
   - po přihlášení se zobrazí tlačítko "Změnit PIN"
   - uživatel musí zadat současný PIN a dvakrát nový PIN
   - nový PIN musí mít 4 až 12 číslic
   - PIN se ukládá pouze jako hash; žádný nový secret ani DB migrace není potřeba

Nasazení:
- Nahraď v repozitáři soubory:
  app.js
  index.html
  styles.css
  cloudflare/src/index.js
- Commit + push do main.
- Pokud máš auto-deploy frontendu i API Workeru, oba se nasadí automaticky.
- Není potřeba spouštět D1 migraci.

Poznámka k D1 bindingu:
- Worker podporuje obě varianty názvu bindingu: env.DB i env.cb_butchers_calendar.
