"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { peerColor, peerName, type Peer } from "@/lib/presence";

const MAX_AVATARS = 4;

function Avatar({ peer, className = "" }: { peer: Peer; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: peerColor(peer) }}
      className={`grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] leading-none font-semibold text-white uppercase ${className}`}
    >
      {peerName(peer).charAt(0)}
    </span>
  );
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;

/** Overlapping initials of everyone else on the list. Tapping lists their names. */
export function PresenceStack({ people, self }: { people: Peer[]; self: Peer | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_AVATARS);
  const extra = people.length - shown.length;
  const label = `${joinNames(people.map(peerName))} ${people.length === 1 ? "está" : "estão"} aqui`;

  return (
    <div ref={root} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className="press -my-1 flex items-center rounded-full p-1"
      >
        <AnimatePresence initial={false}>
          {shown.map((p, i) => (
            <motion.span
              key={p.id}
              layout="position"
              initial={{ opacity: 0, transform: "scale(0.6)" }}
              animate={{ opacity: 1, transform: "scale(1)" }}
              exit={{ opacity: 0, transform: "scale(0.6)" }}
              transition={{ type: "spring", duration: 0.35, bounce: 0.2 }}
              className={`rounded-full ring-2 ring-bg ${i > 0 ? "-ml-1" : ""}`}
            >
              <Avatar peer={p} />
            </motion.span>
          ))}
        </AnimatePresence>
        {extra > 0 && (
          <span className="-ml-1 grid h-[22px] min-w-[22px] place-items-center rounded-full bg-surface px-1 text-[11px] font-semibold text-text-2 tabular-nums ring-2 ring-bg">
            +{extra}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, transform: "scale(0.96)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.96)" }}
            transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute top-full right-0 z-30 mt-2 min-w-48 rounded-2xl bg-surface p-1.5 text-[15px] text-text shadow-[0_8px_30px_rgb(0_0_0/0.12),0_0_0_0.5px_var(--sep-strong)]"
          >
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5">
                <Avatar peer={p} />
                <span className="truncate">{peerName(p)}</span>
              </li>
            ))}
            {self?.name && (
              <li className="mt-1 flex items-center gap-2.5 border-t border-sep px-2.5 pt-2.5 pb-1.5">
                <Avatar peer={self} />
                <span className="truncate">
                  Você <span className="text-text-2">· {self.name}</span>
                </span>
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "Ana está digitando…", shown inside the composer bar. */
export function TypingIndicator({ typers }: { typers: Peer[] }) {
  const text =
    typers.length > 2
      ? `${typers.length} pessoas estão digitando…`
      : `${joinNames(typers.map(peerName))} ${typers.length === 1 ? "está" : "estão"} digitando…`;
  return (
    <AnimatePresence initial={false}>
      {typers.length > 0 && (
        <motion.div
          key="typing"
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-1.5 px-4 pb-1.5 text-[13px] text-text-2">
            <span className="flex">
              {typers.slice(0, 3).map((p, i) => (
                <span
                  key={p.id}
                  style={{ backgroundColor: peerColor(p), animationDelay: `${i * 160}ms` }}
                  className={`typing-dot size-1.5 rounded-full ${i > 0 ? "ml-0.5" : ""}`}
                />
              ))}
            </span>
            <span className="truncate">{text}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
