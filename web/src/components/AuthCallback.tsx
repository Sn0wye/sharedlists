"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { refreshSession } from "@/lib/api";
import { useAuth } from "@/lib/hooks";

/** Landing page after the API finishes OAuth; the refresh cookie is already set by then. */
export function AuthCallback() {
  const router = useRouter();
  const { user } = useAuth();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cancelled = new URLSearchParams(location.search).has("error");
    (cancelled ? Promise.resolve(false) : refreshSession()).then((ok) => !ok && setFailed(true));
  }, []);

  // Once the username exists (now or after the sheet), go back where the login started.
  useEffect(() => {
    if (user?.username) {
      router.replace(sessionStorage.getItem("sl_return") ?? "/");
      sessionStorage.removeItem("sl_return");
    }
  }, [user, router]);

  return (
    <main className="mx-auto grid min-h-dvh max-w-sm place-items-center px-6 text-center">
      {failed ? (
        <div>
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Não foi possível entrar</h1>
          <p className="mt-2 text-[15px] text-text-2">O login foi cancelado ou expirou. Tente de novo pela tela inicial.</p>
          <button onClick={() => router.replace("/")} className="press mt-6 h-11 rounded-full bg-ink px-5 font-semibold text-on-ink">
            Voltar ao início
          </button>
        </div>
      ) : (
        <p className="text-text-2" role="status">
          Entrando…
        </p>
      )}
    </main>
  );
}
