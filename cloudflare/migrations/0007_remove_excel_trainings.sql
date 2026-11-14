-- 0007_remove_excel_trainings.sql
-- Dočasně odstraňuje pouze automatické tréninky vytvořené z Excel/Google tabulky.
-- Ruční tréninky (source_type='manual') ani zápasy/EOS se nemažou.
--
-- Docházka k těmto eventům se odstraní automaticky přes ON DELETE CASCADE.

DELETE FROM events
WHERE source_type = 'training_sheet';
