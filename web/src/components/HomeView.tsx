"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type LinkedList } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import { listUrl, rememberList, savedStore, syncLists, type SavedList } from "@/lib/saved";
import { toast } from "@/lib/toast";
import { AccountButton } from "./AccountButton";
import { Plus } from "./icons";
import { ProgressRing } from "./ProgressRing";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";

const byActivity = (a: SavedList, b: SavedList) => b.updated_at.localeCompare(a.updated_at);
const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;
const noop = () => () => {};

export function HomeView() {
  const router = useRouter();
  const { status, user } = useAuth();
  const saved = useSyncExternalStore(savedStore.subscribe, savedStore.get, () => savedStore.serverSnapshot);
  // localStorage is unknown during the static render; don't flash the empty state.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // The home screen has no socket: it refreshes titles and counts on open and when the app returns.
  const userId = user?.id;
  useEffect(() => {
    if (status !== "ready") return;
    const sync = () => document.visibilityState === "visible" && syncLists().catch(() => {});
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [status, userId]);

  const lists = [...saved].sort(byActivity);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean || creating) return;
    setCreating(true);
    try {
      const linked = await api<LinkedList>("/lists", { method: "POST", body: { title: clean } });
      rememberList(linked);
      router.push(listUrl(linked.token));
    } catch {
      toast("Não deu para criar a lista. Confira sua conexão.");
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
        {!hydrated ? null : lists.length === 0 ? (
          <Empty>
            Nenhuma lista neste aparelho. Crie uma e mande o link para quem vai usar junto. Quem tem o link entra sem
            cadastro.
          </Empty>
        ) : (
          <>
            <motion.ul layout className="overflow-hidden rounded-2xl bg-surface">
              <AnimatePresence initial={false}>
                {lists.map((list) => (
                  <motion.li
                    key={list.id}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ layout: SPRING, opacity: { duration: 0.2 }, height: { duration: 0.2 } }}
                    className="overflow-hidden border-b border-sep last:border-b-0"
                  >
                    <ListRow list={list} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
            {status === "ready" && !user && (
              <p className="px-5 pt-3 text-[13px] text-text-2">Entre com uma conta para ver suas listas em outros aparelhos.</p>
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
          Nova lista
        </button>
      </div>

      <Sheet
        open={composing}
        onOpenChange={(open) => {
          setComposing(open);
          if (!open) setTitle("");
        }}
        title="Nova lista"
      >
        <form onSubmit={create}>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            placeholder="Mercado, viagem, churrasco…"
            aria-label="Nome da lista"
            enterKeyHint="done"
            className={sheetInput}
          />
          <button disabled={creating || !title.trim()} className={sheetPrimary}>
            {creating ? "Criando…" : "Criar"}
          </button>
        </form>
      </Sheet>
    </>
  );
}

function ListRow({ list }: { list: SavedList }) {
  const { item_count: total, done_count: done } = list;
  return (
    <motion.div whileTap={{ scale: 0.98 }} transition={{ duration: 0.12 }}>
      <Link href={listUrl(list.token)} className="flex h-14 items-center gap-3 px-4">
        <ProgressRing done={done} total={total} size={22} stroke={2.25} />
        <span className="min-w-0 flex-1 truncate font-medium">{list.title}</span>
        <span className="text-[15px] text-text-2 tabular-nums">{total === 0 ? "" : `${done}/${total}`}</span>
      </Link>
    </motion.div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 pt-16 text-center text-[15px] leading-relaxed text-text-2 text-balance">{children}</p>;
}
