CREATE TABLE users (
    id          UUID PRIMARY KEY,
    username    TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE identities (
    provider          TEXT NOT NULL,
    provider_user_id  TEXT NOT NULL,
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (provider, provider_user_id)
);

-- One row per device login. The refresh token itself is never stored, only its SHA-256.
-- prev_hash keeps the previous token valid briefly so concurrent refreshes (two tabs) don't log out.
CREATE TABLE sessions (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  BYTEA NOT NULL UNIQUE,
    prev_hash   BYTEA,
    rotated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_prev_hash ON sessions (prev_hash);

CREATE TABLE lists (
    id          UUID PRIMARY KEY,
    title       TEXT NOT NULL,
    created_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lists_updated_at ON lists (updated_at DESC);

-- Names are denormalized: a username is chosen once and never changes.
CREATE TABLE items (
    id               UUID PRIMARY KEY,
    list_id          UUID NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    text             TEXT NOT NULL,
    done             BOOLEAN NOT NULL DEFAULT false,
    created_by_name  TEXT,
    done_by_name     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at          TIMESTAMPTZ
);

CREATE INDEX items_list_id ON items (list_id, created_at);
