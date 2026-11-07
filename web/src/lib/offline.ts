// Offline support for everything inside a list: an outbox of pending writes kept in IndexedDB,
// plus the last copy of each opened list so the app opens and searches without a connection.
//
// Conflict rules (the server stays the source of truth):
// - Every write is idempotent. Adds carry the client-generated id, so a retry that already
//   landed answers 409 and counts as done. Ticks, quantities and titles send the final value,
//   moves say "right after item X", and deleting something already gone counts as done.
// - Ops are sent in the order they were made (consecutive adds and undos go as one batch).
//   Whatever reaches the server last wins, the same as when two people tap at once online.
// - Delete wins over edits: an edit or move on an item someone else deleted is dropped, and so
//   is everything queued for a list that was deleted.
// - Queued ops on the same item collapse until their first send attempt: tick+untick leaves only
//   the final value, a burst of quantity taps or moves leaves the last one, add+delete leaves
//   nothing, delete+undo leaves the item as it was. An op that was already attempted (the server
//   may have it) is never collapsed; its undo is sent after it instead.
// - Undo after a delete that did reach the server uses the server's trash, which keeps items
//   for a few minutes. Older than that, the undo is dropped with a toast.
// - Anything the server rejects is dropped with a toast and the list is refetched, so the screen
//   never keeps showing a change that didn't stick.

import { useMemo, useSyncExternalStore } from "react";
import { api, ApiError, uuid, type Item, type ListDetail, type SearchHit } from "./api";
import { idbGet, idbSet, idbUpdate } from "./idb";
import { deviceHeaders } from "./push";
import { toast } from "./toast";

type Base = { id: string; listId: string; token: string; itemId: string; sending?: boolean };
export type Op =
  | (Base & { kind: "add"; item: Item })
  | (Base & { kind: "toggle"; done: boolean; at: string; by: string | null })
  | (Base & { kind: "quantity"; quantity: number })
  | (Base & { kind: "move"; after: string | null; position: string | null })
  | (Base & { kind: "delete" })
  | (Base & { kind: "restore"; item: Item })
  | (Base & { kind: "rename"; title: string });

const KEY = "outbox";
/** Server limits: `MAX_BATCH` items per add, and far more per restore. */
const MAX_BATCH = 200;

// ---------- store ----------

type State = { ops: Op[]; stalled: boolean };
/** `stalled`: the last attempt couldn't reach the server, so pending changes are worth showing. */
let state: State = { ops: [], stalled: false };
const listeners = new Set<() => void>();
const discardListeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  if (!state.ops.length) state.stalled = false;
  listeners.forEach((l) => l());
}

const serverState: State = { ops: [], stalled: false };
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useOutbox() {
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}

/** Ids of items with changes that couldn't be sent yet. Empty while syncing normally, to avoid flicker. */
export function usePendingItems(listId: string | null): ReadonlySet<string> {
  const { ops, stalled } = useOutbox();
  return useMemo(
    () => new Set(stalled ? ops.filter((o) => o.listId === listId).map((o) => o.itemId) : []),
    [ops, stalled, listId],
  );
}

/** Called after the server rejected queued changes, so screens can refetch the truth. */
export function onDiscard(listener: () => void) {
  discardListeners.add(listener);
  return () => void discardListeners.delete(listener);
}

// ---------- persistence ----------

let channel: BroadcastChannel | null = null;
let writes = 0;
let started = false;
let markReady: () => void;
const ready = new Promise<void>((r) => (markReady = r));

/** Applies `fn` in memory right away, then to the stored queue (which other tabs may have changed). */
async function persist(fn: (ops: Op[]) => Op[]) {
  set({ ops: fn(state.ops) });
  writes++;
  try {
    const stored = await idbUpdate<Op[]>(KEY, (cur) => fn(cur ?? []));
    // Transactions run in order, so the last write to finish holds every change.
    if (writes === 1) set({ ops: stored });
    channel?.postMessage("changed");
  } catch {
    // No IndexedDB (some private modes): the queue still works for this session.
  } finally {
    writes--;
  }
}

async function reload() {
  const stored = await idbGet<Op[]>(KEY).catch(() => undefined);
  if (stored && writes === 0) set({ ops: stored });
}

export function startOutbox() {
  if (started || typeof window === "undefined") return;
  started = true;
  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel("listas-outbox");
    channel.onmessage = () => void reload();
  }
  window.addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flush();
  });
  void reload().finally(() => {
    markReady();
    void flush();
  });
}

// ---------- queueing ----------

