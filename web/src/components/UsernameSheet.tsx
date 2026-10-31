"use client";

import { useState } from "react";
import { ApiError, setUsername } from "@/lib/api";
import { Sheet, sheetInput, sheetPrimary } from "./Sheet";

export function UsernameSheet({ open }: { open: boolean }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setUsername(name.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Esse nome já está em uso. Tente outro."
          : "Use de 2 a 24 letras, números, ponto, hífen ou _.",
      );
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      dismissible={false}
      title="Escolha seu nome"
      description="Aparece nos itens que você adiciona e marca. Não dá para mudar depois."
    >
      <form onSubmit={submit}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          maxLength={24}
          required
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Nome de usuário"
          aria-invalid={!!error}
          aria-describedby={error ? "username-error" : undefined}
          placeholder="ex: ana.souza"
          className={sheetInput}
        />
        {error && (
          <p id="username-error" className="mt-2 text-[15px] text-danger">
            {error}
          </p>
        )}
        <button disabled={saving || name.trim().length < 2} className={sheetPrimary}>
          {saving ? "Salvando…" : "Continuar"}
        </button>
      </form>
    </Sheet>
  );
}
