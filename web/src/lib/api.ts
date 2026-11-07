import type { PresenceEvent } from "./presence";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export type User = { id: string; username: string | null; avatar_url: string | null };

export type ListSummary = {
  id: string;
  title: string;
  created_by: string | null;
  item_count: number;
  done_count: number;
  updated_at: string;
};

export type Item = {
  id: string;
  list_id: string;
  text: string;
  done: boolean;
  /** Fractional order key; compare as plain strings. */
  position: string;
  quantity: number;
  created_by_name: string | null;
  done_by_name: string | null;
  created_at: string;
  done_at: string | null;
};

export type ListDetail = { list: ListSummary; items: Item[] };

/** A list with the secret link token that opens it. */
export type LinkedList = { token: string; list: ListSummary };

/** `POST /lists/search`: the first matching item of each list and how many items matched. */
export type SearchHit = { list_id: string; text: string; matches: number };

export type RealtimeEvent =
  | { type: "list_upserted"; list: ListSummary }
  | { type: "list_deleted"; id: string }
  | { type: "item_upserted"; item: Item }
  | { type: "item_deleted"; id: string }
  | PresenceEvent
  | { type: "resync" };

type AuthResponse = { access_token: string; user: User };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- session store ----------
// The access token lives only in memory; the refresh token is an HttpOnly cookie on the API.
// A localStorage flag avoids a pointless refresh call for visitors who never logged in.

const SESSION_FLAG = "sl_session";

type AuthState = { status: "loading" | "ready"; user: User | null };

let accessToken: string | null = null;
let state: AuthState = { status: "loading", user: null };
const listeners = new Set<() => void>();

function setState(next: AuthState) {
  state = next;
  listeners.forEach((l) => l());
}

/** For the presence `hello`, which proves the username over the socket. */
export const getAccessToken = () => accessToken;

export const authStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => state,
  serverSnapshot: { status: "loading", user: null } as AuthState,
};

function applyAuth(res: AuthResponse | null) {
  accessToken = res?.access_token ?? null;
  if (res) localStorage.setItem(SESSION_FLAG, "1");
  else localStorage.removeItem(SESSION_FLAG);
  setState({ status: "ready", user: res?.user ?? null });
}

let refreshing: Promise<boolean> | null = null;

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" });
      if (res.status === 401 || res.status === 403) {
        applyAuth(null);
        return false;
      }
      if (!res.ok) throw new Error(String(res.status));
      applyAuth(await res.json());
      return true;
    } catch {
      // Offline or API down: keep whatever we had and let the user retry later.
      setState({ ...state, status: "ready" });
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function initAuth() {
  // The callback page performs its own refresh right after login.
  if (location.pathname.startsWith("/auth/callback")) return;
  if (localStorage.getItem(SESSION_FLAG)) void refreshSession();
  else setState({ status: "ready", user: null });
}

export function startLogin(provider: "google" | "github") {
  sessionStorage.setItem("sl_return", location.pathname + location.search);
  // External: the API host, not a Next.js page.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  location.assign(`${API_URL}/auth/${provider}`);
}

export async function logout() {
  await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  applyAuth(null);
}

export async function setUsername(username: string) {
  applyAuth(await api<AuthResponse>("/me", { method: "PATCH", body: { username } }));
}

// ---------- requests ----------

/** `token` is a list's link token, which every list and item route needs. */
type RequestOptions = { method?: string; body?: unknown; token?: string; headers?: Record<string, string> };

export async function api<T>(path: string, { method = "GET", body, token, headers }: RequestOptions = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...(token && { "X-List-Token": token }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res = await send();
  // Access tokens last 15 minutes; refresh once and replay.
  if (res.status === 401 && accessToken) {
    accessToken = null;
    await refreshSession();
    res = await send();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** crypto.randomUUID needs a secure context, which a phone hitting a LAN dev server isn't. */
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
