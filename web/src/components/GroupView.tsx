"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  summaryCache,
  uuid,
  type GroupDetail,
  type GroupLinks,
  type ListSummary,
  type RealtimeEvent,
} from "@/lib/api";
import { dropToken, forgetGroup, groupUrl, patchGroup, rememberGroup } from "@/lib/groups";
import { useAuth, useRealtime } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { ChevronLeft, Plus, Share } from "./icons";
import { ProgressRing } from "./ProgressRing";
import { ShareSheet } from "./ShareSheet";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";

const byActivity = (a: ListSummary, b: ListSummary) => b.updated_at.localeCompare(a.updated_at);
const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;

type Detail = GroupDetail | null;
const withLists = (fn: (lists: ListSummary[]) => ListSummary[]) => (d: Detail) => d && { ...d, lists: fn(d.lists) };

export function GroupView() {
  const token = useSearchParams().get("t");
  const router = useRouter();
  const { user } = useAuth();
  const [detail, setDetail] = useState<Detail>(null);
  const [missing, setMissing] = useState(false);
  const [sheet, setSheet] = useState<"new" | "share" | "rotate" | "forget" | null>(null);
  // Our own rotation revokes our socket too; that one isn't a reason to leave.
  const rotating = useRef(false);

  const load = useCallback(() => {
    if (!token) return;
    api<GroupDetail>("/group", { token })
      .then((d) => {
        d.lists.forEach((l) => summaryCache.set(l.id, l));
        setDetail(d);
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
          setMissing(true);
          dropToken(token);
        } else toast("Sem conexão com o servidor. Tentando de novo…");
      });
  }, [token]);
  useEffect(load, [load]);

  useEffect(() => {
    rotating.current = false;
  }, [token]);

  // Save the group on this device (and the account, once auth is ready).
  const group = detail?.group;
  useEffect(() => {
    if (group && token) rememberGroup(group, token);
  }, [group, token, user?.id]);

  const listCount = detail?.lists.length;
  useEffect(() => {
    if (group && listCount !== undefined) patchGroup(group.id, { list_count: listCount });
  }, [group, listCount]);

  const onEvent = useCallback(
    (e: RealtimeEvent) => {
      switch (e.type) {
        case "list_upserted":
          summaryCache.set(e.list.id, e.list);
          return setDetail(withLists((ls) => [e.list, ...ls.filter((l) => l.id !== e.list.id)].sort(byActivity)));
        case "list_deleted":
          return setDetail(withLists((ls) => ls.filter((l) => l.id !== e.id)));
        case "group_renamed":
          return setDetail((d) => d && { ...d, group: { ...d.group, name: e.name } });
        case "revoked":
          if (!rotating.current) load();
      }
    },
    [load],
  );
  // A dead link would otherwise keep retrying the socket forever.
  const connection = useRealtime(missing ? null : token, null, onEvent, load);

  if (missing || !token) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-lg px-6 pt-16 text-center">
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Link inválido</h1>
          <p className="mt-2 text-[15px] text-balance text-text-2">
            Este link não abre nenhum grupo. Ele pode ter sido trocado por um novo. Peça o link atual para quem te convidou.
          </p>
          <Link href="/" className="press mt-6 inline-flex h-11 items-center rounded-full bg-ink px-5 font-semibold text-on-ink">
            Ver meus grupos
          </Link>
        </main>
      </>
    );
  }

  const groupToken = token;
  const canEdit = detail?.group.role === "edit";

  async function rotate() {
    rotating.current = true;
    try {
      const links = await api<GroupLinks>("/group/rotate", { method: "POST", token: groupToken });
      rememberGroup(links.group, links.edit_token);
      setDetail((d) => d && { ...d, group: links.group, read_token: links.read_token });
      setSheet("share");
      router.replace(groupUrl(links.edit_token));
      toast("Link novo criado. O antigo parou de funcionar.");
    } catch {
      rotating.current = false;
      setSheet(null);
      toast("Não deu para gerar um link novo.");
    }
  }

  async function forget() {
    if (!detail) return;
    await forgetGroup(detail.group.id);
    router.replace("/");
  }

  return (
    <>
      <TopBar offline={connection === "offline"} onShare={detail ? () => setSheet("share") : undefined} />

      <main className="mx-auto max-w-lg px-4 pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {detail ? (
          <>
            <GroupTitle key={detail.group.name} token={groupToken} name={detail.group.name} editable={canEdit} />
            <p className="mt-2 flex items-center gap-2 px-1 text-[15px] text-text-2">
              <span className="tabular-nums">
                {detail.lists.length === 1 ? "1 lista" : `${detail.lists.length} listas`}
              </span>
              {!canEdit && (
                <span className="rounded-full bg-surface px-2.5 py-1 text-[13px] font-medium text-text">Só leitura</span>
              )}
            </p>

            {detail.lists.length === 0 ? (
              <p className="px-6 pt-14 text-center text-[15px] leading-relaxed text-balance text-text-2">
                {canEdit
                  ? "Nenhuma lista ainda. Crie a primeira; todo mundo com o link vê na hora."
                  : "Nenhuma lista ainda."}
              </p>
            ) : (
              <motion.ul layout className="mt-5 overflow-hidden rounded-2xl bg-surface">
                <AnimatePresence initial={false}>
                  {detail.lists.map((list) => (
                    <motion.li
                      key={list.id}
                      layout="position"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ layout: SPRING, opacity: { duration: 0.2 }, height: { duration: 0.2 } }}
                      className="overflow-hidden border-b border-sep last:border-b-0"
                    >
                      <ListRow list={list} token={groupToken} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}

            <div className="mt-4 flex flex-col items-start gap-1 px-1">
              <TextButton onClick={() => setSheet("share")}>Compartilhar link</TextButton>
              {canEdit && <TextButton onClick={() => setSheet("rotate")}>Gerar novo link</TextButton>}
              <TextButton onClick={() => setSheet("forget")} danger>
                Remover dos meus grupos
              </TextButton>
            </div>
          </>
        ) : (
          <div aria-hidden>
            <div className="mt-1 h-9 w-2/3 animate-pulse rounded-lg bg-surface" />
            <div className="mt-6 h-40 animate-pulse rounded-2xl bg-surface" />
          </div>
        )}
      </main>

      {canEdit && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <button
            onClick={() => setSheet("new")}
            className="press pointer-events-auto flex h-13 items-center gap-2 rounded-full bg-ink pr-6 pl-5 text-[17px] font-semibold text-on-ink shadow-[0_10px_30px_rgb(0_0_0/0.22)]"
          >
            <Plus />
            Nova lista
          </button>
        </div>
      )}

      <NewListSheet open={sheet === "new"} onOpenChange={(o) => setSheet(o ? "new" : null)} token={groupToken} />

      {detail && (
        <>
          <ShareSheet
            open={sheet === "share"}
            onOpenChange={(o) => setSheet(o ? "share" : null)}
            name={detail.group.name}
            editToken={canEdit ? groupToken : null}
            readToken={canEdit ? detail.read_token : groupToken}
          />
          <Confirm
            open={sheet === "rotate"}
            onOpenChange={(o) => setSheet(o ? "rotate" : null)}
            title="Gerar novo link?"
            description="Os links atuais, de edição e de leitura, param de funcionar para todo mundo. Quem ainda for usar o grupo vai precisar do link novo."
            action="Gerar novo link"
            onConfirm={rotate}
          />
          <Confirm
            open={sheet === "forget"}
            onOpenChange={(o) => setSheet(o ? "forget" : null)}
            title={`Remover "${detail.group.name}"?`}
            description="O grupo some daqui e dos seus outros aparelhos, mas continua existindo. Para voltar, você vai precisar do link."
            action="Remover"
            danger
            onConfirm={forget}
          />
        </>
      )}
    </>
  );
}

