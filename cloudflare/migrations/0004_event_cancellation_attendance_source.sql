-- 0004: Adam ruší události + ruční přepis docházky

ALTER TABLE events ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1));
ALTER TABLE events ADD COLUMN cancelled_by TEXT;
ALTER TABLE events ADD COLUMN cancelled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_events_cancelled
ON events(cancelled, date);

ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK(source IN ('manual','training_sheet'));
ALTER TABLE attendance ADD COLUMN updated_by TEXT;

UPDATE attendance
SET source='training_sheet'
WHERE event_id IN (
  SELECT id FROM events WHERE source_type='training_sheet'
);

CREATE INDEX IF NOT EXISTS idx_attendance_source
ON attendance(source);
