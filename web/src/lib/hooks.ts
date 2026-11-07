"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { API_URL, authStore, type RealtimeEvent } from "./api";

export function useAuth() {
  return useSyncExternalStore(authStore.subscribe, authStore.get, () => authStore.serverSnapshot);
}

export type Connection = "connecting" | "open" | "offline";

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
): Connection {
  const [connection, setConnection] = useState<Connection>("connecting");
  const handlers = useRef({ onEvent, onResync });
  useEffect(() => {
    handlers.current = { onEvent, onResync };
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
      socket = new WebSocket(url);
      socket.onopen = () => {
        setConnection("open");
        if (attempt > 0) handlers.current.onResync();
        attempt = 0;
      };
      socket.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as RealtimeEvent;
        if (event.type === "resync") handlers.current.onResync();
        else handlers.current.onEvent(event);
      };
      socket.onclose = () => {
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