function TopBar({ offline, onShare }: { offline?: boolean; onShare?: () => void }) {
  return (
    <header className="sticky top-0 z-20 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-lg items-center px-2">
        <Link href="/" className="press -ml-1 flex h-10 items-center pr-3 pl-1 font-medium">
          <ChevronLeft />
          Grupos
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
        {onShare && (
          <button onClick={onShare} aria-label="Compartilhar grupo" className="press ml-auto grid size-10 place-items-center">
            <Share />
          </button>
        )}
      </div>
    </header>
  );
}

function GroupTitle({ token, name, editable }: { token: string; name: string; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const cls = "text-[2.125rem] leading-[1.1] font-bold tracking-[-0.02em]";

  async function save() {
    setEditing(false);
    const clean = value.trim();
    if (!clean || clean === name) return setValue(name);
    try {
      await api("/group", { method: "PATCH", body: { name: clean }, token });
    } catch {
      setValue(name);
      toast("Não deu para renomear o grupo.");
    }
  }

  if (!editable) return <h1 className={`${cls} mt-1 px-1 text-balance`}>{name}</h1>;
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={60}
        aria-label="Nome do grupo"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setValue(name);
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

function NewListSheet({ open, onOpenChange, token }: { open: boolean; onOpenChange: (o: boolean) => void; token: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean || creating) return;
    setCreating(true);
    const id = uuid();
    try {
      const list = await api<ListSummary>("/lists", { method: "POST", body: { id, title: clean }, token });
      summaryCache.set(id, list);
      router.push(`/list/?id=${id}&t=${encodeURIComponent(token)}`);
    } catch {
      toast("Não deu para criar a lista. Confira sua conexão.");
      setCreating(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTitle("");
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
  );
}

function Confirm({
  open,
  onOpenChange,
  title,
  description,
  action,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  action: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <button
        onClick={async () => {
          setBusy(true);
          await onConfirm();
          setBusy(false);
        }}
        disabled={busy}
        className={`press flex h-13 w-full items-center justify-center rounded-2xl text-[17px] font-semibold disabled:opacity-60 ${
          danger ? "bg-danger text-white" : "bg-ink text-on-ink"
        }`}
      >
        {action}
      </button>
      <button
        onClick={() => onOpenChange(false)}
        className="press mt-2 flex h-13 w-full items-center justify-center rounded-2xl bg-bg text-[17px] font-semibold"
      >
        Cancelar
      </button>
    </Sheet>
  );
}

function ListRow({ list, token }: { list: ListSummary; token: string }) {
  const { item_count: total, done_count: done } = list;
  return (
    <motion.div whileTap={{ scale: 0.98 }} transition={{ duration: 0.12 }}>
      <Link href={`/list/?id=${list.id}&t=${encodeURIComponent(token)}`} className="flex h-14 items-center gap-3 px-4">
        <ProgressRing done={done} total={total} size={22} stroke={2.25} />
        <span className="min-w-0 flex-1 truncate font-medium">{list.title}</span>
        <span className="text-[15px] text-text-2 tabular-nums">{total === 0 ? "" : `${done}/${total}`}</span>
      </Link>
    </motion.div>
  );
}

function TextButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`press h-10 rounded-full px-3 text-[15px] font-medium ${danger ? "text-danger" : "text-text-2"}`}
    >
      {children}
    </button>
  );
}
