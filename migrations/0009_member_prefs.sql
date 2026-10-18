-- Per-person settings: hide the "Getting set up" card, show power tools, and saved Activity searches.
ALTER TABLE members ADD COLUMN hide_setup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN power_tools INTEGER NOT NULL DEFAULT 0;

CREATE TABLE saved_searches (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- The Activity URL query string, e.g. "q=kroger&min=50".
  query TEXT NOT NULL DEFAULT '',
  sort TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX saved_searches_member ON saved_searches (member_id, id);
