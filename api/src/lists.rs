use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    AppState,
    auth::MaybeUser,
    error::{AppError, AppResult},
    realtime::{Event, Topic},
};

const MAX_TITLE: usize = 100;
const MAX_ITEM: usize = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/lists", get(all_lists).post(create_list))
        .route(
            "/lists/{id}",
            get(get_list).patch(rename_list).delete(delete_list),
        )
        .route("/lists/{id}/items", post(create_item))
        .route("/lists/{id}/clear-done", post(clear_done))
        .route("/items/{id}", patch(update_item).delete(delete_item))
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
    created_by_name: Option<String>,
    done_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    done_at: Option<OffsetDateTime>,
}

/// Expands to a static summary query with `$tail` appended (sqlx rejects runtime-built SQL).
macro_rules! summary_sql {
    ($tail:literal) => {
        concat!(
            "SELECT l.id, l.title, l.created_by, l.updated_at,
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

/// Bumps the list's activity time and pushes its new counts to every subscriber.
async fn touch(state: &AppState, list_id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE lists SET updated_at = now() WHERE id = $1")
        .bind(list_id)
        .execute(&state.db)
        .await?;
    state.hub.list_changed(&summary(state, list_id).await?);
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
        sqlx::Error::Database(db) if db.is_foreign_key_violation() => AppError::NotFound,
        e => e.into(),
    }
}

// ---------- lists ----------

async fn all_lists(State(state): State<AppState>) -> AppResult<Json<Vec<ListSummary>>> {
    let lists = sqlx::query_as(summary_sql!(
        "GROUP BY l.id ORDER BY l.updated_at DESC LIMIT 200"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(lists))
}

#[derive(Deserialize)]
struct CreateList {
    /// Client-generated so the UI can navigate and render optimistically before the response.
    id: Option<Uuid>,
    title: String,
}

async fn create_list(
    State(state): State<AppState>,
    user: MaybeUser,
    Json(body): Json<CreateList>,
) -> AppResult<(StatusCode, Json<ListSummary>)> {
    let id = body.id.unwrap_or_else(Uuid::new_v4);
    sqlx::query("INSERT INTO lists (id, title, created_by) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(clean(&body.title, MAX_TITLE)?)
        .bind(user.id())
        .execute(&state.db)
        .await
        .map_err(unique_violation)?;

    let list = summary(&state, id).await?;
    state.hub.publish(Topic::Lobby, &Event::ListUpserted { list: &list });
    Ok((StatusCode::CREATED, Json(list)))
}

#[derive(Serialize)]
struct ListDetail {
    list: ListSummary,
    items: Vec<Item>,
}

async fn get_list(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<Json<ListDetail>> {
    let list = summary(&state, id).await?;
    let items = sqlx::query_as("SELECT * FROM items WHERE list_id = $1 ORDER BY created_at")
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(ListDetail { list, items }))
}

#[derive(Deserialize)]
struct RenameList {
    title: String,
}

async fn rename_list(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameList>,
) -> AppResult<Json<ListSummary>> {
    sqlx::query("UPDATE lists SET title = $2, updated_at = now() WHERE id = $1 RETURNING id")
        .bind(id)
        .bind(clean(&body.title, MAX_TITLE)?)
        .fetch_one(&state.db)
        .await?;
    let list = summary(&state, id).await?;
    state.hub.list_changed(&list);
    Ok(Json(list))
}

/// Anyone can delete, like everything else; the client asks for confirmation first.
async fn delete_list(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let deleted = sqlx::query("DELETE FROM lists WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    let event = Event::ListDeleted { id };
    state.hub.publish(Topic::Lobby, &event);
    state.hub.publish(Topic::List(id), &event);
    Ok(StatusCode::NO_CONTENT)
}

// ---------- items ----------

#[derive(Deserialize)]
struct CreateItem {
    id: Option<Uuid>,
    text: String,
}

async fn create_item(
    State(state): State<AppState>,
    user: MaybeUser,
    Path(list_id): Path<Uuid>,
    Json(body): Json<CreateItem>,
) -> AppResult<(StatusCode, Json<Item>)> {
    let item: Item = sqlx::query_as(
        "INSERT INTO items (id, list_id, text, created_by_name) VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(body.id.unwrap_or_else(Uuid::new_v4))
    .bind(list_id)
    .bind(clean(&body.text, MAX_ITEM)?)
    .bind(user.name())
    .fetch_one(&state.db)
    .await
    .map_err(unique_violation)?;

    state.hub.publish(Topic::List(list_id), &Event::ItemUpserted { item: &item });
    touch(&state, list_id).await?;
    Ok((StatusCode::CREATED, Json(item)))
}

#[derive(Deserialize)]
struct UpdateItem {
    text: Option<String>,
    done: Option<bool>,
}

async fn update_item(
    State(state): State<AppState>,
    user: MaybeUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateItem>,
) -> AppResult<Json<Item>> {
    let text = body.text.as_deref().map(|t| clean(t, MAX_ITEM)).transpose()?;
    let item: Item = sqlx::query_as(
        "UPDATE items SET
            text = COALESCE($2, text),
            done = COALESCE($3::boolean, done),
            done_at = CASE WHEN $3::boolean IS NULL THEN done_at WHEN $3 THEN now() END,
            done_by_name = CASE WHEN $3::boolean IS NULL THEN done_by_name WHEN $3 THEN $4 END
         WHERE id = $1
         RETURNING *",
    )
    .bind(id)
    .bind(text)
    .bind(body.done)
    .bind(user.name())
    .fetch_one(&state.db)
    .await?;

    state.hub.publish(Topic::List(item.list_id), &Event::ItemUpserted { item: &item });
    touch(&state, item.list_id).await?;
    Ok(Json(item))
}

async fn delete_item(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<StatusCode> {
    let list_id: Uuid = sqlx::query_scalar("DELETE FROM items WHERE id = $1 RETURNING list_id")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    state.hub.publish(Topic::List(list_id), &Event::ItemDeleted { id });
    touch(&state, list_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_done(State(state): State<AppState>, Path(list_id): Path<Uuid>) -> AppResult<StatusCode> {
    let ids: Vec<Uuid> =
        sqlx::query_scalar("DELETE FROM items WHERE list_id = $1 AND done RETURNING id")
            .bind(list_id)
            .fetch_all(&state.db)
            .await?;
    for id in ids {
        state.hub.publish(Topic::List(list_id), &Event::ItemDeleted { id });
    }
    touch(&state, list_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
