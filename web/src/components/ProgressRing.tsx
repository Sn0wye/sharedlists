"use client";

import { AnimatePresence, motion } from "motion/react";

type Props = { done: number; total: number; size?: number; stroke?: number; className?: string };

/** Fills clockwise from the top. Reaching 100% pops a check in the middle, the one celebratory moment in the app. */
export function ProgressRing({ done, total, size = 24, stroke = 2.5, className }: Props) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = total === 0 ? 0 : done / total;
  const complete = total > 0 && done === total;

  return (
    <span className={`relative inline-grid place-items-center ${className ?? ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--sep-strong)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--done)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          style={{ transition: "stroke-dashoffset 400ms var(--ease-out)" }}
        />
      </svg>
      <AnimatePresence>
        {complete && (
          <motion.svg
            key="check"
            viewBox="0 0 24 24"
            className="absolute text-done"
            style={{ width: size * 0.55, height: size * 0.55 }}
            initial={{ opacity: 0, transform: "scale(0.5)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.7)" }}
            transition={{ type: "spring", duration: 0.45, bounce: 0.35 }}
            fill="none"
            stroke="currentColor"
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5 12.5l4.5 4.5L19 7" />
          </motion.svg>
        )}
      </AnimatePresence>
    </span>
  );
}
