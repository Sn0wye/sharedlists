"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, summaryCache, uuid, type ListSummary, type RealtimeEvent } from "@/lib/api";
import { useRealtime } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { AccountButton } from "./AccountButton";
import { Plus } from "./icons";
import { ProgressRing } from "./ProgressRing";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";

const byActivity = (a: ListSummary, b: ListSummary) => b.updated_at.localeCompare(a.updated_at);
const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;

export function HomeView() {
  const router = useRouter();
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<ListSummary[]>("/lists")
      .then((l) => {
        l.forEach((s) => summaryCache.set(s.id, s));
        setLists(l);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const onEvent = useCallback((e: RealtimeEvent) => {
    if (e.type === "list_upserted") {
      summaryCache.set(e.list.id, e.list);
      setLists((prev) => prev && [e.list, ...prev.filter((l) => l.id !== e.list.id)].sort(byActivity));
    } else if (e.type === "list_deleted") {
      setLists((prev) => prev && prev.filter((l) => l.id !== e.id));
    }
  }, []);
  useRealtime(null, onEvent, load);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean || creating) return;
    setCreating(true);
    const id = uuid();
    try {
      const list = await api<ListSummary>("/lists", { method: "POST", body: { id, title: clean } });
      summaryCache.set(id, list);
      router.push(`/list/?id=${id}`);
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
        {failed && !lists ? (
          <Empty>
            Não foi possível carregar as listas.{" "}
            <button onClick={load} className="font-semibold text-text underline underline-offset-4">
              Tentar de novo
            </button>
          </Empty>
        ) : !lists ? (
          <div aria-hidden className="overflow-hidden rounded-2xl bg-surface">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse border-b border-sep last:border-b-0" />
            ))}
          </div>
        ) : lists.length === 0 ? (
          <Empty>Nenhuma lista ainda. Crie a primeira e mande o link para quem vai usar junto.</Empty>
        ) : (
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

function ListRow({ list }: { list: ListSummary }) {
  const { item_count: total, done_count: done } = list;
  return (
    <motion.div whileTap={{ scale: 0.98 }} transition={{ duration: 0.12 }}>
      <Link href={`/list/?id=${list.id}`} className="flex h-14 items-center gap-3 px-4">
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
