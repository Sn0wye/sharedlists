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

## Offline

Everything inside a list works without a connection. Each change goes into an outbox in IndexedDB (`web/src/lib/offline.ts`) and is sent in order when the API is reachable again: on the `online` event, when the app comes back to the foreground, when a list loads, and with backoff up to 30 seconds. The last copy of each list opened on the device is kept too, so the app opens and searches offline.

| Feature | Offline | How |
|---|---|---|
| Home screen, pins, title search | ✅ | Already local (`localStorage`) |
| Item search | ✅ | Searches the copies of lists opened on this device; online it asks the API |
| Open a list | ✅ | If it was opened on this device before |
| Add an item, paste several lines | ✅ | Queued; consecutive adds go as one batch request |
| Tick, quantity, reorder | ✅ | Queued |
| Delete an item, clear done, Desfazer | ✅ | Queued; clear done deletes exactly the items shown as done |
| Rename a list | ✅ | Queued |
| Share the link | ✅ | System share sheet or clipboard |
| Tirar da tela inicial | ⚠️ | Removed from this device right away; for logged-in users the account copy is removed only online, so it can come back on another device |
| Create or delete a list | ❌ | The server creates the token; deleting removes the list for everyone, so it isn't queued |
| Open a link never opened on this device | ❌ | No copy yet |
| Presence, typing, live updates, notifications, login | ❌ | Need the server; the top bar shows "Reconectando…" |

Conflicts, with the server as the source of truth:
- Every write is idempotent. Item ids are generated on the device, so a retried add that already landed (409) counts as done. Ticks, quantities and titles send the final value, not a change. A move says "right after item X". Deleting an item that is already gone counts as done.
- Changes are applied in the order they reach the server, so the last one wins, the same as two people tapping at once online.
- Deleting wins over editing. An edit or move on an item someone else deleted is dropped, and so is everything queued for a deleted list.
- Queued changes to the same item collapse until their first send attempt: tick then untick sends only the final value, a burst of quantity taps or moves sends the last one, add then delete sends nothing, and delete then undo cancels the delete. A change that was already attempted is never collapsed, because the server may have it; the opposite change is sent after it instead.
- Undo for a delete that already reached the server uses the server's trash, which keeps items for a few minutes. After that, the undo is dropped.
- If the server rejects a change, it is dropped with a toast and the list is fetched again.

Pending changes show up only after sending fails: a pill in the top bar ("2 alterações pendentes") and a small clock next to each affected item.

## Notifications

The bell in a list's top bar subscribes this device to Web Push for that list: you get a notification when someone else adds an item. It works without logging in. The browser generates a random device id (`localStorage` `sl_device`), which is its only credential, and registers its push subscription under it.

- `cargo run -- vapid-keys` prints a key pair. Set `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` or `https:` URL) on the API. Without them push is off and the bell is hidden.
- `GET /push/key`, `POST /push/devices/{device}` (refresh the subscription), `GET /push/devices/{device}/lists`, `POST /push/devices/{device}/lists` with `X-List-Token` (follow), `DELETE /push/devices/{device}/lists/{list}` (unfollow).
- Following takes the list's link token, like reading it does, because notifications carry item text.
- Item adds send `X-Device-Id`, so the author's own device is not notified. A pasted list is one notification ("Ana adicionou 5 itens: …"). Notifications for one list share a tag, so a burst of adds replaces one notification.
- The server only stores the token's hash, so a notification links to `/list/?id=<id>` and the app finds the token among the lists saved on the device. Tirar da tela inicial unfollows the list.
- Subscriptions are only accepted for the known push services (FCM, Mozilla, Apple, WNS), so the API never posts to an arbitrary URL. A subscription the push service reports as gone (404/410) is deleted.
- On iPhone and iPad, push only works once the app is added to the Home Screen (iOS 16.4+). There, the bell explains this.

## Deploy

**API on Coolify**: `.github/workflows/docker-publish.yml` builds `api/Dockerfile` for linux/arm64 on every push to `main` that touches `api/`. It pushes `ghcr.io/<owner>/<repo>:latest` and calls the Coolify webhook.

1. In Coolify, create a Postgres database and a "Docker Image" application using `ghcr.io/<owner>/<repo>:latest`, port 8080.
2. Set env vars from `api/.env.example`. `DATABASE_URL` is Coolify's internal Postgres URL. Generate `JWT_SECRET` with `openssl rand -base64 48`. For notifications, generate the VAPID key once with `cargo run -- vapid-keys` and keep it: changing it invalidates every subscription.
3. Add the repo secrets `COOLIFY_WEBHOOK` (the app's deploy webhook URL) and `COOLIFY_TOKEN` (a Coolify API token).
4. The image includes a Docker `HEALTHCHECK` (`/app/api healthcheck`). The image is distroless and has no curl, so turn off Coolify's own curl-based health check.

Migrations run on startup. Live updates are fanned out in memory, so run a single API instance.

**Web**: any static host. Set `NEXT_PUBLIC_API_URL` at build time and publish `web/out/`. On Vercel, set the root directory to `web` and it works with no other configuration.
