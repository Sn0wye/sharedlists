"use client";

import { AnimatePresence, animate, motion, Reorder, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { useEffect, useRef } from "react";
import type { Item } from "@/lib/api";
import { peerColor, peerName, type Peer } from "@/lib/presence";
import { Grip, Minus, Plus, Trash, X } from "./icons";

const SPRING = { type: "spring", duration: 0.45, bounce: 0 } as const;
const REVEAL = 88;
const MAX_QUANTITY = 999;

type Props = {
  item: Item;
  /** Open items can be dragged by their grip; done ones keep completion order. */
  reorderable: boolean;
  onToggle: (item: Item) => void;
  onDelete: (item: Item) => void;
  onQuantity: (item: Item, quantity: number) => void;
  onDrop: (item: Item) => void;
  /** Keyboard reorder from the grip: -1 is up, 1 is down. */
  onStep: (item: Item, step: -1 | 1) => void;
  /** Other people on this item right now; the first one's colour marks the row. */
  here?: Peer[];
  /** The user touched or focused this row. */
  onActive?: () => void;
};

export function ItemRow({ item, reorderable, onToggle, onDelete, onQuantity, onDrop, onStep, here = [], onActive }: Props) {
  const x = useMotionValue(0);
  const row = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLButtonElement>(null);
  const controls = useDragControls();
  // Red backdrop and trash come into focus as the row slides away.
  const backdrop = useTransform(x, [-REVEAL, -16], [1, 0]);
  const trashScale = useTransform(x, [-REVEAL, -REVEAL / 2], [1, 0.6]);

  // Native listener so the press never reaches the row's own swipe gesture, which listens
  // natively too (a React handler would run after it).
  useEffect(() => {
    const el = grip.current;
    if (!el) return;
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      navigator.vibrate?.(8);
      controls.start(e);
    };
    el.addEventListener("pointerdown", down);
    return () => el.removeEventListener("pointerdown", down);
  }, [controls, reorderable]);

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
  const lead = here[0];
  const hereLabel = here.length > 0 ? `${here.map(peerName).join(", ")} ${here.length === 1 ? "está" : "estão"} aqui` : undefined;

  return (
    <Reorder.Item
      value={item.id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={() => onDrop(item)}
      tabIndex={-1}
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      whileDrag={{ boxShadow: "0 10px 30px rgb(0 0 0 / 0.16)" }}
      transition={{ layout: SPRING, opacity: { duration: 0.18 }, y: { duration: 0.2, ease: [0.23, 1, 0.32, 1] }, height: { duration: 0.22 } }}
      style={{ boxShadow: "0 0 0 rgb(0 0 0 / 0)" }}
      onPointerDownCapture={onActive}
      onFocus={onActive}
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
        title={hereLabel}
        className="relative flex items-stretch bg-surface"
      >
        <AnimatePresence>
          {lead && (
            <motion.span
              key="here"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ "--peer": peerColor(lead) } as React.CSSProperties}
              className="pointer-events-none absolute inset-0 bg-[color-mix(in_srgb,var(--peer)_7%,transparent)]"
            >
              <span className="absolute inset-y-2.5 left-0 w-[3px] rounded-r-full bg-(--peer)" />
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button
          role="checkbox"
          aria-checked={item.done}
          onTap={() => onToggle(item)}
          whileTap={{ scale: 0.985 }}
          transition={{ duration: 0.12 }}
          className="relative flex min-h-14 min-w-0 flex-1 items-start gap-3.5 py-3.5 pl-4 pr-2 text-left"
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

        <Quantity item={item} onChange={(q) => onQuantity(item, q)} />

        {reorderable ? (
          <button
            ref={grip}
            type="button"
            aria-label={`Mover ${item.text}`}
            title="Arraste para mover"
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                onStep(item, e.key === "ArrowUp" ? -1 : 1);
              }
            }}
            className="relative grid w-9 shrink-0 cursor-grab touch-none place-items-center text-text-2/70 active:cursor-grabbing"
          >
            <Grip />
          </button>
        ) : (
          <span className="w-9 shrink-0" aria-hidden />
        )}
        <button
          onClick={() => onDelete(item)}
          aria-label={`Remover ${item.text}`}
          className="row-delete relative grid w-11 shrink-0 place-items-center text-text-2 hover:text-danger focus-visible:text-danger"
        >
          <X />
        </button>
      </motion.div>
      {/* Outside the checkbox so its accessible name stays the item text. */}
      {hereLabel && <span className="sr-only">{hereLabel}</span>}
    </Reorder.Item>
  );
}

/** "− 2 +" at the end of the row. At 1 it shrinks to a faint "+", so plain lists stay plain. */
function Quantity({ item, onChange }: { item: Item; onChange: (quantity: number) => void }) {
  const { quantity, done } = item;
  if (done) {
    return quantity > 1 ? (
      <span className="flex shrink-0 items-center px-2 text-[15px] text-text-2 tabular-nums" aria-label={`Quantidade ${quantity}`}>
        ×{quantity}
      </span>
    ) : null;
  }
  const step = "press grid h-8 w-7 place-items-center rounded-full text-text-2 hover:text-text disabled:opacity-40";
  return (
    <div className="relative flex shrink-0 items-center">
      {quantity > 1 ? (
        <div role="group" aria-label="Quantidade" className="flex h-8 items-center rounded-full bg-bg">
          <button type="button" aria-label="Diminuir" onClick={() => onChange(quantity - 1)} className={step}>
            <Minus className="size-3.5" />
          </button>
          <span className="relative min-w-5 overflow-hidden text-center text-[15px] font-semibold tabular-nums">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={quantity}
                className="block"
                initial={{ opacity: 0, transform: "translateY(-6px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={{ opacity: 0, transform: "translateY(6px)" }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
              >
                {quantity}
              </motion.span>
            </AnimatePresence>
          </span>
          <button
            type="button"
            aria-label="Aumentar"
            disabled={quantity >= MAX_QUANTITY}
            onClick={() => onChange(quantity + 1)}
            className={step}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Aumentar quantidade de ${item.text}`}
          onClick={() => onChange(2)}
          className="qty-add press grid size-8 place-items-center rounded-full text-text-2 hover:bg-bg hover:text-text"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );
}
