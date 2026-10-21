"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface Props { intervalMs?: number }

/**
 * Periodically re-runs this route's server components while the tab is visible.
 * Hidden tabs should not poll Horizon/RPC, but returning to the tab should
 * immediately catch up rather than waiting for the next six-second tick.
 */
export default function AutoRefresh({ intervalMs = 6000 }: Props) {
  const router = useRouter();

  useEffect(() => {
    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const start = () => {
      if (timer === undefined) {
        timer = window.setInterval(() => router.refresh(), intervalMs);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        router.refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [router, intervalMs]);

  return null;
}
