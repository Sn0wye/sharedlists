//! Social login (Google, GitHub) with short-lived JWT access tokens and rotating refresh tokens.
//!
//! Flow: `/auth/{provider}` -> provider -> `/auth/{provider}/callback` sets the refresh cookie and
//! redirects to the web app, which calls `POST /auth/refresh` to get an access token. The refresh
//! cookie is HttpOnly and scoped to `/auth`; the access token lives only in frontend memory.

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query, State},
    http::{HeaderMap, header, request::Parts},
    response::{IntoResponse, Redirect, Response},
    routing::{get, patch, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    config::OAuthApp,
    error::{AppError, AppResult},
};

const REFRESH_COOKIE: &str = "sl_refresh";
const STATE_COOKIE: &str = "sl_oauth_state";
const ACCESS_TTL_SECS: i64 = 15 * 60;
const REFRESH_TTL_DAYS: i64 = 30;
/// A just-rotated refresh token stays usable this long, so parallel refreshes from two tabs both succeed.
const ROTATION_GRACE_SECS: i64 = 60;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/refresh", post(refresh))
        .route("/auth/logout", post(logout))
        .route("/auth/{provider}", get(start))
        .route("/auth/{provider}/callback", get(callback))
        .route("/me", patch(update_me))
}

// ---------- access tokens & extractors ----------

#[derive(Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    /// `None` until the user picks a username right after their first login.
    pub name: Option<String>,
    exp: i64,
}

fn issue_access_token(state: &AppState, user_id: Uuid, name: Option<String>) -> String {
    let claims = Claims {
        sub: user_id,
        name,
        exp: time::OffsetDateTime::now_utc().unix_timestamp() + ACCESS_TTL_SECS,
    };
    jsonwebtoken::encode(&Header::default(), &claims, &state.jwt.0).expect("jwt encoding")
}

/// Optional login. A present-but-invalid token is a 401 so the client knows to refresh.
pub struct MaybeUser(pub Option<Claims>);

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let Some(value) = parts.headers.get(header::AUTHORIZATION) else {
            return Ok(Self(None));
        };
        let token = value
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        let data = jsonwebtoken::decode::<Claims>(token, &state.jwt.1, &Validation::default())
            .map_err(|_| AppError::Unauthorized)?;
        Ok(Self(Some(data.claims)))
    }
}

impl MaybeUser {
    /// The display name to attribute actions to; anonymous and username-less users are `None`.
    pub fn name(&self) -> Option<String> {
        self.0.as_ref().and_then(|c| c.name.clone())
    }

    pub fn id(&self) -> Option<Uuid> {
        self.0.as_ref().map(|c| c.sub)
    }
}

pub struct AuthUser(pub Claims);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        match MaybeUser::from_request_parts(parts, state).await?.0 {
            Some(claims) => Ok(Self(claims)),
            None => Err(AppError::Unauthorized),
        }
    }
}

// ---------- OAuth ----------

enum Provider {
    Google,
    GitHub,
}

impl Provider {
    fn parse(s: &str) -> AppResult<Self> {
        match s {
            "google" => Ok(Self::Google),
            "github" => Ok(Self::GitHub),
            _ => Err(AppError::NotFound),
        }
    }

    fn slug(&self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::GitHub => "github",
        }
    }

    fn app<'a>(&self, state: &'a AppState) -> AppResult<&'a OAuthApp> {
        match self {
            Self::Google => state.config.google.as_ref(),
            Self::GitHub => state.config.github.as_ref(),
        }
        .ok_or(AppError::NotFound)
    }

    fn redirect_uri(&self, state: &AppState) -> String {
        format!("{}/auth/{}/callback", state.config.public_url, self.slug())
    }
}

fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn base_cookie(state: &AppState, name: &'static str, value: String) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/auth")
        .http_only(true)
        .secure(state.config.cookie_secure)
        .build()
}

