"use client";

import { useEffect, useState } from "react";
import { getAccessToken, type User } from "./api";
import { useAuth, type RealtimeLink } from "./hooks";

/** One open socket in the list room. The same person in two tabs is two peers. */
export type Peer = { id: string; name: string | null; color: string | null; focus: string | null; typing: boolean };

export type PresenceEvent =
  | { type: "presence"; count: number; peers: Peer[] }
  | { type: "presence_self"; id: string };

/** Typing is re-sent this often while it continues; the server drops it after 5s without one. */
const TYPING_REFRESH_MS = 2000;
/** No keystroke for this long counts as having stopped. */
const TYPING_IDLE_MS = 2500;
/** How long touching an item marks you as being on it. */
const FOCUS_MS = 3000;

// [animal, grammatical gender] so the adjective agrees: "Capivara anônima", "Tucano anônimo".
const ANIMALS: [string, "a" | "o"][] = [
  ["Capivara", "a"], ["Onça", "a"], ["Arara", "a"], ["Coruja", "a"], ["Raposa", "a"],
  ["Lontra", "a"], ["Baleia", "a"], ["Girafa", "a"], ["Preguiça", "a"], ["Tartaruga", "a"],
  ["Ariranha", "a"], ["Seriema", "a"], ["Tamanduá", "o"], ["Tucano", "o"], ["Boto", "o"],
  ["Quati", "o"], ["Lobo-guará", "o"], ["Pinguim", "o"], ["Panda", "o"], ["Esquilo", "o"],
  ["Golfinho", "o"], ["Polvo", "o"], ["Flamingo", "o"], ["Jabuti", "o"], ["Tatu", "o"],
  ["Sabiá", "o"], ["Beija-flor", "o"], ["Mico-leão", "o"], ["Ouriço", "o"], ["Coala", "o"],
];

// Apple system hues that hold white text and stay clear of the green "done" accent.
const COLORS = ["#007aff", "#5856d6", "#af52de", "#ff2d55", "#ff9500", "#30b0c7", "#a2845e", "#d94f8c"];

const STORAGE_KEY = "sl_presence";

type Identity = { name: string; color: string };

/** The anonymous name and colour for this device, picked once and kept in localStorage. */
function deviceIdentity(): Identity {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Identity | null;
    if (saved?.name && saved.color) return saved;
  } catch {}
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const [animal, gender] = pick(ANIMALS);
  const identity = { name: `${animal} ${gender === "a" ? "anônima" : "anônimo"}`, color: pick(COLORS) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

/** Logged-in users get the same colour on every device. */
function colorFor(username: string) {
  let h = 0;
  for (const ch of username.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

export const peerName = (p: Peer) => p.name ?? "Alguém";
export const peerColor = (p: Peer) => p.color ?? "var(--text-2)";
const personKey = (p: Peer) => (p.name ? `${p.name}${p.color}` : p.id);

/** Socket-side state and timers, created once per list view. */
function createChannel(setPeers: (p: Peer[]) => void, setSelfId: (id: string | null) => void) {
  let send: ((msg: object) => void) | null = null;
  let user: User | null | undefined; // undefined while auth is still loading
  let focus: string | null = null;
  let typing = false;
  let typingSentAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  const pushState = () => send?.({ type: "state", focus, typing });
  const hello = () => {
    // Wait for auth so a logged-in user doesn't flash by under an animal name.
    if (!send || user === undefined) return;
    const device = deviceIdentity();
    const username = user?.username;
    send({
      type: "hello",
      token: username ? getAccessToken() : null,
      name: device.name,
      color: username ? colorFor(username) : device.color,
    });
  };

  const setTyping = (active: boolean) => {
    clearTimeout(idleTimer);
    if (active) {
      idleTimer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
      if (typing && Date.now() - typingSentAt < TYPING_REFRESH_MS) return;
      typingSentAt = Date.now();
    } else if (!typing) {
      return;
    }
    typing = active;
    pushState();
  };

  return {
    link: {
      onOpen(s) {
        send = s;
        hello();
        if (focus || typing) pushState();
      },
      onClose() {
        send = null;
        setPeers([]);
        setSelfId(null);
      },
    } satisfies RealtimeLink,

    receive(e: PresenceEvent) {
      if (e.type === "presence") setPeers(e.peers ?? []);
      else setSelfId(e.id);
    },

    identify(next: User | null | undefined) {
      user = next;
      hello();
    },

    /** Call on every keystroke in the composer with whether it holds text. Throttled and debounced here. */
    setTyping,

    /** Marks this person as on `itemId` for a few seconds. */
    touch(itemId: string) {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focus = null;
        pushState();
      }, FOCUS_MS);
      if (focus === itemId) return;
      focus = itemId;
      pushState();
    },

    dispose() {
      clearTimeout(idleTimer);
      clearTimeout(focusTimer);
    },
  };
}

/**
 * Live presence for the list open on this socket: who else is here, who is typing, and
 * which item each person is on. Pass `link` to `useRealtime` and route presence events to `receive`.
 */
export function usePresence() {
  const { status, user } = useAuth();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [channel] = useState(() => createChannel(setPeers, setSelfId));

  useEffect(() => channel.identify(status === "ready" ? user : undefined), [channel, status, user]);
  useEffect(() => () => channel.dispose(), [channel]);

  const self = peers.find((p) => p.id === selfId) ?? null;
  // Your other tabs share your name and colour; leave them out along with this one.
  const others = peers.filter((p) => p.id !== selfId && !(self?.name && personKey(p) === personKey(self)));
  const people = [...new Map(others.map((p) => [personKey(p), p])).values()];
  const typers = [...new Map(others.filter((p) => p.typing).map((p) => [personKey(p), p])).values()];

  const at = (itemId: string) => others.filter((p) => p.focus === itemId);

  return { self, people, typers, at, link: channel.link, receive: channel.receive, setTyping: channel.setTyping, touch: channel.touch };
}
