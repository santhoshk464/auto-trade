"use client";

import { useEffect, useState, useRef } from "react";
import { apiFetch, ApiError } from "./api";

export type MeUser = {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500; // wait 1.5s between retries

async function fetchMe(): Promise<MeUser | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await apiFetch<{ user: MeUser }>("/auth/me");
      return res.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Genuinely not authenticated — stop retrying
        return null;
      }
      if (attempt < MAX_RETRIES) {
        // Transient error (server restarting, network blip, 500, etc.)
        // Wait and retry so a short API restart doesn't log the user out
        console.warn(
          `[useMe] /auth/me failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS}ms:`,
          err instanceof ApiError
            ? `${err.status} ${err.message}`
            : String(err),
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error(
          `[useMe] /auth/me failed after ${MAX_RETRIES + 1} attempts, giving up:`,
          err instanceof ApiError
            ? `${err.status} ${err.message}`
            : String(err),
        );
        return null;
      }
    }
  }
  return null;
}

export function useMe() {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);

    fetchMe().then((result) => {
      if (cancelledRef.current) return;
      setUser(result);
      setLoading(false);
    });

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return { user, loading };
}
