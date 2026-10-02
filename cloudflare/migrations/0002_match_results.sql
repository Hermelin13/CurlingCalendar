CREATE TABLE IF NOT EXISTS match_results (
  event_id TEXT PRIMARY KEY,
  our_score INTEGER NOT NULL CHECK(our_score BETWEEN 0 AND 99),
  opponent_score INTEGER NOT NULL CHECK(opponent_score BETWEEN 0 AND 99),
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_match_results_updated_at ON match_results(updated_at);
