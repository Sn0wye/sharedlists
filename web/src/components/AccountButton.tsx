"use client";

import { useState } from "react";
import { logout, startLogin } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import { Sheet } from "./Sheet";
import { GitHub, Google } from "./icons";

export function AccountButton() {
  const { status, user } = useAuth();
  const [open, setOpen] = useState(false);

  if (status === "loading") return <span className="size-9" aria-hidden />;

  return (
    <>
      {user ? (
        <button onClick={() => setOpen(true)} aria-label={`Conta de ${user.username}`} className="press rounded-full">
          {user.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar_url} alt="" className="size-9 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span className="grid size-9 place-items-center rounded-full bg-ink text-[15px] font-semibold text-on-ink">
              {(user.username ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
        </button>
      ) : (
        <button onClick={() => setOpen(true)} className="press h-9 rounded-full bg-surface px-4 text-[15px] font-semibold">
          Entrar
        </button>
      )}

      {user ? (
        <Sheet open={open} onOpenChange={setOpen} title={user.username ?? "Conta"}>
          <button
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="press flex h-13 w-full items-center justify-center rounded-2xl bg-bg text-[17px] font-semibold text-danger"
          >
            Sair
          </button>
        </Sheet>
      ) : (
        <Sheet
          open={open}
          onOpenChange={setOpen}
          title="Entrar"
          description="Opcional. Com uma conta, seu nome aparece no que você adiciona e marca."
        >
          <div className="flex flex-col gap-2.5">
            <Provider onClick={() => startLogin("google")} icon={<Google />} label="Continuar com Google" />
            <Provider onClick={() => startLogin("github")} icon={<GitHub />} label="Continuar com GitHub" />
          </div>
        </Sheet>
      )}
    </>
  );
}

function Provider({ onClick, icon, label }: { onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className="press flex h-13 w-full items-center justify-center gap-3 rounded-2xl bg-bg text-[17px] font-semibold"
    >
      {icon}
      {label}
    </button>
  );
}
