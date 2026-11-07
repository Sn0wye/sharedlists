"use client";

import { useSyncExternalStore } from "react";

// Pinned lists are a per-device preference, kept in localStorage next to the saved lists
// (`listas:lists`). Lists are shared by link without accounts, so a pin stored on the list
// would reorder the home screen of everyone who has the link.

const KEY = "sl_pinned";
const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;

function read(): readonly string[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : EMPTY;
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function write(ids: readonly string[]) {
  cache = ids;
  localStorage.setItem(KEY, JSON.stringify(ids));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Other tabs of the PWA.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePinned(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function setPinned(id: string, pinned: boolean) {
  const ids = read().filter((p) => p !== id);
  write(pinned ? [id, ...ids] : ids);
}

/** Drops a pin silently, e.g. when the list is deleted. */
export function forgetPin(id: string) {
  if (read().includes(id)) setPinned(id, false);
}

/** Drops pins of lists not in `ids` (the lists saved on this device). */
export function keepPins(ids: ReadonlySet<string>) {
  const current = read();
  const kept = current.filter((id) => ids.has(id));
  if (kept.length !== current.length) write(kept);
}
