//! Web Push for "someone added an item to a list you follow".
//!
//! No login needed: the browser generates a random device id, registers its push subscription
//! under it and follows lists one by one. The id is the device's only credential and is only
//! ever sent to this API. Following a list takes its link token (`X-List-Token`), like reading
//! it does, since notifications carry item text. Item adds carry the device id in `X-Device-Id`
//! so the author's own device isn't notified about its own items.
//!
//! Push is optional: without `VAPID_PRIVATE_KEY` every route here answers 404 and the web app
//! hides the bell.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, State},
    http::{HeaderValue, StatusCode, request::Parts},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair},
    p256::PublicKey,
};

use crate::{
    AppState,
    error::{AppError, AppResult},
    lists::Access,
};

pub const DEVICE_HEADER: &str = "x-device-id";

/// Push services we deliver to. Endpoints come from browsers, so without this list anyone could
/// make the API send POST requests to arbitrary URLs.
const PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",        // Chrome, Android browsers, Opera, Samsung Internet
    "push.services.mozilla.com", // Firefox
    "push.apple.com",            // Safari (macOS, and iOS once installed to the home screen)
    "notify.windows.com",        // Edge on Windows
];

/// How long a push service keeps an undelivered notification; a stale "new item" isn't worth more.
const TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_BODY_CHARS: usize = 140;

pub struct Push {
    key: ES256KeyPair,
    public_key: String,
    /// VAPID `sub`: a `mailto:` or `https:` URL push services can use to reach the operator.
    contact: String,
}

impl Push {
    pub fn from_env(web_url: &str) -> Option<Arc<Self>> {
        let private = std::env::var("VAPID_PRIVATE_KEY")
            .ok()
            .filter(|v| !v.is_empty())?;
        let bytes = decode(&private).filter(|b| b.len() == 32).expect(
            "VAPID_PRIVATE_KEY must be a base64url P-256 private key (run `api vapid-keys`)",
        );
        let key =
            ES256KeyPair::from_bytes(&bytes).expect("VAPID_PRIVATE_KEY is not a valid P-256 key");
        let public_key =
            URL_SAFE_NO_PAD.encode(key.public_key().public_key().to_bytes_uncompressed());
        let contact = std::env::var("VAPID_SUBJECT")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| web_url.to_owned());
        Some(Arc::new(Self {
            key,
            public_key,
            contact,
        }))
    }
}

/// `api vapid-keys`: prints a fresh key pair for `.env`.
pub fn print_new_keys() {
    let key = ES256KeyPair::generate();
    println!(
        "VAPID_PRIVATE_KEY={}",
        URL_SAFE_NO_PAD.encode(key.to_bytes())
    );
    println!(
        "# public key, served at GET /push/key: {}",
        URL_SAFE_NO_PAD.encode(key.public_key().public_key().to_bytes_uncompressed())
    );
}

/// Accepts padded or unpadded base64url, which is what `PushSubscription.toJSON()` produces.
fn decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim().trim_end_matches('=')).ok()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/push/key", get(public_key))
        .route("/push/devices/{device}", post(register))
        .route("/push/devices/{device}/lists", get(following).post(follow))
        .route("/push/devices/{device}/lists/{list}", delete(unfollow))
}

fn enabled(state: &AppState) -> AppResult<&Push> {
    state.push.as_deref().ok_or(AppError::NotFound)
}

/// The sender's device id from `X-Device-Id`, if any. Only used to skip notifying the author.
pub struct Device(pub Option<Uuid>);

impl<S: Send + Sync> FromRequestParts<S> for Device {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .headers
                .get(DEVICE_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok()),
        ))
    }
}

// ---------- subscriptions ----------

async fn public_key(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({ "public_key": enabled(&state)?.public_key })))
}

