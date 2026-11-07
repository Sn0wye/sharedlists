-- Web Push without accounts: each browser registers itself under a random id it generates
-- and keeps (the id doubles as its credential), then follows lists one by one.
CREATE TABLE push_devices (
    id          UUID PRIMARY KEY,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE push_follows (
    device_id   UUID NOT NULL REFERENCES push_devices (id) ON DELETE CASCADE,
    list_id     UUID NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, list_id)
);

CREATE INDEX push_follows_list_id ON push_follows (list_id);
