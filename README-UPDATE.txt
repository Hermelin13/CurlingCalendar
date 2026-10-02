UPDATE: výsledky zápasů + statistiky

NOVÉ FUNKCE
- U zápasu lze po přihlášení zadat výsledek CB BUTchers : soupeř.
- Výsledek je uložen v samostatné D1 tabulce, takže ho automatický import Excel/PDF/iCal nepřepíše.
- Výsledek se ukazuje přímo v kalendáři a v seznamu nejbližších událostí.
- Nová stránka stats.html obsahuje:
  * počet zápasů, výhry, prohry, remízy
  * úspěšnost výher
  * celkové skóre a rozdíl
  * formu posledních 5 zápasů
  * statistiky podle soutěže
  * historii odehraných zápasů

INSTALACE
1. Nahraď:
   - index.html
   - app.js
   - styles.css
   - cloudflare/src/index.js

2. Přidej:
   - stats.html
   - stats.js
   - stats.css
   - cloudflare/migrations/0002_match_results.sql

3. DŮLEŽITÉ: jednou spusť migraci:
   cd cloudflare
   npm run db:migrate:remote

4. Commit + push do main.
   Frontend i API Worker se pak mohou nasadit automaticky přes tvoje Git deploymenty.

OPRÁVNĚNÍ
- Výsledek může v této verzi zapsat nebo změnit kterýkoli přihlášený člen týmu.
- Pokud chceš, lze později jednoduše omezit úpravu výsledků jen na kapitána.

POZNÁMKA
Tento backend vychází i z předchozí opravy importu, která zachovává docházku při aktualizaci Excel/PDF/iCal.
