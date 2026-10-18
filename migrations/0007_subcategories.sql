-- Sub-categories, one level: a category may sit under a parent in the same group (Habits › Snacks).
-- The API keeps it to one level (a parent has no parent; a category with children can't become a
-- child) and keeps a child in its parent's group; SQLite CHECKs can't look at other rows.
ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX categories_parent ON categories (parent_id);
