"use client";

import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { initAuth } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import { Toast } from "./Toast";
import { UsernameSheet } from "./UsernameSheet";

export function Providers({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  useEffect(() => {
    initAuth();
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js");
    }
  }, []);

  return (
    // reducedMotion="user" drops transform animations for people who asked for less motion; opacity stays.
    <MotionConfig reducedMotion="user">
      {children}
      {/* Someone who logged in but closed the tab before picking a name gets asked again. */}
      <UsernameSheet open={!!user && !user.username} />
      <Toast />
    </MotionConfig>
  );
}
