-- Undo for "change these charges" (bulk edit in Activity). A bulk move sets more than the category,
-- so its items keep the old kid, privacy and "left out" too, and the values the change set, so Undo
-- can tell which charges are still exactly as the bulk change left them.
ALTER TABLE category_moves ADD COLUMN kind TEXT NOT NULL DEFAULT 'learn' CHECK (kind IN ('learn', 'bulk'));
ALTER TABLE category_move_items ADD COLUMN old_kid_id INTEGER;
ALTER TABLE category_move_items ADD COLUMN old_private_member_id INTEGER;
ALTER TABLE category_move_items ADD COLUMN old_is_ignored INTEGER;
ALTER TABLE category_move_items ADD COLUMN new_category_id INTEGER;
ALTER TABLE category_move_items ADD COLUMN new_kid_id INTEGER;
ALTER TABLE category_move_items ADD COLUMN new_private_member_id INTEGER;
ALTER TABLE category_move_items ADD COLUMN new_is_ignored INTEGER;
