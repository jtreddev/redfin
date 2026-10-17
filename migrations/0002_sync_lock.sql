-- Short lease so cron and "Sync now" never work on the same bank at once.
ALTER TABLE plaid_items ADD COLUMN sync_lock_until TEXT;
