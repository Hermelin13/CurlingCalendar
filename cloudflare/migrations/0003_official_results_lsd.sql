ALTER TABLE match_results ADD COLUMN lsd_advantage INTEGER CHECK(lsd_advantage IN (0,1));
ALTER TABLE match_results ADD COLUMN our_lsd1 REAL;
ALTER TABLE match_results ADD COLUMN our_lsd2 REAL;
ALTER TABLE match_results ADD COLUMN opponent_lsd1 REAL;
ALTER TABLE match_results ADD COLUMN opponent_lsd2 REAL;
ALTER TABLE match_results ADD COLUMN result_source TEXT;
ALTER TABLE match_results ADD COLUMN source_url TEXT;

CREATE INDEX IF NOT EXISTS idx_match_results_source ON match_results(result_source);
