//! Lists reached by a secret link, no login needed.
//!
//! Each list has one token (128 random bits); only its SHA-256 is stored. Every list and item
//! route takes it in the `X-List-Token` header, the WebSocket as `?list=`. An unknown token
//! gets a 404, so a wrong link can't tell whether a list exists. There is no global listing:
//! a device only knows the lists whose links it has opened.

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, State},
    http::{StatusCode, request::Parts},
    routing::{delete, get, patch, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, MaybeUser},
    error::{AppError, AppResult},
    order_key, push,
    realtime::Event,
};

pub const TOKEN_HEADER: &str = "x-list-token";
const MAX_TITLE: usize = 100;
const MAX_ITEM: usize = 500;
/// Most items one request may add (a pasted list).
const MAX_BATCH: usize = 200;
/// Most items one undo may bring back (a big "clear done").
const MAX_RESTORE: usize = 2000;
const MAX_QUANTITY: i32 = 999;
/// Tokens are 22 characters; anything much longer is not one of ours.
const MAX_TOKEN: usize = 64;
const MAX_RESOLVE: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/lists", post(create_list))
        .route("/lists/resolve", post(resolve_lists))
        .route("/lists/search", post(search))
        .route("/list", get(get_list).patch(rename_list).delete(delete_list))
        .route("/list/items", post(create_item))
        .route("/list/items/batch", post(create_items))
        .route("/list/items/restore", post(restore_items))
        .route("/list/clear-done", post(clear_done))
        .route("/items/{id}", patch(update_item).delete(delete_item))
        .route("/items/{id}/move", post(move_item))
        .route("/me/lists", get(my_lists).post(save_list))
        .route("/me/lists/{id}", delete(forget_list))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ListSummary {
    pub id: Uuid,
    title: String,
    created_by: Option<Uuid>,
    item_count: i64,
    done_count: i64,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Item {
    id: Uuid,
    list_id: Uuid,
    text: String,
    done: bool,
    /// Fractional order key (see `order_key`); items sort by it, ties broken by id.
    position: String,
    quantity: i32,
    created_by_name: Option<String>,
    done_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    done_at: Option<OffsetDateTime>,
}

/// A list together with the link token that reaches it.
#[derive(Serialize, sqlx::FromRow)]
struct Linked {
    token: String,
    #[sqlx(flatten)]
    list: ListSummary,
}

/// Expands to a static summary query with `$tail` appended (sqlx rejects runtime-built SQL).
macro_rules! summary_sql {
    ($tail:literal) => {
        summary_sql!("", $tail)
    };
    ($extra:literal, $tail:literal) => {
        concat!(
            "SELECT ", $extra, "l.id, l.title, l.created_by, l.updated_at,
                    count(i.id) AS item_count,
                    count(i.id) FILTER (WHERE i.done) AS done_count
             FROM lists l LEFT JOIN items i ON i.list_id = l.id ",
            $tail
        )
    };
}

async fn summary(state: &AppState, id: Uuid) -> AppResult<ListSummary> {
    Ok(
        sqlx::query_as(summary_sql!("WHERE l.id = $1 GROUP BY l.id"))
            .bind(id)
            .fetch_one(&state.db)
            .await?,
    )
}

/// Bumps the list's activity time and pushes its new counts to the list's room.
async fn touch(state: &AppState, list_id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE lists SET updated_at = now() WHERE id = $1")
        .bind(list_id)
        .execute(&state.db)
        .await?;
    let list = summary(state, list_id).await?;
    state.hub.publish(list_id, &Event::ListUpserted { list: &list });
    Ok(())
}

fn clean(text: &str, max: usize) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("empty text"));
    }
    if text.chars().count() > max {
        return Err(AppError::BadRequest("text too long"));
    }
    Ok(text.to_owned())
}

fn unique_violation(e: sqlx::Error) -> AppError {
    match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => AppError::Conflict("id exists"),
        e => e.into(),
    }
}

// ---------- tokens & access ----------

