"use client";

import { animate, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { useRef } from "react";
import type { Item } from "@/lib/api";
import { Trash, X } from "./icons";

const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;
const REVEAL = 88;

type Props = { item: Item; onToggle: (item: Item) => void; onDelete: (item: Item) => void };

export function ItemRow({ item, onToggle, onDelete }: Props) {
  const x = useMotionValue(0);
  const row = useRef<HTMLDivElement>(null);
  // Red backdrop and trash come into focus as the row slides away.
  const backdrop = useTransform(x, [-REVEAL, -16], [1, 0]);
  const trashScale = useTransform(x, [-REVEAL, -REVEAL / 2], [1, 0.6]);

  function onDragEnd(_: unknown, info: PanInfo) {
    const flick = info.velocity.x < -500;
    if (info.offset.x < -REVEAL * 0.75 || flick) {
      const width = row.current?.offsetWidth ?? 400;
      animate(x, -width, { duration: 0.18, ease: [0.23, 1, 0.32, 1] }).then(() => onDelete(item));
    } else {
      animate(x, 0, SPRING);
    }
  }

  const byline = item.done ? item.done_by_name && `por ${item.done_by_name}` : item.created_by_name;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, transform: "translateY(6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ layout: SPRING, opacity: { duration: 0.18 }, transform: { duration: 0.2, ease: [0.23, 1, 0.32, 1] }, height: { duration: 0.22 } }}
      className="group relative overflow-hidden border-b border-sep last:border-b-0"
    >
      <motion.div
        aria-hidden
        style={{ opacity: backdrop }}
        className="absolute inset-0 flex items-center justify-end bg-danger pr-7 text-white"
      >
        <motion.span style={{ scale: trashScale }}>
          <Trash />
        </motion.span>
      </motion.div>

      <motion.div
        ref={row}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -REVEAL, right: 0 }}
        dragElastic={{ left: 0.12, right: 0 }}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        style={{ x }}
        className="relative flex items-stretch bg-surface"
      >
        <motion.button
          role="checkbox"
          aria-checked={item.done}
          onTap={() => onToggle(item)}
          whileTap={{ scale: 0.985 }}
          transition={{ duration: 0.12 }}
          className="flex min-h-14 min-w-0 flex-1 items-start gap-3.5 py-3.5 pl-4 pr-3 text-left"
        >
          <span
            data-done={item.done}
            className={`check-box mt-px grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-150 ${
              item.done ? "border-done bg-done" : "border-sep-strong"
            }`}
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="var(--on-ink)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path className="check-path" pathLength={1} d="M5 12.5l4.5 4.5L19 7" stroke="#fff" />
            </svg>
          </span>
          <span className="min-w-0 pt-px">
            <span data-done={item.done} className="strike break-words">
              {item.text}
            </span>
            {byline && <span className="mt-0.5 block text-[13px] text-text-2">{byline}</span>}
          </span>
        </motion.button>
        <button
          onClick={() => onDelete(item)}
          aria-label={`Remover ${item.text}`}
          className="row-delete grid w-11 shrink-0 place-items-center text-text-2 hover:text-danger focus-visible:text-danger"
        >
          <X />
        </button>
      </motion.div>
    </motion.li>
  );
}
