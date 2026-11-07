"use client";

import { animate, AnimatePresence, LayoutGroup, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError, type LinkedList, type SearchHit } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import { searchOffline } from "@/lib/offline";
import { keepPins, setPinned, usePinned } from "@/lib/pins";
import { listUrl, rememberList, savedStore, syncLists, type SavedList } from "@/lib/saved";
import { toast } from "@/lib/toast";
import { AccountButton } from "./AccountButton";
import { Pin, Plus, Search, X } from "./icons";
import { ProgressRing } from "./ProgressRing";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";
import { SyncStatus } from "./SyncStatus";

const byActivity = (a: SavedList, b: SavedList) => b.updated_at.localeCompare(a.updated_at);
const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;
const noop = () => () => {};
const REVEAL = 88;

/** Case- and accent-insensitive, so "feijao" finds "Feijão". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function HomeView() {
  const router = useRouter();
  const { status, user } = useAuth();
  const saved = useSyncExternalStore(savedStore.subscribe, savedStore.get, () => savedStore.serverSnapshot);
  // localStorage is unknown during the static render; don't flash the empty state.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const pinned = usePinned();

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
  const hits = useItemSearch(query, saved);

  // The "Nova lista" app shortcut (manifest.ts) opens /?nova. Opening a frame later lets the
  // sheet slide in over the painted screen.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("nova")) return;
    const frame = requestAnimationFrame(() => {
      history.replaceState(null, "", "/");
      setComposing(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Pins of lists this device no longer has (deleted, forgotten) go with them.
  useEffect(() => {
    if (hydrated) keepPins(new Set(saved.map((l) => l.id)));
  }, [hydrated, saved]);

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
        <div className="flex items-center gap-2">
          <SyncStatus />
          <AccountButton />
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {!hydrated ? null : lists.length === 0 ? (
          <Empty>
            Nenhuma lista neste aparelho. Crie uma e mande o link para quem vai usar junto. Quem tem o link entra sem
            cadastro.
          </Empty>
        ) : (
          <>
            <SearchField value={query} onChange={setQuery} />
            <Lists lists={lists} pinned={pinned} query={query} hits={hits} />
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

/**
 * Item matches from the API, debounced. Only the lists saved on this device are searched: the
 * request carries their link tokens. Titles are matched locally since the home already has them.
 * Without a connection, the copies of opened lists kept on the device are searched instead.
 */
function useItemSearch(query: string, saved: SavedList[]): ReadonlyMap<string, SearchHit> {
  const [hits, setHits] = useState<{ q: string; map: ReadonlyMap<string, SearchHit> }>({ q: "", map: new Map() });
  const q = query.trim();
  const tokens = saved.map((l) => l.token).join(" ");
  useEffect(() => {
    if (q.length < 2 || !tokens) return;
    let stale = false;
    const timer = setTimeout(() => {
      const asked = tokens.split(" ");
      api<SearchHit[]>("/lists/search", { method: "POST", body: { q, tokens: asked } })
        .catch((e) => {
          if (e instanceof ApiError) throw e;
          const lists = savedStore.get().filter((l) => asked.includes(l.token));
          return searchOffline(q, lists);
        })
        .then((list) => !stale && setHits({ q, map: new Map(list.map((h) => [h.list_id, h])) }))
        .catch(() => {});
    }, 220);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, tokens]);
  // Results for an older query would flash the wrong lists while the new request is in flight.
  return hits.q === q ? hits.map : EMPTY_HITS;
}
const EMPTY_HITS: ReadonlyMap<string, SearchHit> = new Map();

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative mb-4">
      <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-text-2">
        <Search />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder="Buscar listas e itens"
        aria-label="Buscar listas e itens"
        enterKeyHint="search"
        autoComplete="off"
        className="h-10 w-full appearance-none rounded-xl border border-transparent bg-surface pr-10 pl-9 text-[17px] outline-none transition-[border-color,box-shadow] duration-200 ease-out placeholder:text-text-2 focus:border-text/25 focus:ring-4 focus:ring-halo [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label="Limpar busca"
          className="absolute inset-y-0 right-1 grid w-9 place-items-center text-text-2"
        >
          <span className="grid size-[18px] place-items-center rounded-full bg-text-2/40 text-surface">
            <X className="size-3" />
          </span>
        </button>
      )}
    </div>
  );
}

type ListsProps = {
  lists: SavedList[];
  pinned: readonly string[];
  query: string;
  hits: ReadonlyMap<string, SearchHit>;
};