/// 128 random bits.
fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// The id of the list `token` opens.
pub async fn resolve(state: &AppState, token: &str) -> AppResult<Uuid> {
    if token.is_empty() || token.len() > MAX_TOKEN {
        return Err(AppError::NotFound);
    }
    sqlx::query_scalar("SELECT id FROM lists WHERE token_hash = $1")
        .bind(hash(token))
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)
}

/// Proof that the request carries the link token of list `id`.
pub struct Access {
    pub id: Uuid,
    token: String,
}

impl FromRequestParts<AppState> for Access {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let token = parts
            .headers
            .get(TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::BadRequest("missing list token"))?;
        Ok(Self {
            id: resolve(state, token).await?,
            token: token.to_owned(),
        })
    }
}

// ---------- lists ----------

#[derive(Deserialize)]
struct CreateList {
    title: String,
}

async fn create_list(
    State(state): State<AppState>,
    user: MaybeUser,
    Json(body): Json<CreateList>,
) -> AppResult<(StatusCode, Json<Linked>)> {
    let id = Uuid::new_v4();
    let token = new_token();
    sqlx::query("INSERT INTO lists (id, title, created_by, token_hash) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(clean(&body.title, MAX_TITLE)?)
        .bind(user.id())
        .bind(hash(&token))
        .execute(&state.db)
        .await?;
    let list = summary(&state, id).await?;
    Ok((StatusCode::CREATED, Json(Linked { token, list })))
}

#[derive(Deserialize)]
struct ResolveBody {
    tokens: Vec<String>,
}

/// Looks up the lists saved on a device in one round trip. Tokens whose list is gone are
/// left out, which tells the client to forget them.
async fn resolve_lists(
    State(state): State<AppState>,
    Json(body): Json<ResolveBody>,
) -> AppResult<Json<Vec<Linked>>> {
    if body.tokens.len() > MAX_RESOLVE {
        return Err(AppError::BadRequest("too many tokens"));
    }
    let tokens: Vec<String> = body
        .tokens
        .into_iter()
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN)
        .collect();
    let rows = sqlx::query_as(summary_sql!(
        "t.token, ",
        "JOIN (SELECT token, sha256(convert_to(token, 'UTF8')) AS hash
               FROM unnest($1::text[]) AS token) t ON t.hash = l.token_hash
         GROUP BY l.id, t.token"
    ))
    .bind(&tokens)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize)]
struct ListDetail {
    list: ListSummary,
    items: Vec<Item>,
}

async fn get_list(State(state): State<AppState>, list: Access) -> AppResult<Json<ListDetail>> {
    let items = sqlx::query_as("SELECT * FROM items WHERE list_id = $1 ORDER BY position, id")
        .bind(list.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(ListDetail {
        list: summary(&state, list.id).await?,
        items,
    }))
}

#[derive(Deserialize)]
struct RenameList {
    title: String,
}

async fn rename_list(
    State(state): State<AppState>,
    list: Access,
    Json(body): Json<RenameList>,
) -> AppResult<Json<ListSummary>> {
    sqlx::query("UPDATE lists SET title = $2, updated_at = now() WHERE id = $1")
        .bind(list.id)
        .bind(clean(&body.title, MAX_TITLE)?)
        .execute(&state.db)
        .await?;
    let summary = summary(&state, list.id).await?;
    state.hub.publish(list.id, &Event::ListUpserted { list: &summary });
    Ok(Json(summary))
}

/// Anyone with the link can delete, like everything else; the client asks for confirmation first.
async fn delete_list(State(state): State<AppState>, list: Access) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM lists WHERE id = $1")
        .bind(list.id)
        .execute(&state.db)
        .await?;
    state.hub.publish(list.id, &Event::ListDeleted { id: list.id });
    Ok(StatusCode::NO_CONTENT)
}

// ---------- search ----------

/// Lowercases and strips Portuguese accents so "feijao" finds "Feijão". Applied to both sides
/// in SQL; `translate` keeps this free of the `unaccent` extension.
macro_rules! fold {
    ($expr:literal) => {
        concat!(
            "lower(translate(",
            $expr,
            ", 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', \
                'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'))"
        )
    };
}

