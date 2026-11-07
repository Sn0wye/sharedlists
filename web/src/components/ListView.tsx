"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { api, uuid, type Item, type ListDetail, type RealtimeEvent } from "@/lib/api";
import { useAuth, useRealtime } from "@/lib/hooks";
import { usePresence } from "@/lib/presence";
import { dropToken, findByToken, forgetList, isGone, patchList, rememberList } from "@/lib/saved";
import { toast } from "@/lib/toast";
import { Composer } from "./Composer";
import { ChevronLeft, Share } from "./icons";
import { ItemRow } from "./ItemRow";
import { PresenceStack, TypingIndicator } from "./Presence";
import { ProgressRing } from "./ProgressRing";

/** A toggled item holds its place this long so the check and strike land before it moves. */
const SETTLE_MS = 650;

type Detail = ListDetail | null;
const withItems = (fn: (items: Item[]) => Item[]) => (d: Detail) => d && { ...d, items: fn(d.items) };
const upserting = (item: Item) => withItems((items) => [...items.filter((i) => i.id !== item.id), item]);
const removing = (id: string) => withItems((items) => items.filter((i) => i.id !== id));

const haptic = () => navigator.vibrate?.(8);

export function ListView() {
  const token = useSearchParams().get("t");
  const router = useRouter();
  const { user } = useAuth();
  // A list opened before paints its title from the home screen's copy while the items load.
  const [detail, setDetail] = useState<Detail>(() => {
    const saved = token && findByToken(token);
    return saved ? { list: saved, items: [] } : null;
  });
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const presence = usePresence();
  const { receive } = presence;

  const load = useCallback(() => {
    if (!token) return;
    api<ListDetail>("/list", { token })
      .then((d) => {
        setDetail(d);
        setLoaded(true);
        rememberList({ token, list: d.list });
      })
      .catch((e) => {
        if (!isGone(e)) return toast("Sem conexão com o servidor. Tentando de novo…");
        setMissing(true);
        dropToken(token);
      });
  }, [token]);
  useEffect(load, [load]);

  const patchItems = (fn: (items: Item[]) => Item[]) => setDetail(withItems(fn));
  const upsert = (item: Item) => setDetail(upserting(item));
  const remove = (itemId: string) => setDetail(removing(itemId));

  const onEvent = useCallback(
    (e: RealtimeEvent) => {
      switch (e.type) {
        case "item_upserted":
          return setDetail(upserting(e.item));
        case "item_deleted":
          return setDetail(removing(e.id));
        case "list_upserted":
          patchList(e.list);
          return setDetail((d) => d && { ...d, list: e.list });
        case "presence":
        case "presence_self":
          return receive(e);
        case "list_deleted":
          if (token) dropToken(token);
          toast("Essa lista foi apagada.");
          return router.replace("/");
      }
    },
    [router, token, receive],
  );
  // A dead link would otherwise keep retrying the socket forever.
  const connection = useRealtime(missing ? null : token, onEvent, load, presence.link);

  function settle(itemId: string) {
    setSettling((s) => new Set(s).add(itemId));
    setTimeout(
      () =>
        setSettling((s) => {
          const next = new Set(s);
          next.delete(itemId);
          return next;
        }),
      SETTLE_MS,
    );
  }

  // Open items first (oldest on top), done items below by completion time.
  const sunk = (i: Item) => i.done && !settling.has(i.id);
  const sortKey = (i: Item) => (sunk(i) ? (i.done_at ?? "") : i.created_at);
  const items = [...(detail?.items ?? [])].sort(
    (a, b) => Number(sunk(a)) - Number(sunk(b)) || sortKey(a).localeCompare(sortKey(b)),
  );

  if (missing || !token) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-lg px-6 pt-16 text-center">
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Lista não encontrada</h1>
          <p className="mt-2 text-[15px] text-text-2">O link pode estar errado ou a lista foi apagada.</p>
          <Link href="/" className="press mt-6 inline-flex h-11 items-center rounded-full bg-ink px-5 font-semibold text-on-ink">
            Ver minhas listas
          </Link>
        </main>
      </>
    );
  }

  // Narrowed copy for the closures below; `token` itself is string | null.
  const key = token;

  async function add(text: string) {
    const item: Item = {
      id: uuid(),
      list_id: detail?.list.id ?? "",
      text,
      done: false,
      created_by_name: user?.username ?? null,
      done_by_name: null,
      created_at: new Date().toISOString(),
      done_at: null,
    };
    upsert(item);
    try {
      await api("/list/items", { method: "POST", body: { id: item.id, text }, token: key });
    } catch {
      remove(item.id);
      toast("Não deu para adicionar o item.");
    }
  }

  async function toggle(item: Item) {
    const done = !item.done;
    if (done) haptic();
    upsert({ ...item, done, done_at: done ? new Date().toISOString() : null, done_by_name: done ? (user?.username ?? null) : null });
    settle(item.id);
    try {
      await api(`/items/${item.id}`, { method: "PATCH", body: { done }, token: key });
    } catch {
      upsert(item);
      toast("Não deu para salvar. Confira sua conexão.");
    }
  }

  async function del(item: Item) {
    remove(item.id);
    try {
      await api(`/items/${item.id}`, { method: "DELETE", token: key });
      toast({ message: "Item removido", action: { label: "Desfazer", onClick: () => restore(item) } });
    } catch {
      upsert(item);
      toast("Não deu para remover o item.");
    }
  }

  async function restore(item: Item) {
    upsert(item);
    try {
      await api("/list/items", { method: "POST", body: { id: item.id, text: item.text }, token: key });
      if (item.done) await api(`/items/${item.id}`, { method: "PATCH", body: { done: true }, token: key });
    } catch {
      remove(item.id);
      toast("Não deu para restaurar o item.");
    }
  }

  async function clearDone() {
    const before = detail?.items ?? [];
    patchItems((all) => all.filter((i) => !i.done));
    try {
      await api("/list/clear-done", { method: "POST", token: key });
    } catch {
      patchItems(() => before);
      toast("Não deu para limpar os concluídos.");
    }
  }

  const doneCount = detail?.items.filter((i) => i.done).length ?? 0;
  const total = detail?.items.length ?? 0;

  return (
    <>
      <TopBar offline={connection === "offline"} title={detail?.list.title} />

      <main className="mx-auto max-w-lg px-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))]">
        {detail ? (
          <>
            <Title key={detail.list.title} token={key} title={detail.list.title} />
            <div className="mt-2 flex items-center gap-2.5 text-[15px] text-text-2">
              <ProgressRing done={doneCount} total={total} size={20} stroke={2.25} />
              <span className="tabular-nums">
                {!loaded ? "Carregando…" : total === 0 ? "Sem itens" : `${doneCount} de ${total}`}
              </span>
              <PresenceStack people={presence.people} self={presence.self} />
            </div>

            {loaded && items.length === 0 ? (
              <p className="pt-16 text-center text-[15px] text-text-2">Adicione o primeiro item aqui embaixo.</p>
            ) : (
              <motion.ul layout className="mt-5 overflow-hidden rounded-2xl bg-surface">
                <AnimatePresence initial={false}>
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onToggle={toggle}
                      onDelete={del}
                      here={presence.at(item.id)}
                      onActive={() => presence.touch(item.id)}
                    />
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}

            <div className="mt-4 flex flex-col items-start gap-1 px-1">
              <AnimatePresence>
                {doneCount > 0 && (
                  <motion.button
                    key="clear"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    onClick={clearDone}
                    className="press h-10 rounded-full px-3 text-[15px] font-medium text-text-2"
                  >
                    Limpar concluídos
                  </motion.button>
                )}
              </AnimatePresence>
              <button
                onClick={() => {
                  void forgetList(detail.list.id);
                  router.replace("/");
                }}
                className="press h-10 rounded-full px-3 text-[15px] font-medium text-text-2"
              >
                Tirar da tela inicial
              </button>
              <DeleteListButton token={key} title={detail.list.title} />
            </div>
          </>
        ) : (
          <div aria-hidden>
            <div className="mt-1 h-9 w-2/3 animate-pulse rounded-lg bg-surface" />
            <div className="mt-6 h-40 animate-pulse rounded-2xl bg-surface" />
          </div>
        )}
      </main>

      {detail && (
        <Composer onAdd={add} onTyping={presence.setTyping} status={<TypingIndicator typers={presence.typers} />} />
      )}
    </>
  );
}

