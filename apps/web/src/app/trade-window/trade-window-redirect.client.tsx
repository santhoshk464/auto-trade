"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function TradeWindowRedirectClient() {
  const router = useRouter();
  const search = useSearchParams();

  useEffect(() => {
    const brokerId = search.get("brokerId");
    if (brokerId) {
      try {
        window.localStorage.setItem("at.selectedBrokerId", brokerId);
      } catch {
        // ignore
      }
    }

    router.replace("/trade-terminal");
  }, [router, search]);

  return <div className="p-6">Redirecting…</div>;
}
