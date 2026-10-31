use axum_extra::extract::cookie::SameSite;

#[derive(Clone)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    /// Origin of the static frontend, e.g. `https://sharedlists.app`. Used for CORS and post-login redirects.
    pub web_url: String,
    /// `web_url` plus `EXTRA_ORIGINS` (comma-separated), e.g. localhost alongside a LAN IP in dev.
    pub allowed_origins: Vec<String>,
    /// Public base URL of this API, e.g. `https://api.sharedlists.app`. Used to build OAuth redirect URIs.
    pub public_url: String,
    pub jwt_secret: String,
    pub cookie_secure: bool,
    pub cookie_same_site: SameSite,
    pub google: Option<OAuthApp>,
    pub github: Option<OAuthApp>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn required(name: &str) -> String {
    var(name).unwrap_or_else(|| panic!("missing env var {name}"))
}

fn oauth_app(prefix: &str) -> Option<OAuthApp> {
    Some(OAuthApp {
        client_id: var(&format!("{prefix}_CLIENT_ID"))?,
        client_secret: var(&format!("{prefix}_CLIENT_SECRET"))?,
    })
}

impl Config {
    pub fn from_env() -> Self {
        let public_url = required("PUBLIC_URL").trim_end_matches('/').to_owned();
        let jwt_secret = required("JWT_SECRET");
        let web_url = required("WEB_URL").trim_end_matches('/').to_owned();
        let mut allowed_origins = vec![web_url.clone()];
        allowed_origins.extend(
            var("EXTRA_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_owned())
                .filter(|o| !o.is_empty()),
        );
        assert!(jwt_secret.len() >= 32, "JWT_SECRET must be at least 32 characters");

        Self {
            port: var("PORT").and_then(|p| p.parse().ok()).unwrap_or(8080),
            database_url: required("DATABASE_URL"),
            web_url,
            allowed_origins,
            cookie_secure: public_url.starts_with("https://"),
            // Use `none` only when the frontend and API live on different sites (not just subdomains).
            cookie_same_site: match var("COOKIE_SAMESITE").as_deref() {
                Some("none") => SameSite::None,
                _ => SameSite::Lax,
            },
            public_url,
            jwt_secret,
            google: oauth_app("GOOGLE"),
            github: oauth_app("GITHUB"),
        }
    }
}
