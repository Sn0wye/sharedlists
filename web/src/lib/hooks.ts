"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { API_URL, authStore, type RealtimeEvent } from "./api";

export function useAuth() {
  return useSyncExternalStore(authStore.subscribe, authStore.get, () => authStore.serverSnapshot);
}

export type Connection = "connecting" | "open" | "offline";

/** Lets another hook (presence) talk over the same socket while it is open. */
export type RealtimeLink = { onOpen: (send: (msg: object) => void) => void; onClose: () => void };

/**
 * Subscribes to live events for one list, or for the group's screen when `listId` is null.
 * Reconnects with backoff; `onResync` fires after a reconnect so the caller can refetch
 * whatever it missed while disconnected.
 */
export function useRealtime(
  token: string | null,
  listId: string | null,
  onEvent: (e: RealtimeEvent) => void,
  onResync: () => void,
  link?: RealtimeLink,
): Connection {
  const [connection, setConnection] = useState<Connection>("connecting");
  const handlers = useRef({ onEvent, onResync, link });
  useEffect(() => {
    handlers.current = { onEvent, onResync, link };
  });

  useEffect(() => {
    if (!token) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;
    const query = new URLSearchParams({ group: token, ...(listId && { list: listId }) });
    const url = `${API_URL.replace(/^http/, "ws")}/ws?${query}`;

    const connect = () => {
      const s = new WebSocket(url);
      socket = s;
      s.onopen = () => {
        setConnection("open");
        handlers.current.link?.onOpen((msg) => s.readyState === WebSocket.OPEN && s.send(JSON.stringify(msg)));
        if (attempt > 0) handlers.current.onResync();
        attempt = 0;
      };
      s.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as RealtimeEvent;
        if (event.type === "resync") handlers.current.onResync();
        else handlers.current.onEvent(event);
      };
      s.onclose = () => {
        handlers.current.link?.onClose();
        if (closed) return;
        setConnection("offline");
        attempt++;
        retry = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15000));
      };
    };

    // Phones suspend sockets in the background; reconnect immediately when the app returns.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || socket?.readyState === WebSocket.OPEN) return;
      clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.close();
        handlers.current.link?.onClose();
      }
      attempt = Math.max(attempt, 1);
      connect();
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, [token, listId]);

  return connection;
}
