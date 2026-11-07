"use client";

import { AnimatePresence, motion } from "motion/react";
import { useOutbox } from "@/lib/offline";

/**
 * Small pill for the top bar. Pending changes only show once sending them failed, so a normal
 * tap never flashes anything; otherwise it falls back to the live connection state.
 */
export function SyncStatus({ offline = false }: { offline?: boolean }) {
  const { ops, stalled } = useOutbox();
  const label = stalled
    ? ops.length === 1
      ? "1 alteração pendente"
      : `${ops.length} alterações pendentes`
    : offline
      ? "Reconectando…"
      : null;

  return (
    <AnimatePresence>
      {label && (
        <motion.span
          role="status"
          title={stalled ? "Vai ser salvo quando a conexão voltar" : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="rounded-full bg-surface px-2.5 py-1 text-[13px] font-medium text-text-2 tabular-nums"
        >
          {label}
        </motion.span>
      )}
    </AnimatePresence>
  );
}
