-- Manual order and quantity for items, plus a short-lived trash so deletes can be undone.

-- Fractional order keys (see src/order_key.rs). "C" collation so Postgres sorts them bytewise,
-- the same way Rust and JS compare them.
ALTER TABLE items ADD COLUMN position TEXT COLLATE "C";
ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999);

-- Existing items keep their creation order: a0..az, then b00..bzz, then c000..czzz
-- (the first keys the order-key format hands out when appending).
WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY list_id ORDER BY created_at, id) - 1 AS n
    FROM items
),
d (digits) AS (SELECT '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
UPDATE items SET position = CASE
        WHEN r.n < 62 THEN 'a' || substr(d.digits, r.n::int + 1, 1)
        WHEN r.n < 62 + 3844 THEN 'b'
            || substr(d.digits, ((r.n - 62) / 62)::int + 1, 1)
            || substr(d.digits, ((r.n - 62) % 62)::int + 1, 1)
        ELSE 'c'
            || substr(d.digits, ((r.n - 3906) / 3844)::int + 1, 1)
            || substr(d.digits, ((r.n - 3906) / 62 % 62)::int + 1, 1)
            || substr(d.digits, ((r.n - 3906) % 62)::int + 1, 1)
    END
FROM ranked r, d
WHERE items.id = r.id;

ALTER TABLE items ALTER COLUMN position SET NOT NULL;

DROP INDEX items_list_id;
CREATE INDEX items_list_position ON items (list_id, position);

-- Deleted items wait here for a few minutes so "Desfazer" can bring them back intact
-- (author, order, timestamps). Stored as JSON so later columns on items don't break the copy.
CREATE TABLE deleted_items (
    id          UUID PRIMARY KEY,
    list_id     UUID NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    data        JSONB NOT NULL,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX deleted_items_deleted_at ON deleted_items (deleted_at);
