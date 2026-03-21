import { Suspense } from "react";

import TradeTerminalClient from "./trade-terminal.client";

export default function TradeTerminalPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <TradeTerminalClient />
    </Suspense>
  );
}
