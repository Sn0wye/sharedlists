"use client";

import { useEffect, useState } from "react";

export type Toast = {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
};

type Input = string | Omit<Toast, "id">;

const listeners = new Set<(toast: Toast) => void>();
let nextId = 0;

export function toast(input: Input) {
  const t: Toast = { id: nextId++, ...(typeof input === "string" ? { message: input } : input) };
  listeners.forEach((l) => l(t));
}

/** Current toast, or null. Toasts with an action stay longer so there's time to use it. */
export function useToast() {
  const [current, setCurrent] = useState<Toast | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = (t: Toast) => {
      setCurrent(t);
      clearTimeout(timer);
      timer = setTimeout(() => setCurrent(null), t.action ? 5000 : 2800);
    };
    listeners.add(show);
    return () => {
      listeners.delete(show);
      clearTimeout(timer);
    };
  }, []);
  return [current, () => setCurrent(null)] as const;
}
