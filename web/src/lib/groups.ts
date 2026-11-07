import { api, authStore, type GroupInfo, type Role } from "./api";

/**
 * Groups this device has opened, kept in localStorage. The link token is the only key to a
 * group, so losing it here means asking someone for the link again. Logged-in users also keep
 * a copy on their account, which syncs the list between devices.
 */
export type SavedGroup = {
  id: string;
  name: string;
  token: string;
  role: Role;
  list_count: number;
  opened_at: number;
  /** Account that has this exact token saved. Tells "removed on another device" apart from "never uploaded". */
  synced_by?: string;
};

type Remote = { token: string; group: GroupInfo };

const KEY = "listas:groups";
const EMPTY: SavedGroup[] = [];
const listeners = new Set<() => void>();
let cache: SavedGroup[] | null = null;

function read(): SavedGroup[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache!;
}

function write(next: SavedGroup[]) {
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
}

const update = (fn: (all: SavedGroup[]) => SavedGroup[]) => write(fn(read()));

if (typeof window !== "undefined") {
  // Another tab opened or removed a group.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    cache = null;
    listeners.forEach((l) => l());
  });
}

export const groupStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: read,
  serverSnapshot: EMPTY,
};

export const groupUrl = (token: string) => `/g/?t=${encodeURIComponent(token)}`;

export const findGroupByToken = (token: string) => read().find((g) => g.token === token);

const userId = () => authStore.get().user?.id ?? null;

/** Applies a server view of a group. An edit link is kept when the same group comes back read-only. */
function merge(all: SavedGroup[], group: GroupInfo, token: string, extra: Partial<SavedGroup> = {}): SavedGroup[] {
  const old = all.find((g) => g.id === group.id);
  const keepOld = old && old.token !== token && old.role === "edit" && group.role === "read";
  const entry: SavedGroup = {
    id: group.id,
    name: group.name,
    list_count: group.list_count,
    opened_at: old?.opened_at ?? Date.now(),
    ...(keepOld
      ? { token: old.token, role: old.role, synced_by: old.synced_by }
      : { token, role: group.role, synced_by: old?.token === token ? old.synced_by : undefined }),
    ...extra,
  };
  return all.map((g) => (g.id === group.id ? entry : g)).concat(old ? [] : [entry]);
}

async function upload(id: string) {
  const user = userId();
  const g = read().find((x) => x.id === id);
  if (!user || !g || g.synced_by === user) return;
  try {
    await api("/me/groups", { method: "POST", body: { token: g.token } });
    update((all) => all.map((x) => (x.id === id && x.token === g.token ? { ...x, synced_by: user } : x)));
  } catch {
    // Retried on the next sync.
  }
}

/** Called whenever a group page loads with a working token. */
export function rememberGroup(group: GroupInfo, token: string) {
  update((all) => merge(all, group, token, { opened_at: Date.now() }));
  void upload(group.id);
}

export function patchGroup(id: string, patch: Partial<Pick<SavedGroup, "name" | "list_count">>) {
  update((all) => all.map((g) => (g.id === id ? { ...g, ...patch } : g)));
}

/** The token stopped working (wrong link, or it was rotated). */
export function dropToken(token: string) {
  update((all) => all.filter((g) => g.token !== token));
}

/** Removes the group from this device and from the account. The group itself stays. */
export async function forgetGroup(id: string) {
  update((all) => all.filter((g) => g.id !== id));
  if (userId()) await api(`/me/groups/${id}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Home screen refresh: merges the account's groups (when logged in), uploads the ones the
 * account lacks, then refreshes names and counts and forgets links that stopped working.
 */
export async function syncGroups() {
  const user = userId();
  if (user) {
    const remote = await api<Remote[]>("/me/groups");
    const byId = new Map(remote.map((r) => [r.group.id, r]));
    update((all) => {
      // Synced before but gone from the account: removed on another device, or rotated.
      let next = all.filter((g) => g.synced_by !== user || byId.has(g.id));
      for (const r of remote) {
        next = merge(next, r.group, r.token).map((g) =>
          g.id === r.group.id && g.token === r.token ? { ...g, synced_by: user } : g,
        );
      }
      return next;
    });
    const missing = read().filter((g) => {
      const r = byId.get(g.id);
      return !r || (r.group.role === "read" && g.role === "edit");
    });
    await Promise.all(missing.map((g) => upload(g.id)));
  }

  const tokens = read().map((g) => g.token);
  if (tokens.length === 0) return;
  const valid = await api<Remote[]>("/groups/resolve", { method: "POST", body: { tokens } });
  const byToken = new Map(valid.map((r) => [r.token, r.group]));
  const asked = new Set(tokens);
  update((all) =>
    all.flatMap((g) => {
      if (!asked.has(g.token)) return [g];
      const fresh = byToken.get(g.token);
      return fresh ? [{ ...g, name: fresh.name, role: fresh.role, list_count: fresh.list_count }] : [];
    }),
  );
}