#[derive(Deserialize)]
struct SearchBody {
    q: String,
    /// Link tokens of the lists to search: the ones saved on the device, as in `/lists/resolve`.
    tokens: Vec<String>,
}

/// One row per list that has matching items: the first match (open items first, in list
/// order) and how many matched.
#[derive(Serialize, sqlx::FromRow)]
struct SearchHit {
    list_id: Uuid,
    text: String,
    matches: i64,
}

/// Item text search for the home screen, limited to lists whose tokens the caller sends, so it
/// can't reach a list without its link. Titles are filtered on the client, which already has
/// them. Sequential scan over those lists' items: fine at this scale, add pg_trgm if not.
async fn search(
    State(state): State<AppState>,
    Json(body): Json<SearchBody>,
) -> AppResult<Json<Vec<SearchHit>>> {
    let q = body.q.trim();
    if q.chars().count() < 2 || body.tokens.is_empty() {
        return Ok(Json(Vec::new()));
    }
    if q.chars().count() > MAX_TITLE {
        return Err(AppError::BadRequest("query too long"));
    }
    if body.tokens.len() > MAX_RESOLVE {
        return Err(AppError::BadRequest("too many tokens"));
    }
    let tokens: Vec<String> = body
        .tokens
        .into_iter()
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN)
        .collect();
    // Escape LIKE wildcards so "50%" matches literally.
    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let hits = sqlx::query_as(concat!(
        "SELECT DISTINCT ON (i.list_id) i.list_id, i.text,
                count(*) OVER (PARTITION BY i.list_id) AS matches
         FROM items i
         JOIN lists l ON l.id = i.list_id
         JOIN (SELECT sha256(convert_to(token, 'UTF8')) AS hash
               FROM unnest($2::text[]) AS token) t ON t.hash = l.token_hash
         WHERE ",
        fold!("i.text"),
        " LIKE ",
        fold!("$1"),
        " ESCAPE '\\'
         ORDER BY i.list_id, i.done, i.position, i.id"
    ))
    .bind(pattern)
    .bind(&tokens)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(hits))
}

// ---------- items ----------

/// Locks the list row so position writes on one list run one at a time and never hand out
/// the same key twice. NO KEY UPDATE still lets other inserts check their foreign key.
async fn lock_list(tx: &mut sqlx::PgConnection, list_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR NO KEY UPDATE")
        .bind(list_id)
        .fetch_optional(tx)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(())
}

#[derive(Deserialize)]
struct NewItem {
    id: Option<Uuid>,
    text: String,
}

/// Appends items to the end of the list, in the given order.
async fn insert_items(
    state: &AppState,
    user: &MaybeUser,
    list_id: Uuid,
    new: Vec<NewItem>,
) -> AppResult<Vec<Item>> {
    if new.is_empty() || new.len() > MAX_BATCH {
        return Err(AppError::BadRequest("bad item count"));
    }
    let texts = new
        .iter()
        .map(|n| clean(&n.text, MAX_ITEM))
        .collect::<AppResult<Vec<_>>>()?;

    let mut tx = state.db.begin().await?;
    lock_list(&mut tx, list_id).await?;
    let mut last: Option<String> =
        sqlx::query_scalar("SELECT max(position) FROM items WHERE list_id = $1")
            .bind(list_id)
            .fetch_one(&mut *tx)
            .await?;

    let mut items = Vec::with_capacity(new.len());
    for (n, text) in new.iter().zip(texts) {
        let position = order_key::between(last.as_deref(), None);
        let item: Item = sqlx::query_as(
            "INSERT INTO items (id, list_id, text, position, created_by_name)
             VALUES ($1, $2, $3, $4, $5) RETURNING *",
        )
        .bind(n.id.unwrap_or_else(Uuid::new_v4))
        .bind(list_id)
        .bind(text)
        .bind(&position)
        .bind(user.name())
        .fetch_one(&mut *tx)
        .await
        .map_err(unique_violation)?;
        last = Some(position);
        items.push(item);
    }
    tx.commit().await?;

    for item in &items {
        state.hub.publish(list_id, &Event::ItemUpserted { item });
    }
    touch(state, list_id).await?;
    Ok(items)
}