/// The JSON from `PushSubscription.toJSON()`; other fields (`expirationTime`) are ignored.
#[derive(Deserialize)]
struct Subscription {
    endpoint: String,
    keys: Keys,
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

fn validate(sub: &Subscription) -> AppResult<()> {
    let url =
        reqwest::Url::parse(&sub.endpoint).map_err(|_| AppError::BadRequest("bad endpoint"))?;
    let host = url.host_str().unwrap_or_default();
    let known = PUSH_HOSTS
        .iter()
        .any(|h| host == *h || host.strip_suffix(h).is_some_and(|rest| rest.ends_with('.')));
    if url.scheme() != "https" || !known || sub.endpoint.len() > 2048 {
        return Err(AppError::BadRequest("unsupported push service"));
    }
    let p256dh = decode(&sub.keys.p256dh).ok_or(AppError::BadRequest("bad p256dh"))?;
    PublicKey::from_sec1_bytes(&p256dh).map_err(|_| AppError::BadRequest("bad p256dh"))?;
    if decode(&sub.keys.auth).is_none_or(|a| a.len() != 16) {
        return Err(AppError::BadRequest("bad auth"));
    }
    Ok(())
}

async fn save_device(state: &AppState, device: Uuid, sub: &Subscription) -> AppResult<()> {
    validate(sub)?;
    let mut tx = state.db.begin().await?;
    // A browser that lost its id (cleared storage) comes back with the same endpoint under a new
    // one. Its old follows go with the old id, which matches what the browser now shows.
    sqlx::query("DELETE FROM push_devices WHERE endpoint = $1 AND id <> $2")
        .bind(&sub.endpoint)
        .bind(device)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO push_devices (id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
            endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = now()",
    )
    .bind(device)
    .bind(&sub.endpoint)
    .bind(&sub.keys.p256dh)
    .bind(&sub.keys.auth)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Refreshes the subscription, e.g. after the browser rotated its endpoint. Follows are kept.
async fn register(
    State(state): State<AppState>,
    Path(device): Path<Uuid>,
    Json(sub): Json<Subscription>,
) -> AppResult<StatusCode> {
    enabled(&state)?;
    save_device(&state, device, &sub).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn following(
    State(state): State<AppState>,
    Path(device): Path<Uuid>,
) -> AppResult<Json<Vec<Uuid>>> {
    enabled(&state)?;
    let lists = sqlx::query_scalar("SELECT list_id FROM push_follows WHERE device_id = $1")
        .bind(device)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(lists))
}

/// Follows the list whose token is in `X-List-Token`. Sends the subscription along so following
/// works as a single call from a fresh device.
async fn follow(
    State(state): State<AppState>,
    Path(device): Path<Uuid>,
    list: Access,
    Json(sub): Json<Subscription>,
) -> AppResult<Json<Uuid>> {
    enabled(&state)?;
    save_device(&state, device, &sub).await?;
    sqlx::query(
        "INSERT INTO push_follows (device_id, list_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(device)
    .bind(list.id)
    .execute(&state.db)
    .await?;
    Ok(Json(list.id))
}

async fn unfollow(
    State(state): State<AppState>,
    Path((device, list)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    enabled(&state)?;
    sqlx::query("DELETE FROM push_follows WHERE device_id = $1 AND list_id = $2")
        .bind(device)
        .bind(list)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- delivery ----------

#[derive(sqlx::FromRow)]
struct Target {
    id: Uuid,
    endpoint: String,
    p256dh: String,
    auth: String,
}

/// Notifies every device following the list except the author's, once per request (a pasted
/// list is one notification). Runs in the background so the add never waits on push services.
pub fn items_added(
    state: &AppState,
    sender: Device,
    list_id: Uuid,
    texts: Vec<String>,
    author: Option<String>,
) {
    let Some(push) = state.push.clone() else {
        return;
    };
    let joined = texts.join(", ");
    let mut short: String = joined.chars().take(MAX_BODY_CHARS).collect();
    if short.len() < joined.len() {
        short.push('…');
    }
    let body = match (author, texts.len()) {
        (Some(name), 1) => format!("{name} adicionou: {short}"),
        (None, 1) => format!("Novo item: {short}"),
        (Some(name), n) => format!("{name} adicionou {n} itens: {short}"),
        (None, n) => format!("{n} itens novos: {short}"),
    };
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = deliver(&state, &push, list_id, body, sender.0).await {
            tracing::warn!("push delivery for list {list_id} failed: {e:?}");
        }
    });
}

async fn deliver(
    state: &AppState,
    push: &Push,
    list_id: Uuid,
    body: String,
    sender: Option<Uuid>,
) -> AppResult<()> {
    let targets: Vec<Target> = sqlx::query_as(
        "SELECT d.id, d.endpoint, d.p256dh, d.auth
         FROM push_follows f JOIN push_devices d ON d.id = f.device_id
         WHERE f.list_id = $1 AND d.id IS DISTINCT FROM $2",
    )
    .bind(list_id)
    .bind(sender)
    .fetch_all(&state.db)
    .await?;
    if targets.is_empty() {
        return Ok(());
    }
    let Some(title) = sqlx::query_scalar::<_, String>("SELECT title FROM lists WHERE id = $1")
        .bind(list_id)
        .fetch_optional(&state.db)
        .await?
    else {
        return Ok(());
    };

    // `tag` makes a burst of adds replace one notification instead of stacking up. The server
    // only keeps the token's hash, so the link carries the id and the app finds the token in
    // the lists saved on the device (only a device that opened the link can follow it).
    let payload = json!({
        "title": title,
        "body": body,
        "url": format!("/list/?id={list_id}"),
        "tag": format!("list-{list_id}"),
    })
    .to_string();
    // Push services collapse undelivered messages with the same Topic (max 32 url-safe chars).
    let topic = HeaderValue::from_str(&list_id.simple().to_string()).unwrap();

    futures_util::stream::iter(targets)
        .for_each_concurrent(8, |target| send(state, push, target, &payload, &topic))
        .await;
    Ok(())
}

async fn send(state: &AppState, push: &Push, target: Target, payload: &str, topic: &HeaderValue) {
    let request = (|| -> Result<reqwest::Request, Box<dyn std::error::Error + Send + Sync>> {
        let auth = decode(&target.auth)
            .filter(|a| a.len() == 16)
            .ok_or("bad auth")?;
        let p256dh = PublicKey::from_sec1_bytes(&decode(&target.p256dh).ok_or("bad p256dh")?)?;
        let http = WebPushBuilder::new(
            target.endpoint.parse()?,
            p256dh,
            Auth::clone_from_slice(&auth),
        )
        .with_valid_duration(TTL)
        .with_vapid(&push.key, &push.contact)
        .build(payload)?;
        let mut request = reqwest::Request::try_from(http)?;
        request
            .headers_mut()
            .insert("urgency", HeaderValue::from_static("normal"));
        request.headers_mut().insert("topic", topic.clone());
        Ok(request)
    })();
    let request = match request {
        Ok(r) => r,
        Err(e) => return tracing::warn!("push to device {}: {e}", target.id),
    };

    match state.http.execute(request).await {
        Ok(res) if res.status().is_success() => {}
        // The subscription is gone for good (unsubscribed, expired, app uninstalled).
        Ok(res) if matches!(res.status(), StatusCode::NOT_FOUND | StatusCode::GONE) => {
            tracing::info!("push to device {} answered {}; deleting it", target.id, res.status());
            let _ = sqlx::query("DELETE FROM push_devices WHERE id = $1")
                .bind(target.id)
                .execute(&state.db)
                .await;
        }
        Ok(res) => tracing::warn!("push to device {} rejected: {}", target.id, res.status()),
        Err(e) => tracing::warn!("push to device {} failed: {e}", target.id),
    }
}
