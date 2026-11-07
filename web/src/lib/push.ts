// Web Push per device, no login. The browser keeps a random device id (its credential with the
// API) and follows lists one by one. See api/src/push.rs.

import { api, ApiError, uuid } from "./api";

const DEVICE = "sl_device";

/** Sent with item adds so the API doesn't notify the author's own device. */
export function deviceHeaders(): Record<string, string> {
  const id = typeof localStorage === "undefined" ? null : localStorage.getItem(DEVICE);
  return id ? { "X-Device-Id": id } : {};
}

function deviceId() {
  let id = localStorage.getItem(DEVICE);
  if (!id) localStorage.setItem(DEVICE, (id = uuid()));
  return id;
}

/** `install`: iPhone/iPad Safari, which only offers push once the app is on the home screen. */
export type PushSupport = "yes" | "install" | "no";

export function pushSupport(): PushSupport {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "yes";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios ? "install" : "no";
}

/** The worker is only registered in production builds (Providers), so dev just hides the bell. */
function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return process.env.NODE_ENV === "production" ? navigator.serviceWorker.ready : navigator.serviceWorker.getRegistration();
}

let key: Promise<string | null> | null = null;

/** The API's VAPID public key, or null when push isn't configured there. */
function serverKey() {
  key ??= api<{ public_key: string }>("/push/key").then(
    (r) => r.public_key,
    (e) => {
      key = null;
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    },
  );
  return key;
}

const bytes = (b64url: string) =>
  Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function sameKey(a: ArrayBuffer | null, b: Uint8Array) {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((x, i) => x === b[i]);
}

let following: Promise<Set<string>> | null = null;

/**
 * Lists this device follows. The first call per session also re-sends the subscription, which
 * browsers may rotate, and resolves to an empty set if the subscription or permission is gone.
 */
function loadFollowing(): Promise<Set<string>> {
  following ??= (async () => {
    const id = localStorage.getItem(DEVICE);
    if (!id || Notification.permission !== "granted") return new Set<string>();
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return new Set<string>();
    await api(`/push/devices/${id}`, { method: "POST", body: sub.toJSON() });
    return new Set(await api<string[]>(`/push/devices/${id}/lists`));
  })().catch((e) => {
    following = null;
    throw e;
  });
  return following;
}

export type FollowState = { mode: "hidden" | "install" | "ready"; following: boolean };

export async function followState(listId: string): Promise<FollowState> {
  const support = pushSupport();
  if (support === "install") return { mode: "install", following: false };
  if (support === "no" || !(await registration())) return { mode: "hidden", following: false };
  if (!(await serverKey())) return { mode: "hidden", following: false };
  return { mode: "ready", following: (await loadFollowing()).has(listId) };
}

/**
 * Must start inside a tap: browsers only show the permission prompt for a user gesture.
 * Following takes the list's link token, like reading it does.
 */
export async function follow(listId: string, token: string): Promise<"ok" | "denied"> {
  const permission = Notification.requestPermission();
  const [granted, publicKey, reg] = await Promise.all([permission, serverKey(), registration()]);
  if (granted !== "granted") return "denied";
  if (!publicKey || !reg) throw new Error("push not available");

  const appKey = bytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for an older server key can't receive pushes signed with the new one.
  if (sub && !sameKey(sub.options.applicationServerKey, appKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });

  const id = deviceId();
  await api(`/push/devices/${id}/lists`, { method: "POST", body: sub.toJSON(), token });
  const set = await (following ?? Promise.resolve(new Set<string>())).catch(() => new Set<string>());
  following = Promise.resolve(new Set(set).add(listId));
  return "ok";
}

export async function unfollow(listId: string) {
  const id = localStorage.getItem(DEVICE);
  if (id) await api(`/push/devices/${id}/lists/${listId}`, { method: "DELETE" });
  const set = new Set(await (following ?? Promise.resolve(new Set<string>())).catch(() => new Set<string>()));
  set.delete(listId);
  following = Promise.resolve(set);
}
