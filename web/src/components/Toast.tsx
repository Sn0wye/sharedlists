"use client";

import { AnimatePresence, motion } from "motion/react";
import { useToast } from "@/lib/toast";

export function Toast() {
  const [toast, dismiss] = useToast();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] flex justify-center px-4"
    >
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, transform: "translateY(-16px) scale(0.96)" }}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={{ opacity: 0, transform: "translateY(-12px) scale(0.98)" }}
            transition={{ type: "spring", duration: 0.45, bounce: 0 }}
            className="pointer-events-auto flex h-11 items-center gap-3 rounded-full bg-ink pr-2 pl-4 text-[15px] font-medium text-on-ink shadow-[0_8px_30px_rgb(0_0_0/0.18)]"
          >
            <span>{toast.message}</span>
            {toast.action ? (
              <button
                onClick={() => {
                  toast.action?.onClick();
                  dismiss();
                }}
                className="press h-8 rounded-full bg-on-ink/15 px-3 font-semibold"
              >
                {toast.action.label}
              </button>
            ) : (
              <span className="w-2" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
