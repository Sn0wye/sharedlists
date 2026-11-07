//! Groups of lists reached by a secret link, no login needed.
//!
//! Each group has an edit token and a read-only token derived from it. Every list and item
//! route takes the token in the `X-Group-Token` header (the WebSocket takes it as `?group=`).
//! An unknown token gets a 404, so a wrong link can't tell whether a group exists.

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, State},
    http::{StatusCode, request::Parts},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, MaybeUser},
    error::{AppError, AppResult},
    lists::{self, ListSummary},
    realtime::{Event, Topic},
};

pub const TOKEN_HEADER: &str = "x-group-token";
const MAX_NAME: usize = 60;
/// Tokens are 22 characters; anything much longer is not one of ours.
const MAX_TOKEN: usize = 64;
const MAX_RESOLVE: usize = 100;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/groups", post(create_group))
        .route("/groups/resolve", post(resolve_groups))
        .route("/group", get(get_group).patch(rename_group))
        .route("/group/rotate", post(rotate))
        .route("/me/groups", get(my_groups).post(save_group))
        .route("/me/groups/{id}", delete(forget_group))
}

// ---------- tokens & access ----------

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Edit,
    Read,
}

/// Proof that the request carries a valid token for `group_id`.
pub struct Access {
    pub group_id: Uuid,
    pub role: Role,
    token: String,
}

impl Access {
    /// The group id, if this token may change things.
    pub fn editable(&self) -> AppResult<Uuid> {
        match self.role {
            Role::Edit => Ok(self.group_id),
            Role::Read => Err(AppError::Forbidden),
        }
    }
}

/// 128 random bits.
fn new_edit_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

/// Whoever has the edit link can rebuild the read-only one; going the other way means
/// inverting SHA-256.
fn read_token(edit_token: &str) -> String {
    let digest = Sha256::new()
        .chain_update(b"listas-read:")
        .chain_update(edit_token.as_bytes())
        .finalize();
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn resolve(state: &AppState, token: &str) -> AppResult<Access> {
    if token.is_empty() || token.len() > MAX_TOKEN {
        return Err(AppError::NotFound);
    }
    let (group_id, can_edit): (Uuid, bool) = sqlx::query_as(
        "SELECT id, edit_token_hash = $1 FROM groups
         WHERE edit_token_hash = $1 OR read_token_hash = $1",
    )
    .bind(hash(token))
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Access {
        group_id,
        role: if can_edit { Role::Edit } else { Role::Read },
        token: token.to_owned(),
    })
}

impl FromRequestParts<AppState> for Access {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let token = parts
            .headers
            .get(TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::BadRequest("missing group token"))?;
        resolve(state, token).await
    }
}

// ---------- groups ----------

#[derive(Serialize)]
pub struct GroupInfo {
    id: Uuid,
    name: String,
    role: Role,
    list_count: i64,
}

#[derive(sqlx::FromRow)]
struct GroupRow {
    id: Uuid,
    name: String,
    can_edit: bool,
    list_count: i64,
}

impl From<GroupRow> for GroupInfo {
    fn from(r: GroupRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            role: if r.can_edit { Role::Edit } else { Role::Read },
            list_count: r.list_count,
        }
    }
}

/// A group as seen through one specific token.
#[derive(sqlx::FromRow)]
struct TokenRow {
    token: String,
    #[sqlx(flatten)]
    group: GroupRow,
}

#[derive(Serialize)]
struct SavedGroup {
    token: String,
    group: GroupInfo,
}

impl From<TokenRow> for SavedGroup {
    fn from(r: TokenRow) -> Self {
        Self {
            token: r.token,
            group: r.group.into(),
        }
    }
}

async fn info(state: &AppState, access: &Access) -> AppResult<GroupInfo> {
    let row: GroupRow = sqlx::query_as(
        "SELECT g.id, g.name, $2 AS can_edit,
                (SELECT count(*) FROM lists l WHERE l.group_id = g.id) AS list_count
         FROM groups g WHERE g.id = $1",
    )
    .bind(access.group_id)
    .bind(access.role == Role::Edit)
    .fetch_one(&state.db)
    .await?;
    Ok(row.into())
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("empty name"));
    }
    if name.chars().count() > MAX_NAME {
        return Err(AppError::BadRequest("name too long"));
    }
    Ok(name.to_owned())
}

