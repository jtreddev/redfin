-- Project 6: a dismissed "bill went up" alert, and a per-person switch to blur amounts.
-- The latest charge (positive cents) when its increase was dismissed or taken as the new usual; a bigger one flags again.
ALTER TABLE recurring_bills ADD COLUMN increase_seen_cents INTEGER;
ALTER TABLE members ADD COLUMN hide_amounts INTEGER NOT NULL DEFAULT 0;
