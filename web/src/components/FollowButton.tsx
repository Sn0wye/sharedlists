"use client";

import { useEffect, useState } from "react";
import { follow, followState, unfollow, type FollowState } from "@/lib/push";
import { toast } from "@/lib/toast";
import { Bell } from "./icons";

/** Bell in the list's top bar: get a notification when someone else adds an item. */
export function FollowButton({ listId, token }: { listId: string; token: string }) {
  const [state, setState] = useState<FollowState>({ mode: "hidden", following: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    followState(listId)
      .then((s) => live && setState(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [listId]);

  if (state.mode === "hidden") return null;

  async function onClick() {
    if (state.mode === "install") {
      return toast("Adicione à Tela de Início para ativar.");
    }
    if (busy) return;
    setBusy(true);
    try {
      if (state.following) {
        await unfollow(listId);
        setState({ ...state, following: false });
        toast("Notificações desativadas para esta lista.");
      } else if ((await follow(listId, token)) === "denied") {
        toast("Notificações bloqueadas no navegador.");
      } else {
        setState({ ...state, following: true });
        toast("Notificações ativadas para esta lista.");
      }
    } catch {
      toast("Não deu para mudar. Confira sua conexão.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      aria-pressed={state.following}
      aria-label={state.following ? "Desativar notificações desta lista" : "Ativar notificações desta lista"}
      className="press grid size-10 place-items-center disabled:opacity-60"
      disabled={busy}
    >
      <Bell filled={state.following} className="size-[22px]" />
    </button>
  );
}
