import { notify } from "./notify";

/** Native writes acknowledge completion before copy feedback is shown. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await window.verbo.clipboard.writeText(text);
    return true;
  } catch {
    notify({
      id: "clipboard-copy-error",
      tone: "error",
      message: "Could not copy to the clipboard. Please try again.",
    });
    return false;
  }
}