async fn create_item(
    State(state): State<AppState>,
    user: MaybeUser,
    device: push::Device,
    list: Access,
    Json(body): Json<NewItem>,
) -> AppResult<(StatusCode, Json<Item>)> {
    let item = insert_items(&state, &user, list.id, vec![body]).await?.remove(0);
    push::items_added(&state, device, list.id, vec![item.text.clone()], user.name());
    Ok((StatusCode::CREATED, Json(item)))
}

#[derive(Deserialize)]
struct CreateItems {
    items: Vec<NewItem>,
}

async fn create_items(
    State(state): State<AppState>,
    user: MaybeUser,
    device: push::Device,
    list: Access,
    Json(body): Json<CreateItems>,
) -> AppResult<(StatusCode, Json<Vec<Item>>)> {
    let items = insert_items(&state, &user, list.id, body.items).await?;
    let texts = items.iter().map(|i| i.text.clone()).collect();
    push::items_added(&state, device, list.id, texts, user.name());
    Ok((StatusCode::CREATED, Json(items)))
}

#[derive(Deserialize)]
struct UpdateItem {
    text: Option<String>,
    done: Option<bool>,
    quantity: Option<i32>,
}

async fn update_item(
    State(state): State<AppState>,
    user: MaybeUser,
    list: Access,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateItem>,
) -> AppResult<Json<Item>> {
    let text = body.text.as_deref().map(|t| clean(t, MAX_ITEM)).transpose()?;
    if body.quantity.is_some_and(|q| !(1..=MAX_QUANTITY).contains(&q)) {
        return Err(AppError::BadRequest("bad quantity"));
    }
    let item: Item = sqlx::query_as(
        "UPDATE items SET
            text = COALESCE($3, text),
            done = COALESCE($4::boolean, done),
            done_at = CASE WHEN $4::boolean IS NULL THEN done_at WHEN $4 THEN now() END,
            done_by_name = CASE WHEN $4::boolean IS NULL THEN done_by_name WHEN $4 THEN $5 END,
            quantity = COALESCE($6, quantity)
         WHERE id = $1 AND list_id = $2
         RETURNING *",
    )
    .bind(id)
    .bind(list.id)
    .bind(text)
    .bind(body.done)
    .bind(user.name())
    .bind(body.quantity)
    .fetch_one(&state.db)
    .await?;

    state.hub.publish(list.id, &Event::ItemUpserted { item: &item });
    touch(&state, list.id).await?;
    Ok(Json(item))
}

#[derive(Deserialize)]
struct MoveItem {
    /// The item to land right after; `null` moves it to the top.
    after: Option<Uuid>,
}

/// Gives the item a new key between `after` and whatever currently follows it. Only this one
/// row is written, and "right after X" stays meaningful even if others reordered meanwhile.
async fn move_item(
    State(state): State<AppState>,
    list: Access,
    Path(id): Path<Uuid>,
    Json(body): Json<MoveItem>,
) -> AppResult<Json<Item>> {
    if body.after == Some(id) {
        return Err(AppError::BadRequest("item can't follow itself"));
    }
    let mut tx = state.db.begin().await?;
    lock_list(&mut tx, list.id).await?;

    let lo: Option<String> = match body.after {
        Some(after) => Some(
            sqlx::query_scalar("SELECT position FROM items WHERE id = $1 AND list_id = $2")
                .bind(after)
                .bind(list.id)
                .fetch_one(&mut *tx)
                .await?,
        ),
        None => None,
    };
    let hi: Option<String> = sqlx::query_scalar(
        "SELECT min(position) FROM items
         WHERE list_id = $1 AND id <> $2 AND ($3::text IS NULL OR position > $3)",
    )
    .bind(list.id)
    .bind(id)
    .bind(&lo)
    .fetch_one(&mut *tx)
    .await?;

    let item: Item =
        sqlx::query_as("UPDATE items SET position = $3 WHERE id = $1 AND list_id = $2 RETURNING *")
            .bind(id)
            .bind(list.id)
            .bind(order_key::between(lo.as_deref(), hi.as_deref()))
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;

    state.hub.publish(list.id, &Event::ItemUpserted { item: &item });
    touch(&state, list.id).await?;
    Ok(Json(item))
}