const idle = (o: Op, itemId: string) => o.itemId === itemId && !o.sending;
const base = (token: string, listId: string, itemId: string) => ({ id: uuid(), token, listId, itemId });
/** Replaces a not-yet-sent op of the same kind on the same item: only the final value matters. */
const replacing = (op: Op) => (ops: Op[]) => [...ops.filter((o) => !(idle(o, op.itemId) && o.kind === op.kind)), op];
const queue = (fn: (ops: Op[]) => Op[]) => void persist(fn).then(flush);

export function queueAdd(token: string, items: Item[]) {
  const adds: Op[] = items.map((item) => ({ ...base(token, item.list_id, item.id), kind: "add", item }));
  queue((ops) => [...ops, ...adds]);
}

export function queueToggle(token: string, item: Item, done: boolean, by: string | null) {
  const at = new Date().toISOString();
  queue(replacing({ ...base(token, item.list_id, item.id), kind: "toggle", done, at, by }));
}

export function queueQuantity(token: string, item: Item, quantity: number) {
  queue(replacing({ ...base(token, item.list_id, item.id), kind: "quantity", quantity }));
}

/** `position` is the local guess for the new key (null if neighbours tie); the server picks the real one. */
export function queueMove(token: string, item: Item, after: string | null, position: string | null) {
  queue(replacing({ ...base(token, item.list_id, item.id), kind: "move", after, position }));
}

export function queueRename(token: string, listId: string, title: string) {
  queue(replacing({ ...base(token, listId, `list:${listId}`), kind: "rename", title }));
}

export function queueDelete(token: string, items: Item[]) {
  queue((ops) => {
    let next = ops;
    for (const item of items) {
      // Never sent: nobody else has seen the item, so the add and its edits just disappear.
      const unsent = next.some((o) => idle(o, item.id) && o.kind === "add");
      if (unsent) next = next.filter((o) => !idle(o, item.id));
      else next = [...next, { ...base(token, item.list_id, item.id), kind: "delete" }];
    }
    return next;
  });
}

/** Undo for delete and clear-done. A delete that hasn't been sent is simply cancelled. */
export function queueRestore(token: string, items: Item[]) {
  queue((ops) => {
    let next = ops;
    for (const item of items) {
      const pending = next.find((o) => idle(o, item.id) && o.kind === "delete");
      if (pending) next = next.filter((o) => o.id !== pending.id);
      else next = [...next, { ...base(token, item.list_id, item.id), kind: "restore", item }];
    }
    return next;
  });
}

/** Server data with this device's pending changes applied on top. */
export function withPending(d: ListDetail | null): ListDetail | null {
  if (!d) return d;
  const mine = state.ops.filter((o) => o.listId === d.list.id);
  if (!mine.length) return d;
  let { list, items } = d;
  const edit = (id: string, fn: (i: Item) => Item) => (items = items.map((i) => (i.id === id ? fn(i) : i)));
  for (const op of mine) {
    switch (op.kind) {
      case "add":
      case "restore":
        if (!items.some((i) => i.id === op.itemId)) items = [...items, op.item];
        break;
      case "delete":
        items = items.filter((i) => i.id !== op.itemId);
        break;
      case "toggle":
        edit(op.itemId, (i) =>
          i.done === op.done
            ? i
            : { ...i, done: op.done, done_at: op.done ? op.at : null, done_by_name: op.done ? op.by : null },
        );
        break;
      case "quantity":
        edit(op.itemId, (i) => ({ ...i, quantity: op.quantity }));
        break;
      case "move":
        if (op.position) edit(op.itemId, (i) => ({ ...i, position: op.position! }));
        break;
      case "rename":
        list = { ...list, title: op.title };
        break;
    }
  }
  return { list, items };
}

// ---------- syncing ----------

/** `retry-single`: a batch hit an id that already exists; send its ops one by one. */
type Outcome = "ok" | "retry" | "retry-single" | "drop" | "list-gone";

const transient = (e: unknown) =>
  !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

/** Ops sent together with the first one: a run of adds (one batch request) or undos. */
function batchOf(ops: Op[]): Op[] {
  const [first] = ops;
  if (first.kind !== "add" && first.kind !== "restore") return [first];
  const run: Op[] = [];
  for (const o of ops) {
    if (o.kind !== first.kind || o.listId !== first.listId || run.length === MAX_BATCH) break;
    run.push(o);
  }
  return run;
}

