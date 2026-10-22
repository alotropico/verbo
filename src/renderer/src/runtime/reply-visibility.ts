/** Focus is owned by the main process; the renderer reports the visible chat. */
export function observeReplyVisibility(threadId: string | null): () => void {
  const publish = (): void => {
    window.verbo.notifications.setVisibleThread(document.visibilityState === "visible" ? threadId : null);
  };
  publish();
  document.addEventListener("visibilitychange", publish);
  return () => {
    document.removeEventListener("visibilitychange", publish);
    window.verbo.notifications.setVisibleThread(null);
  };
}
