import { Suspense } from "react";

import OpenHighClient from "./open-high.client";

export default function OpenHighPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <OpenHighClient />
    </Suspense>
  );
}