async function send(batch: Op[]): Promise<Outcome> {
  const op = batch[0];
  const opts = { token: op.token };
  try {
    switch (op.kind) {
      case "add": {
        const items = batch.map((o) => ({ id: o.itemId, text: (o as Op & { kind: "add" }).item.text }));
        const headers = deviceHeaders();
        if (items.length === 1) await api("/list/items", { method: "POST", body: items[0], headers, ...opts });
        else await api("/list/items/batch", { method: "POST", body: { items }, headers, ...opts });
        break;
      }
      case "restore":
        await api("/list/items/restore", { method: "POST", body: { ids: batch.map((o) => o.itemId) }, ...opts });
        break;
      case "toggle":
        await api(`/items/${op.itemId}`, { method: "PATCH", body: { done: op.done }, ...opts });
        break;
      case "quantity":
        await api(`/items/${op.itemId}`, { method: "PATCH", body: { quantity: op.quantity }, ...opts });
        break;
      case "move":
        await api(`/items/${op.itemId}/move`, { method: "POST", body: { after: op.after }, ...opts });
        break;
      case "delete":
        await api(`/items/${op.itemId}`, { method: "DELETE", ...opts });
        break;
      case "rename":
        await api("/list", { method: "PATCH", body: { title: op.title }, ...opts });
        break;
    }
    return "ok";
  } catch (e) {
    // Network failure, server trouble or rate limiting: keep it and try again later.
    if (transient(e)) return "retry";
    const status = (e as ApiError).status;
    if (op.kind === "add" && status === 409) return batch.length === 1 ? "ok" : "retry-single"; // an earlier attempt landed
    if (op.kind === "delete" && status === 404) return "ok"; // someone else deleted it first
    if ((op.kind === "add" || op.kind === "rename") && status === 404) return "list-gone";
    return "drop";
  }
}

let flushing = false;
/** Grows only when the retry timer fires, so a burst of offline taps doesn't push the next try out. */
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const retryLater = () => {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    attempt++;
    void flush();
  }, Math.min(1000 * 2 ** attempt, 30_000));
};

export async function flush() {
  if (flushing || !started) return;
  clearTimeout(retryTimer);
  if (!state.ops.length) return;
  if (!navigator.onLine) return set({ stalled: true }); // the `online` event flushes
  flushing = true;
  try {
    // One tab sends at a time; the others would only race it and reorder ops.
    if (navigator.locks) {
      await navigator.locks.request("listas-outbox", { ifAvailable: true }, (lock) => (lock ? drain() : undefined));
    } else {
      await drain();
    }
  } finally {
    flushing = false;
  }
}

async function drain() {
  let discarded = 0;
  let single = false;
  try {
    for (;;) {
      await reload();
      if (!state.ops.length) return;
      // After a batch hit an id that already exists, send that run one by one to find it.
      const batch = single ? [state.ops[0]] : batchOf(state.ops);
      const ids = new Set(batch.map((o) => o.id));
      // Marked so queueing doesn't collapse an op the server may already have.
      await persist((ops) => ops.map((o) => (ids.has(o.id) ? { ...o, sending: true } : o)));
      const outcome = await send(batch);
      if (outcome === "retry-single") {
        single = true;
        continue;
      }
      single = false;
      if (outcome === "retry") {
        set({ stalled: true });
        return retryLater();
      }
      attempt = 0;
      if (outcome !== "ok") discarded += batch.length;
      const listId = batch[0].listId;
      await persist((ops) => ops.filter((o) => !ids.has(o.id) && !(outcome === "list-gone" && o.listId === listId)));
      set({ stalled: false });
    }
  } finally {
    if (discarded) {
      toast(discarded === 1 ? "Uma alteração offline não foi salva." : `${discarded} alterações offline não foram salvas.`);
      discardListeners.forEach((l) => l());
    }
  }
}

// ---------- snapshots ----------

const snapshotKey = (token: string) => `list:${token}`;

/**
 * Fetches a list and keeps a copy; without a connection, answers with the last copy.
 * Waits for the outbox so callers can lay pending changes over the result.
 */
export async function loadList(token: string): Promise<ListDetail> {
  startOutbox();
  await ready;
  try {
    const value = await api<ListDetail>("/list", { token });
    saveList(token, value);
    void flush(); // the server is reachable again
    return value;
  } catch (e) {
    if (!transient(e)) throw e;
    const cached = await idbGet<ListDetail>(snapshotKey(token)).catch(() => undefined);
    if (!cached) throw e;
    return cached;
  }
}

export function saveList(token: string, detail: ListDetail) {
  void idbSet(snapshotKey(token), detail).catch(() => {});
}

/** Case- and accent-insensitive, like the home screen's title filter. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Item search over the copies of lists kept on this device, for when the API can't be reached. */
export async function searchOffline(q: string, lists: { id: string; token: string }[]): Promise<SearchHit[]> {
  await ready;
  const needle = fold(q);
  const hits: SearchHit[] = [];
  for (const { id, token } of lists) {
    const detail = withPending(await idbGet<ListDetail>(snapshotKey(token)).catch(() => undefined) ?? null);
    const found = detail?.items.filter((i) => fold(i.text).includes(needle)) ?? [];
    if (found.length) hits.push({ list_id: id, text: found[0].text, matches: found.length });
  }
  return hits;
}
