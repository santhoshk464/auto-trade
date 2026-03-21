import { Suspense } from "react";

import TradeWindowRedirectClient from "./trade-window-redirect.client";

export default function TradeWindowPage() {
  return (
    <Suspense fallback={<div className="p-6">Redirecting…</div>}>
      <TradeWindowRedirectClient />
    </Suspense>
  );
}
