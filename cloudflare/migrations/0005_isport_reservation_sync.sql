-- iSport reservation sync: reversible occupancy snapshots + soft-active reservation events.

CREATE TABLE IF NOT EXISTS isport_sync_days (
  date TEXT PRIMARY KEY,
  lanes_json TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS isport_reservation_slots (
  date TEXT NOT NULL,
  lane TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('busy','ours')),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, lane, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS idx_isport_slots_date
  ON isport_reservation_slots(date);

CREATE INDEX IF NOT EXISTS idx_isport_slots_date_lane
  ON isport_reservation_slots(date, lane, start_time, end_time);

CREATE TABLE IF NOT EXISTS isport_reservation_events (
  event_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_isport_reservation_events_active
  ON isport_reservation_events(active);
