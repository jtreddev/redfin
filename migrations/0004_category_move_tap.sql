-- Undo also puts back the charge the person tapped: which charge that was (it is also one of the
-- move's items) and the category the fix gave it, so Undo can tell whether it has changed since.
ALTER TABLE category_moves ADD COLUMN tapped_transaction_id INTEGER;
ALTER TABLE category_moves ADD COLUMN fix_category_id INTEGER;
