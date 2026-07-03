"use client";

import { useEffect } from "react";

/** Registers the service worker (production only — caching fights dev HMR). */
export default function PwaSetup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    navigator.serviceWorker.register(`${basePath}/sw.js`).catch(() => {
      // offline support is progressive enhancement; never break the app
    });
  }, []);
  return null;
}