async fn delete_item(
    State(state): State<AppState>,
    list: Access,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query_scalar::<_, Uuid>(
        "WITH gone AS (DELETE FROM items WHERE id = $1 AND list_id = $2 RETURNING *)
         INSERT INTO deleted_items (id, list_id, data)
         SELECT id, list_id, to_jsonb(gone) FROM gone
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, deleted_at = now()
         RETURNING id",
    )
    .bind(id)
    .bind(list.id)
    .fetch_one(&state.db)
    .await?;
    state.hub.publish(list.id, &Event::ItemDeleted { id });
    touch(&state, list.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_done(State(state): State<AppState>, list: Access) -> AppResult<StatusCode> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "WITH gone AS (DELETE FROM items WHERE list_id = $1 AND done RETURNING *)
         INSERT INTO deleted_items (id, list_id, data)
         SELECT id, list_id, to_jsonb(gone) FROM gone
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, deleted_at = now()
         RETURNING id",
    )
    .bind(list.id)
    .fetch_all(&state.db)
    .await?;
    for id in ids {
        state.hub.publish(list.id, &Event::ItemDeleted { id });
    }
    touch(&state, list.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RestoreItems {
    ids: Vec<Uuid>,
}

/// Undo for delete and clear-done: puts trashed items back exactly as they were.
async fn restore_items(
    State(state): State<AppState>,
    list: Access,
    Json(body): Json<RestoreItems>,
) -> AppResult<Json<Vec<Item>>> {
    if body.ids.is_empty() || body.ids.len() > MAX_RESTORE {
        return Err(AppError::BadRequest("bad item count"));
    }
    let items: Vec<Item> = sqlx::query_as(
        "WITH back AS (
            DELETE FROM deleted_items WHERE list_id = $1 AND id = ANY($2) RETURNING data
         )
         INSERT INTO items
         SELECT r.* FROM back, jsonb_populate_record(NULL::items, back.data) r
         ON CONFLICT (id) DO NOTHING
         RETURNING *",
    )
    .bind(list.id)
    .bind(&body.ids)
    .fetch_all(&state.db)
    .await?;
    if items.is_empty() {
        return Err(AppError::NotFound);
    }
    for item in &items {
        state.hub.publish(list.id, &Event::ItemUpserted { item });
    }
    touch(&state, list.id).await?;
    Ok(Json(items))
}

/// Undo only needs a few seconds; anything older is gone for good.
pub async fn purge_deleted_items(state: &AppState) {
    if let Err(e) = sqlx::query("DELETE FROM deleted_items WHERE deleted_at < now() - interval '10 minutes'")
        .execute(&state.db)
        .await
    {
        tracing::warn!("deleted items cleanup failed: {e}");
    }
}

// ---------- a logged-in user's lists ----------

async fn my_lists(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> AppResult<Json<Vec<Linked>>> {
    let rows = sqlx::query_as(summary_sql!(
        "ul.token, ",
        "JOIN user_lists ul ON ul.list_id = l.id
         WHERE ul.user_id = $1
         GROUP BY l.id, ul.token, ul.added_at
         ORDER BY ul.added_at DESC"
    ))
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// Saves the link of a list to the user's account so their other devices show it too.
async fn save_list(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    list: Access,
) -> AppResult<StatusCode> {
    sqlx::query(
        "INSERT INTO user_lists (user_id, list_id, token) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, list_id) DO NOTHING",
    )
    .bind(claims.sub)
    .bind(list.id)
    .bind(&list.token)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes the list from the user's account. The list itself stays.
async fn forget_list(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM user_lists WHERE user_id = $1 AND list_id = $2")
        .bind(claims.sub)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
