-- When this bank's history was last re-pulled for the bank's detailed categories. Banks linked
-- before detailed categories existed start NULL; cron re-pulls each of them once.
ALTER TABLE plaid_items ADD COLUMN details_refreshed_at TEXT;
