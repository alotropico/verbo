import { useSyncExternalStore } from "react";

const KEY = "verbo:advanced-export";
const EVENT = "verbo:advanced-export";

export function readAdvancedExport(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAdvancedExport(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeAdvancedExport(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useAdvancedExport(): boolean {
  return useSyncExternalStore(
    subscribeAdvancedExport,
    readAdvancedExport,
    () => false,
  );
}
