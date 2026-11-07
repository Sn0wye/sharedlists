import { api, ApiError, authStore, type LinkedList, type ListSummary } from "./api";
import { unfollow } from "./push";

/**
 * Lists this device has opened, kept in localStorage. The link token is the only key to a
 * list, so losing it here means asking someone for the link again. Logged-in users also keep
 * a copy on their account, which syncs the home screen between devices.
 */
export type SavedList = ListSummary & {
  token: string;
  opened_at: number;
  /** Account that has this list saved. Tells "removed on another device" apart from "never uploaded". */
  synced_by?: string;
};

const KEY = "listas:lists";
const EMPTY: SavedList[] = [];
const listeners = new Set<() => void>();
let cache: SavedList[] | null = null;

function read(): SavedList[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache!;
}

function write(next: SavedList[]) {
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
}

const update = (fn: (all: SavedList[]) => SavedList[]) => write(fn(read()));

if (typeof window !== "undefined") {
  // Another tab opened or removed a list.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    cache = null;
    listeners.forEach((l) => l());
  });
}

export const savedStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: read,
  serverSnapshot: EMPTY,
};

export const listUrl = (token: string) => `/list/?t=${encodeURIComponent(token)}`;

export const findByToken = (token: string) => read().find((l) => l.token === token);

const userId = () => authStore.get().user?.id ?? null;

/** Applies a server view of a list, adding it if it is new here. */
function merge(all: SavedList[], { token, list }: LinkedList, extra: Partial<SavedList> = {}): SavedList[] {
  const old = all.find((l) => l.id === list.id);
  const entry: SavedList = { ...old, ...list, token, opened_at: old?.opened_at ?? Date.now(), ...extra };
  return old ? all.map((l) => (l.id === list.id ? entry : l)) : [...all, entry];
}

async function upload(id: string) {
  const user = userId();
  const l = read().find((x) => x.id === id);
  if (!user || !l || l.synced_by === user) return;
  try {
    await api("/me/lists", { method: "POST", token: l.token });
    update((all) => all.map((x) => (x.id === id ? { ...x, synced_by: user } : x)));
  } catch {
    // Retried on the next sync.
  }
}

/** Called whenever a list page loads with a working token. */
export function rememberList(linked: LinkedList) {
  update((all) => merge(all, linked, { opened_at: Date.now() }));
  void upload(linked.list.id);
}

/** Keeps the home screen's title and counts current while the list is open. */
export function patchList(list: ListSummary) {
  update((all) => all.map((l) => (l.id === list.id ? { ...l, ...list } : l)));
}

/** The list is gone (deleted, or the link was wrong). */
export function dropToken(token: string) {
  update((all) => all.filter((l) => l.token !== token));
}

/** Removes the list from this device and from the account. The list itself stays. */
export async function forgetList(id: string) {
  update((all) => all.filter((l) => l.id !== id));
  // Notifications would open a list this device can no longer find.
  void unfollow(id).catch(() => {});
  if (userId()) await api(`/me/lists/${id}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Home screen refresh: merges the account's lists (when logged in), uploads the ones the
 * account lacks, then refreshes titles and counts and forgets lists that were deleted.
 */
export async function syncLists() {
  const user = userId();
  if (user) {
    const remote = await api<LinkedList[]>("/me/lists");
    const ids = new Set(remote.map((r) => r.list.id));
    update((all) => {
      // Synced before but gone from the account: removed on another device.
      let next = all.filter((l) => l.synced_by !== user || ids.has(l.id));
      for (const r of remote) next = merge(next, r, { synced_by: user });
      return next;
    });
    await Promise.all(read().filter((l) => !ids.has(l.id)).map((l) => upload(l.id)));
  }

  const tokens = read().map((l) => l.token);
  if (tokens.length === 0) return;
  const fresh = await api<LinkedList[]>("/lists/resolve", { method: "POST", body: { tokens } });
  const byToken = new Map(fresh.map((r) => [r.token, r.list]));
  const asked = new Set(tokens);
  update((all) =>
    all.flatMap((l) => {
      if (!asked.has(l.token)) return [l];
      const list = byToken.get(l.token);
      return list ? [{ ...l, ...list }] : [];
    }),
  );
}

export const isGone = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);
