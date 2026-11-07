"use client";

import { useMemo, useState } from "react";
import { encode } from "uqr";
import { groupUrl } from "@/lib/groups";
import { toast } from "@/lib/toast";
import { Sheet, sheetPrimary } from "./Sheet";

type Mode = "edit" | "read";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** Null when this device only has the read-only link. */
  editToken: string | null;
  readToken: string | null;
};

const COPY: Record<Mode, string> = {
  edit: "Quem abrir este link pode ver e editar as listas do grupo.",
  read: "Quem abrir este link pode ver as listas, mas não pode mudar nada.",
};

export function ShareSheet({ open, onOpenChange, name, editToken, readToken }: Props) {
  const [picked, setPicked] = useState<Mode>("edit");
  const mode: Mode = editToken && readToken ? picked : editToken ? "edit" : "read";
  const token = mode === "edit" ? editToken : readToken;
  const url = token ? `${location.origin}${groupUrl(token)}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copiado");
    } catch {
      // No clipboard over plain http (a LAN dev server, for one); the field below is selectable.
      toast("Não deu para copiar. Toque no link para selecionar.");
    }
  }

  async function share() {
    await navigator.share({ title: name, url }).catch(() => {});
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Compartilhar grupo" description={COPY[mode]}>
      {editToken && readToken && (
        <div role="radiogroup" aria-label="Permissão" className="grid grid-cols-2 rounded-xl bg-bg p-1 text-[15px] font-semibold">
          {(["edit", "read"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setPicked(m)}
              className={`h-9 rounded-lg transition-colors duration-150 ${
                mode === m ? "bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.12)]" : "text-text-2"
              }`}
            >
              {m === "edit" ? "Pode editar" : "Só ver"}
            </button>
          ))}
        </div>
      )}

      {url && (
        <>
          <div className="mx-auto mt-5 w-fit rounded-2xl bg-white p-4">
            <QrCode text={url} />
          </div>
          <input
            readOnly
            value={url}
            aria-label="Link do grupo"
            onFocus={(e) => e.currentTarget.select()}
            className="mt-4 h-10 w-full truncate rounded-xl bg-bg px-3 text-center text-[13px] text-text-2 outline-none"
          />
          {"share" in navigator ? (
            <>
              <button onClick={share} className={sheetPrimary}>
                Compartilhar…
              </button>
              <button
                onClick={copy}
                className="press mt-2 flex h-13 w-full items-center justify-center rounded-2xl bg-bg text-[17px] font-semibold"
              >
                Copiar link
              </button>
            </>
          ) : (
            <button onClick={copy} className={sheetPrimary}>
              Copiar link
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Dark modules on a white card in both themes: scanners expect dark-on-light. */
function QrCode({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 0 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, size: qr.size };
  }, [text]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-44" shapeRendering="crispEdges" role="img" aria-label="QR code do link">
      <path d={d} fill="#111113" />
    </svg>
  );
}