function Lists({ lists, pinned, query, hits }: ListsProps) {
  const pinnedSet = new Set(pinned);
  const q = fold(query.trim());

  if (q) {
    const results = lists
      .filter((l) => fold(l.title).includes(q) || hits.has(l.id))
      .sort((a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)));
    if (results.length === 0) {
      return <Empty>Nada encontrado para “{query.trim()}”.</Empty>;
    }
    return (
      <Section>
        {results.map((list) => (
          <ListRow key={list.id} list={list} pinned={pinnedSet.has(list.id)} hit={hits.get(list.id)} showPin />
        ))}
      </Section>
    );
  }

  const top = lists.filter((l) => pinnedSet.has(l.id));
  const rest = lists.filter((l) => !pinnedSet.has(l.id));
  return (
    <LayoutGroup>
      {top.length > 0 && (
        <Section title="Fixadas">
          {top.map((list) => (
            <ListRow key={list.id} list={list} pinned />
          ))}
        </Section>
      )}
      {rest.length > 0 && (
        <Section title={top.length > 0 ? "Recentes" : undefined}>
          {rest.map((list) => (
            <ListRow key={list.id} list={list} pinned={false} />
          ))}
        </Section>
      )}
    </LayoutGroup>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <motion.section layout="position" transition={{ layout: SPRING }} className="mb-6 last:mb-0">
      {title && <h2 className="mb-1.5 px-4 text-[13px] font-semibold text-text-2">{title}</h2>}
      <ul className="overflow-hidden rounded-2xl bg-surface">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ul>
    </motion.section>
  );
}

type RowProps = { list: SavedList; pinned: boolean; hit?: SearchHit; showPin?: boolean };

function ListRow({ list, pinned, hit, showPin }: RowProps) {
  const { item_count: total, done_count: done } = list;
  const x = useMotionValue(0);
  const dragged = useRef(false);
  // Swipe right to pin, mirroring swipe left to delete on items.
  const backdrop = useTransform(x, [16, REVEAL], [0, 1]);
  const iconScale = useTransform(x, [REVEAL / 2, REVEAL], [0.6, 1]);
  const toggle = () => setPinned(list.id, !pinned);

  function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x > REVEAL * 0.75 || info.velocity.x > 500) {
      navigator.vibrate?.(8);
      toggle();
    }
    animate(x, 0, SPRING);
    // The click that ends a drag must not open the list.
    setTimeout(() => (dragged.current = false));
  }

  const more = hit && hit.matches > 1 ? ` e mais ${hit.matches - 1}` : "";

  return (
    <motion.li
      layout="position"
      layoutId={list.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ layout: SPRING, opacity: { duration: 0.2 }, height: { duration: 0.2 } }}
      className="group relative overflow-hidden border-b border-sep last:border-b-0"
    >
      <motion.div
        aria-hidden
        style={{ opacity: backdrop }}
        className="absolute inset-0 flex items-center bg-ink pl-7 text-on-ink"
      >
        <motion.span style={{ scale: iconScale }}>
          <Pin className="size-5" filled={!pinned} />
        </motion.span>
      </motion.div>

      <motion.div
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: REVEAL }}
        dragElastic={{ left: 0, right: 0.12 }}
        dragMomentum={false}
        onDragStart={() => (dragged.current = true)}
        onDragEnd={onDragEnd}
        style={{ x }}
        className="relative flex items-stretch bg-surface"
      >
        <motion.div whileTap={{ scale: 0.98 }} transition={{ duration: 0.12 }} className="min-w-0 flex-1">
          <Link
            href={listUrl(list.token)}
            draggable={false}
            onClickCapture={(e) => dragged.current && e.preventDefault()}
            className="flex min-h-14 items-center gap-3 py-2 pr-1 pl-4 [@media(hover:none)]:pr-4"
          >
            <ProgressRing done={done} total={total} size={22} stroke={2.25} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{list.title}</span>
              {hit && (
                <span className="block truncate text-[13px] text-text-2">
                  {hit.text}
                  {more}
                </span>
              )}
            </span>
            {/* Desktop hover shows the pin button instead; one pin per row. */}
            {showPin && pinned && <Pin className="size-3.5 text-text-2 pointer-fine:group-hover:hidden" filled />}
            <span className="text-[15px] text-text-2 tabular-nums">{total === 0 ? "" : `${done}/${total}`}</span>
          </Link>
        </motion.div>
        <button
          onClick={toggle}
          aria-label={pinned ? `Desafixar ${list.title}` : `Fixar ${list.title}`}
          title={pinned ? "Desafixar" : "Fixar no topo"}
          className="row-action grid w-11 shrink-0 place-items-center text-text-2 hover:text-text focus-visible:text-text"
        >
          <Pin className="size-[18px]" filled={pinned} />
        </button>
      </motion.div>
    </motion.li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 pt-16 text-center text-[15px] leading-relaxed text-text-2 text-balance">{children}</p>;
}
