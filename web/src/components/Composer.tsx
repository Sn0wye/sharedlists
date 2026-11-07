"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { ArrowUp } from "./icons";

const MAX_LINES = 200;

/** One pasted line as an item: list markers ("- ", "• ", "1. ", "[ ] ") dropped, too-long lines cut. */
const pastedLine = (line: string) =>
  line
    .replace(/^\s*(?:[-*+•·–—]|\[[ xX]?\]|\d{1,3}[.)])\s+/, "")
    .trim()
    .slice(0, 500);

type Props = {
  /** One text per item; pasting several lines adds them all at once. */
  onAdd: (texts: string[]) => void;
  /** Called on every change with whether the field holds text, and with `false` on send or blur. */
  onTyping?: (active: boolean) => void;
  /** A line shown above the field, inside the bar (who else is typing). */
  status?: ReactNode;
};

/**
 * Fixed bottom bar for adding items. Keeps the keyboard open so several items can be typed in a row.
 * Pasting several lines adds one item per line.
 */
export function Composer({ onAdd, onTyping, status }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ready = text.trim().length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    onAdd([text.trim()]);
    setText("");
    onTyping?.(false);
    input.current?.focus();
  }

  // A text input would flatten the lines into one, so take over only when there are several.
  function paste(e: React.ClipboardEvent<HTMLInputElement>) {
    const lines = e.clipboardData.getData("text").split(/\r?\n/).map(pastedLine).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    onAdd(lines.slice(0, MAX_LINES));
  }

  return (
    <form
      onSubmit={submit}
      className="fixed inset-x-0 bottom-0 z-20 bg-bg/85 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl"
    >
      <div className="mx-auto max-w-lg">{status}</div>
      <div className="mx-auto flex max-w-lg items-center gap-2">
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onTyping?.(e.target.value.trim().length > 0);
          }}
          onBlur={() => onTyping?.(false)}
          onPaste={paste}
          maxLength={500}
          placeholder="Novo item"
          aria-label="Novo item"
          enterKeyHint="send"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-full border border-sep-strong bg-surface px-4 text-[17px] outline-none transition-[border-color,box-shadow] duration-200 ease-out placeholder:text-text-2 focus:border-text/25 focus:ring-4 focus:ring-halo"
        />
        <AnimatePresence initial={false}>
          {ready && (
            <motion.button
              key="send"
              type="submit"
              aria-label="Adicionar"
              initial={{ opacity: 0, transform: "scale(0.6)" }}
              animate={{ opacity: 1, transform: "scale(1)" }}
              exit={{ opacity: 0, transform: "scale(0.6)" }}
              whileTap={{ scale: 0.9 }}
              transition={{ type: "spring", duration: 0.35, bounce: 0.25 }}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-on-ink"
            >
              <ArrowUp />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </form>
  );
}
