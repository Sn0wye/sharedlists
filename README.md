# Listas

Shared checklists in real time. Each list is reached by a secret link: whoever has the link sees and edits it, with no account. Logging in with Google or GitHub is optional. It adds your username to what you add and tick, and syncs your lists between devices.

- `web/`: Next.js 16 static export (`output: "export"`), Tailwind 4, installable PWA. No server needed; `pnpm build` writes `web/out/`.
- `api/`: Rust (axum + sqlx/Postgres). REST for writes, a WebSocket (`/ws?list=<token>`) for live updates.

Live presence on a list (who is here, who is typing, which item each person is on) travels only over the list socket and lives in memory; see `api/src/presence.rs` for the messages. Logged-in people show their username, verified from the access token. Everyone else gets an anonymous animal name and a colour kept in `localStorage` (`sl_presence`).

## Local

```sh
docker compose up -d --build          # postgres on :5433, api on :8080
cd web && cp .env.example .env.local && pnpm install && pnpm dev
```

To run the API outside Docker: `cp api/.env.example api/.env`, then `cd api && cargo run` (only the postgres service from compose is needed).

## Links

- A list link is `WEB_URL/list/?t=<token>`. The token is 128 random bits; the database stores only its SHA-256.
- Every list and item route takes the token in the `X-List-Token` header. A missing token returns 400, an unknown one 404. There is no global listing.
- The home screen shows the lists this device has opened, stored in `localStorage` (`listas:lists`), and refreshes them with `POST /lists/resolve`. For logged-in users, `user_lists` keeps a copy of each link so other devices show it too. That copy has to be readable, so it is stored as plain text.

## Auth

1. `GET /auth/{google|github}` redirects to the provider. The callback creates the user and sets an HttpOnly refresh cookie (`sl_refresh`, path `/auth`, 30 days), then redirects to `WEB_URL/auth/callback`.
2. The web app calls `POST /auth/refresh` and gets a 15-minute JWT access token, kept in memory only. Each refresh rotates the refresh token. If an old token is replayed more than 60s after rotation, the session is revoked.
3. A new user chooses a username once with `PATCH /me`.

The refresh cookie needs the web app and API on the same site, e.g. `listas.example.com` + `api.listas.example.com`. If they are on different domains, set `COOKIE_SAMESITE=none`. Safari may still block that cookie, so prefer subdomains.

OAuth callback URLs to register:
- Google: `$PUBLIC_URL/auth/google/callback`
- GitHub: `$PUBLIC_URL/auth/github/callback`

## Deploy

**API on Coolify**: `.github/workflows/docker-publish.yml` builds `api/Dockerfile` for linux/arm64 on every push to `main` that touches `api/`. It pushes `ghcr.io/<owner>/<repo>:latest` and calls the Coolify webhook.

1. In Coolify, create a Postgres database and a "Docker Image" application using `ghcr.io/<owner>/<repo>:latest`, port 8080.
2. Set env vars from `api/.env.example`. `DATABASE_URL` is Coolify's internal Postgres URL. Generate `JWT_SECRET` with `openssl rand -base64 48`.
3. Add the repo secrets `COOLIFY_WEBHOOK` (the app's deploy webhook URL) and `COOLIFY_TOKEN` (a Coolify API token).
4. The image includes a Docker `HEALTHCHECK` (`/app/api healthcheck`). The image is distroless and has no curl, so turn off Coolify's own curl-based health check.

Migrations run on startup. Live updates are fanned out in memory, so run a single API instance.

**Web**: any static host. Set `NEXT_PUBLIC_API_URL` at build time and publish `web/out/`. On Vercel, set the root directory to `web` and it works with no other configuration.