function TopBar({ offline, title }: { offline?: boolean; title?: string }) {
  async function share() {
    const url = location.href;
    if (navigator.share) {
      await navigator.share({ title, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url);
      toast("Link copiado");
    }
  }
  return (
    <header className="sticky top-0 z-20 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-lg items-center px-2">
        <Link href="/" className="press -ml-1 flex h-10 items-center pr-3 pl-1 font-medium">
          <ChevronLeft />
          Listas
        </Link>
        <AnimatePresence>
          {offline && (
            <motion.span
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="rounded-full bg-surface px-2.5 py-1 text-[13px] font-medium text-text-2"
            >
              Reconectando…
            </motion.span>
          )}
        </AnimatePresence>
        {title && (
          <button onClick={share} aria-label="Compartilhar lista" className="press ml-auto grid size-10 place-items-center">
            <Share />
          </button>
        )}
      </div>
    </header>
  );
}

function Title({ token, title }: { token: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const cls = "text-[2.125rem] leading-[1.1] font-bold tracking-[-0.02em]";

  async function save() {
    setEditing(false);
    const clean = value.trim();
    if (!clean || clean === title) return setValue(title);
    try {
      await api("/list", { method: "PATCH", body: { title: clean }, token });
    } catch {
      setValue(title);
      toast("Não deu para renomear a lista.");
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={100}
        aria-label="Nome da lista"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        className={`${cls} mt-1 w-full bg-transparent px-1 outline-none`}
      />
    );
  }
  return (
    <h1 className={`${cls} mt-1`}>
      <button onClick={() => setEditing(true)} className="px-1 text-left text-balance" title="Renomear">
        {value}
      </button>
    </h1>
  );
}

function DeleteListButton({ token, title }: { token: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function del() {
    setDeleting(true);
    try {
      await api("/list", { method: "DELETE", token });
      dropToken(token);
      router.replace("/");
    } catch {
      setDeleting(false);
      setOpen(false);
      toast("Não deu para apagar a lista.");
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="press h-10 rounded-full px-3 text-[15px] font-medium text-danger">
        Apagar lista
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={`Apagar "${title}"?`}
        description="Some para todo mundo que tem o link. Não dá para desfazer."
      >
        <button
          onClick={del}
          disabled={deleting}
          className="press flex h-13 w-full items-center justify-center rounded-2xl bg-danger text-[17px] font-semibold text-white disabled:opacity-60"
        >
          {deleting ? "Apagando…" : "Apagar lista"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="press mt-2 flex h-13 w-full items-center justify-center rounded-2xl bg-bg text-[17px] font-semibold"
        >
          Cancelar
        </button>
      </Sheet>
    </>
  );
}