/// Both links of a group. Only editors ever see this.
#[derive(Serialize)]
struct Links {
    group: GroupInfo,
    edit_token: String,
    read_token: String,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn create_group(
    State(state): State<AppState>,
    user: MaybeUser,
    Json(body): Json<NameBody>,
) -> AppResult<(StatusCode, Json<Links>)> {
    let edit_token = new_edit_token();
    let read_token = read_token(&edit_token);
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO groups (id, name, edit_token_hash, read_token_hash, created_by)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(clean_name(&body.name)?)
    .bind(hash(&edit_token))
    .bind(hash(&read_token))
    .bind(user.id())
    .execute(&state.db)
    .await?;

    let access = Access {
        group_id: id,
        role: Role::Edit,
        token: edit_token.clone(),
    };
    let group = info(&state, &access).await?;
    Ok((
        StatusCode::CREATED,
        Json(Links {
            group,
            edit_token,
            read_token,
        }),
    ))
}

#[derive(Serialize)]
struct GroupDetail {
    group: GroupInfo,
    lists: Vec<ListSummary>,
    /// Present for editors so they can share the read-only link too.
    read_token: Option<String>,
}

async fn get_group(State(state): State<AppState>, access: Access) -> AppResult<Json<GroupDetail>> {
    Ok(Json(GroupDetail {
        group: info(&state, &access).await?,
        lists: lists::in_group(&state, access.group_id).await?,
        read_token: (access.role == Role::Edit).then(|| read_token(&access.token)),
    }))
}

async fn rename_group(
    State(state): State<AppState>,
    access: Access,
    Json(body): Json<NameBody>,
) -> AppResult<Json<GroupInfo>> {
    let id = access.editable()?;
    let name = clean_name(&body.name)?;
    sqlx::query("UPDATE groups SET name = $2 WHERE id = $1")
        .bind(id)
        .bind(&name)
        .execute(&state.db)
        .await?;
    state
        .hub
        .publish(Topic::Group(id), &Event::GroupRenamed { id, name: &name });
    Ok(Json(info(&state, &access).await?))
}

/// Replaces both links. Everyone on the old ones, including live sockets, loses access.
async fn rotate(State(state): State<AppState>, access: Access) -> AppResult<Json<Links>> {
    let id = access.editable()?;
    let edit_token = new_edit_token();
    let read_token = read_token(&edit_token);
    sqlx::query(
        "UPDATE groups SET edit_token_hash = $2, read_token_hash = $3, rotated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(hash(&edit_token))
    .bind(hash(&read_token))
    .execute(&state.db)
    .await?;

    let list_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM lists WHERE group_id = $1")
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    state.hub.revoke(id, &list_ids);

    let access = Access {
        token: edit_token.clone(),
        ..access
    };
    Ok(Json(Links {
        group: info(&state, &access).await?,
        edit_token,
        read_token,
    }))
}

#[derive(Deserialize)]
struct ResolveBody {
    tokens: Vec<String>,
}

/// Looks up the groups saved on a device in one round trip. Tokens that no longer work are
/// left out, which tells the client to forget them.
async fn resolve_groups(
    State(state): State<AppState>,
    Json(body): Json<ResolveBody>,
) -> AppResult<Json<Vec<SavedGroup>>> {
    if body.tokens.len() > MAX_RESOLVE {
        return Err(AppError::BadRequest("too many tokens"));
    }
    let tokens: Vec<String> = body
        .tokens
        .into_iter()
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN)
        .collect();
    let rows: Vec<TokenRow> = sqlx::query_as(
        "SELECT t.token, g.id, g.name, g.edit_token_hash = t.hash AS can_edit,
                (SELECT count(*) FROM lists l WHERE l.group_id = g.id) AS list_count
         FROM (SELECT token, sha256(convert_to(token, 'UTF8')) AS hash
               FROM unnest($1::text[]) AS token) t
         JOIN groups g ON t.hash IN (g.edit_token_hash, g.read_token_hash)",
    )
    .bind(&tokens)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

// ---------- a logged-in user's groups ----------

/// Drops saved links that stopped working because the group's link was rotated.
async fn prune(state: &AppState, user_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM user_groups ug USING groups g
         WHERE ug.user_id = $1 AND g.id = ug.group_id
           AND sha256(convert_to(ug.token, 'UTF8')) NOT IN (g.edit_token_hash, g.read_token_hash)",
    )
    .bind(user_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn my_groups(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> AppResult<Json<Vec<SavedGroup>>> {
    prune(&state, claims.sub).await?;
    let rows: Vec<TokenRow> = sqlx::query_as(
        "SELECT ug.token, g.id, g.name, ug.can_edit,
                (SELECT count(*) FROM lists l WHERE l.group_id = g.id) AS list_count
         FROM user_groups ug JOIN groups g ON g.id = ug.group_id
         WHERE ug.user_id = $1
         ORDER BY ug.added_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct SaveBody {
    token: String,
}

/// Saves a link to the user's account. An edit link is never replaced by a read-only one.
async fn save_group(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(body): Json<SaveBody>,
) -> AppResult<StatusCode> {
    let access = resolve(&state, &body.token).await?;
    prune(&state, claims.sub).await?;
    sqlx::query(
        "INSERT INTO user_groups (user_id, group_id, token, can_edit) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, group_id) DO UPDATE
         SET token = EXCLUDED.token, can_edit = EXCLUDED.can_edit
         WHERE EXCLUDED.can_edit OR NOT user_groups.can_edit",
    )
    .bind(claims.sub)
    .bind(access.group_id)
    .bind(&access.token)
    .bind(access.role == Role::Edit)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn forget_group(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM user_groups WHERE user_id = $1 AND group_id = $2")
        .bind(claims.sub)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
