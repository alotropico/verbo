import { afterEach, expect, it, vi } from "vitest";
import { observeReplyVisibility } from "./reply-visibility";

afterEach(() => vi.unstubAllGlobals());
it("reports only the visible chat and clears it on hide or unmount", () => {
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: "visible",
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const setVisibleThread = vi.fn();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { verbo: { notifications: { setVisibleThread } } });
  const detach = observeReplyVisibility("saved-chat");
  expect(setVisibleThread).toHaveBeenLastCalledWith("saved-chat");
  document.visibilityState = "hidden";
  listeners.get("visibilitychange")?.();
  expect(setVisibleThread).toHaveBeenLastCalledWith(null);
  document.visibilityState = "visible";
  listeners.get("visibilitychange")?.();
  expect(setVisibleThread).toHaveBeenLastCalledWith("saved-chat");
  detach();
  expect(listeners.size).toBe(0);
  expect(setVisibleThread).toHaveBeenLastCalledWith(null);
  observeReplyVisibility(null)();
  expect(setVisibleThread).toHaveBeenLastCalledWith(null);
});