async fn start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    jar: CookieJar,
) -> AppResult<Response> {
    let provider = Provider::parse(&provider)?;
    let app = provider.app(&state)?;
    let csrf = random_token();
    let redirect_uri = provider.redirect_uri(&state);

    let url = match provider {
        Provider::Google => reqwest::Url::parse_with_params(
            "https://accounts.google.com/o/oauth2/v2/auth",
            [
                ("client_id", app.client_id.as_str()),
                ("redirect_uri", &redirect_uri),
                ("response_type", "code"),
                ("scope", "openid profile"),
                ("state", &csrf),
                ("prompt", "select_account"),
            ],
        ),
        Provider::GitHub => reqwest::Url::parse_with_params(
            "https://github.com/login/oauth/authorize",
            [
                ("client_id", app.client_id.as_str()),
                ("redirect_uri", &redirect_uri),
                ("scope", "read:user"),
                ("state", &csrf),
            ],
        ),
    }
    .expect("static url");

    // Lax so the cookie survives the top-level redirect back from the provider.
    let mut cookie = base_cookie(&state, STATE_COOKIE, csrf);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_max_age(time::Duration::minutes(10));
    Ok((jar.add(cookie), Redirect::to(url.as_str())).into_response())
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

struct ProviderProfile {
    id: String,
    avatar_url: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(q): Query<CallbackQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let provider = Provider::parse(&provider)?;
    let fail = |jar: CookieJar| {
        let url = format!("{}/auth/callback?error=1", state.config.web_url);
        Ok((jar, Redirect::to(&url)).into_response())
    };

    let expected = jar.get(STATE_COOKIE).map(|c| c.value().to_owned());
    let jar = jar.remove(base_cookie(&state, STATE_COOKIE, String::new()));
    let (Some(code), Some(got), Some(expected)) = (q.code, q.state, expected) else {
        return fail(jar);
    };
    if got != expected {
        return fail(jar);
    }

    let profile = match fetch_profile(&state, &provider, &code).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("oauth callback failed: {e:?}");
            return fail(jar);
        }
    };

    let user_id = upsert_user(&state, provider.slug(), &profile).await?;
    let token = create_session(&state, user_id).await?;
    let jar = jar.add(refresh_cookie(&state, token));
    let url = format!("{}/auth/callback", state.config.web_url);
    Ok((jar, Redirect::to(&url)).into_response())
}

async fn fetch_profile(
    state: &AppState,
    provider: &Provider,
    code: &str,
) -> AppResult<ProviderProfile> {
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }

    let app = provider.app(state)?;
    let redirect_uri = provider.redirect_uri(state);
    let form = [
        ("client_id", app.client_id.as_str()),
        ("client_secret", app.client_secret.as_str()),
        ("code", code),
        ("redirect_uri", &redirect_uri),
        ("grant_type", "authorization_code"),
    ];

    match provider {
        Provider::Google => {
            #[derive(Deserialize)]
            struct GoogleUser {
                sub: String,
                picture: Option<String>,
            }
            let token: TokenResponse = state
                .http
                .post("https://oauth2.googleapis.com/token")
                .form(&form)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let user: GoogleUser = state
                .http
                .get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(token.access_token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            Ok(ProviderProfile {
                id: user.sub,
                avatar_url: user.picture,
            })
        }
        Provider::GitHub => {
            #[derive(Deserialize)]
            struct GitHubUser {
                id: i64,
                avatar_url: Option<String>,
            }
            let token: TokenResponse = state
                .http
                .post("https://github.com/login/oauth/access_token")
                .header(header::ACCEPT, "application/json")
                .form(&form)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let user: GitHubUser = state
                .http
                .get("https://api.github.com/user")
                .bearer_auth(token.access_token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            Ok(ProviderProfile {
                id: user.id.to_string(),
                avatar_url: user.avatar_url,
            })
        }
    }
}

async fn upsert_user(state: &AppState, provider: &str, profile: &ProviderProfile) -> AppResult<Uuid> {
    let mut tx = state.db.begin().await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM identities WHERE provider = $1 AND provider_user_id = $2",
    )
    .bind(provider)
    .bind(&profile.id)
    .fetch_optional(&mut *tx)
    .await?;

    let user_id = match existing {
        Some(id) => {
            sqlx::query("UPDATE users SET avatar_url = $2 WHERE id = $1")
                .bind(id)
                .bind(&profile.avatar_url)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO users (id, avatar_url) VALUES ($1, $2)")
                .bind(id)
                .bind(&profile.avatar_url)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO identities (provider, provider_user_id, user_id) VALUES ($1, $2, $3)",
            )
            .bind(provider)
            .bind(&profile.id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            id
        }
    };
    tx.commit().await?;
    Ok(user_id)
}

// ---------- sessions ----------

async fn create_session(state: &AppState, user_id: Uuid) -> AppResult<String> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(hash(&token))
    .bind(REFRESH_TTL_DAYS as i32)
    .execute(&state.db)
    .await?;
    Ok(token)
}

