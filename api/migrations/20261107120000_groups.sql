-- Lists now belong to a group reached by a secret link. Lists created before groups existed
-- were readable and editable by everyone, so they are dropped rather than moved into a group.
DELETE FROM lists;

-- A group has one secret: the edit token. The read-only token is derived from it
-- (see `groups.rs`), so rotating the edit token rotates both links at once.
-- Only SHA-256 hashes are stored, like refresh tokens.
CREATE TABLE groups (
    id               UUID PRIMARY KEY,
    name             TEXT NOT NULL,
    edit_token_hash  BYTEA NOT NULL UNIQUE,
    read_token_hash  BYTEA NOT NULL UNIQUE,
    created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lists ADD COLUMN group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE;

DROP INDEX lists_updated_at;
CREATE INDEX lists_group_id ON lists (group_id, updated_at DESC);

-- Groups a logged-in user has opened, so they show up on all of the user's devices.
-- The token is the user's own copy of the link. It has to be readable to rebuild the link
-- on another device, so unlike `groups` it can't be a hash. Rows whose token no longer
-- matches the group (the link was rotated) are pruned when read.
CREATE TABLE user_groups (
    user_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    group_id  UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    token     TEXT NOT NULL,
    can_edit  BOOLEAN NOT NULL,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, group_id)
);
