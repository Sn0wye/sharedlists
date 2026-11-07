"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type GroupLinks } from "@/lib/api";
import { groupStore, groupUrl, rememberGroup, syncGroups, type SavedGroup } from "@/lib/groups";
import { useAuth } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { AccountButton } from "./AccountButton";
import { Plus } from "./icons";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";

const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;
const noop = () => () => {};

export function HomeView() {
  const router = useRouter();
  const { status, user } = useAuth();
  const saved = useSyncExternalStore(groupStore.subscribe, groupStore.get, () => groupStore.serverSnapshot);
  // localStorage is unknown during the static render; don't flash the empty state.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const userId = user?.id;
  useEffect(() => {
    if (status === "ready") syncGroups().catch(() => {});
  }, [status, userId]);

  const groups = [...saved].sort((a, b) => b.opened_at - a.opened_at);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || creating) return;
    setCreating(true);
    try {
      const links = await api<GroupLinks>("/groups", { method: "POST", body: { name: clean } });
      rememberGroup(links.group, links.edit_token);
      router.push(groupUrl(links.edit_token));
    } catch {
      toast("Não deu para criar o grupo. Confira sua conexão.");
      setCreating(false);
    }
  }

  return (
    <>
      <header className="mx-auto flex max-w-lg items-end justify-between px-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-4">
        <h1 className="text-[2.125rem] leading-none font-bold tracking-[-0.02em]">Listas</h1>
        <AccountButton />
      </header>

      <main className="mx-auto max-w-lg px-4 pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {!hydrated ? null : groups.length === 0 ? (
          <Empty>
            Nenhum grupo neste aparelho. Crie um grupo e mande o link para quem vai usar junto. Quem tem o link
            entra sem cadastro.
          </Empty>
        ) : (
          <>
            <motion.ul layout className="overflow-hidden rounded-2xl bg-surface">
              <AnimatePresence initial={false}>
                {groups.map((group) => (
                  <motion.li
                    key={group.id}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ layout: SPRING, opacity: { duration: 0.2 }, height: { duration: 0.2 } }}
                    className="overflow-hidden border-b border-sep last:border-b-0"
                  >
                    <GroupRow group={group} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
            {status === "ready" && !user && (
              <p className="px-5 pt-3 text-[13px] text-text-2">Entre com uma conta para ver seus grupos em outros aparelhos.</p>
            )}
          </>
        )}
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <button
          onClick={() => setComposing(true)}
          className="press pointer-events-auto flex h-13 items-center gap-2 rounded-full bg-ink pr-6 pl-5 text-[17px] font-semibold text-on-ink shadow-[0_10px_30px_rgb(0_0_0/0.22)]"
        >
          <Plus />
          Novo grupo
        </button>
      </div>

      <Sheet
        open={composing}
        onOpenChange={(open) => {
          setComposing(open);
          if (!open) setName("");
        }}
        title="Novo grupo"
        description="Um grupo junta listas de quem usa junto. Quem tem o link vê e edita tudo."
      >
        <form onSubmit={create}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Casa, viagem, trabalho…"
            aria-label="Nome do grupo"
            enterKeyHint="done"
            className={sheetInput}
          />
          <button disabled={creating || !name.trim()} className={sheetPrimary}>
            {creating ? "Criando…" : "Criar"}
          </button>
        </form>
      </Sheet>
    </>
  );
}

function GroupRow({ group }: { group: SavedGroup }) {
  const count = group.list_count === 1 ? "1 lista" : `${group.list_count} listas`;
  return (
    <motion.div whileTap={{ scale: 0.98 }} transition={{ duration: 0.12 }}>
      <Link href={groupUrl(group.token)} className="flex h-14 items-center gap-3 px-4">
        <span
          aria-hidden
          className="grid size-[30px] shrink-0 place-items-center rounded-full bg-bg text-[15px] font-semibold"
        >
          {Array.from(group.name)[0]?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
        <span className="text-[15px] text-text-2 tabular-nums">
          {group.role === "read" ? `Só ver · ${count}` : count}
        </span>
      </Link>
    </motion.div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 pt-16 text-center text-[15px] leading-relaxed text-text-2 text-balance">{children}</p>;
}