fn refresh_cookie(state: &AppState, token: String) -> Cookie<'static> {
    let mut cookie = base_cookie(state, REFRESH_COOKIE, token);
    cookie.set_same_site(state.config.cookie_same_site);
    cookie.set_max_age(time::Duration::days(REFRESH_TTL_DAYS));
    cookie
}

/// Cookie-authenticated endpoints only accept requests from the web app's origin (CSRF guard).
fn check_origin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    match headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        Some(origin) if state.config.allowed_origins.iter().any(|o| o == origin) => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

#[derive(Serialize, sqlx::FromRow)]
struct User {
    id: Uuid,
    username: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Serialize)]
struct AuthResponse {
    access_token: String,
    user: User,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: Uuid,
    is_current: bool,
    in_grace: bool,
    #[sqlx(flatten)]
    user: User,
}

async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> AppResult<Response> {
    check_origin(&state, &headers)?;
    let token = jar
        .get(REFRESH_COOKIE)
        .map(|c| c.value().to_owned())
        .ok_or(AppError::Unauthorized)?;
    let token_hash = hash(&token);

    let row: Option<SessionRow> = sqlx::query_as(
        "SELECT s.id AS session_id,
                s.token_hash = $1 AS is_current,
                s.rotated_at > now() - make_interval(secs => $2) AS in_grace,
                u.id, u.username, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE (s.token_hash = $1 OR s.prev_hash = $1) AND s.expires_at > now()",
    )
    .bind(&token_hash)
    .bind(ROTATION_GRACE_SECS as f64)
    .fetch_optional(&state.db)
    .await?;

    let Some(row) = row else {
        return Ok((jar.remove(refresh_cookie(&state, String::new())), AppError::Unauthorized)
            .into_response());
    };

    let jar = if row.is_current {
        let next = random_token();
        sqlx::query(
            "UPDATE sessions
             SET prev_hash = token_hash, token_hash = $2, rotated_at = now(),
                 expires_at = now() + make_interval(days => $3)
             WHERE id = $1",
        )
        .bind(row.session_id)
        .bind(hash(&next))
        .bind(REFRESH_TTL_DAYS as i32)
        .execute(&state.db)
        .await?;
        jar.add(refresh_cookie(&state, next))
    } else if row.in_grace {
        // A parallel request already rotated; its response set the new cookie.
        jar
    } else {
        // An old token was replayed after rotation: treat the session as stolen.
        sqlx::query("DELETE FROM sessions WHERE id = $1")
            .bind(row.session_id)
            .execute(&state.db)
            .await?;
        return Ok((jar.remove(refresh_cookie(&state, String::new())), AppError::Unauthorized)
            .into_response());
    };

    let access_token = issue_access_token(&state, row.user.id, row.user.username.clone());
    Ok((jar, Json(AuthResponse { access_token, user: row.user })).into_response())
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> AppResult<Response> {
    check_origin(&state, &headers)?;
    if let Some(cookie) = jar.get(REFRESH_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1 OR prev_hash = $1")
            .bind(hash(cookie.value()))
            .execute(&state.db)
            .await?;
    }
    Ok((
        jar.remove(refresh_cookie(&state, String::new())),
        axum::http::StatusCode::NO_CONTENT,
    )
        .into_response())
}

pub async fn delete_expired_sessions(state: &AppState) {
    if let Err(e) = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(&state.db)
        .await
    {
        tracing::warn!("session cleanup failed: {e}");
    }
}

// ---------- profile ----------

#[derive(Deserialize)]
struct UpdateMe {
    username: String,
}

fn valid_username(name: &str) -> bool {
    (2..=24).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Sets the username. It can be chosen only once, which keeps denormalized item names correct.
async fn update_me(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(body): Json<UpdateMe>,
) -> AppResult<Json<AuthResponse>> {
    let username = body.username.trim();
    if !valid_username(username) {
        return Err(AppError::BadRequest("invalid username"));
    }

    let user: Option<User> = sqlx::query_as(
        "UPDATE users SET username = $2 WHERE id = $1 AND username IS NULL
         RETURNING id, username, avatar_url",
    )
    .bind(claims.sub)
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("username taken")
        }
        e => e.into(),
    })?;

    let user = user.ok_or(AppError::Conflict("username already set"))?;
    let access_token = issue_access_token(&state, user.id, user.username.clone());
    Ok(Json(AuthResponse { access_token, user }))
}
