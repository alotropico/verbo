import { unstable_useComposerInput, useAuiState } from "@assistant-ui/react";
import { parseLocalCommand } from "@shared/local-commands";
import { isPersistedThreadId } from "@shared/thread-identity";
import type { FormEvent } from "react";
import { publishCommandStatus } from "@/runtime/command-status";

export function useLocalCommandGuard(): {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  sendOrCommand: () => void;
  canSend: boolean;
} {
  const input = unstable_useComposerInput();
  const threadId = useAuiState((state) => state.threads.mainThreadId);

  const runIfCommand = (): boolean => {
    if (!parseLocalCommand(input.value).handled) return false;
    const text = input.value;
    input.setText("");
    void window.verbo.commands
      .run({
        text,
        ...(isPersistedThreadId(threadId) ? { threadId } : {}),
      })
      .then((result) => {
        publishCommandStatus(result);
        if (result.openMemory) {
          window.dispatchEvent(
            new CustomEvent("verbo:open-settings", {
              detail: { tab: "memory" },
            }),
          );
        }
        window.dispatchEvent(new Event("verbo:memory-changed"));
      })
      .catch((error: unknown) => {
        input.setText(text);
        publishCommandStatus({
          status: "error",
          summary: error instanceof Error ? error.message : "Command failed.",
        });
      });
    return true;
  };

  return {
    onSubmit: (event) => {
      if (!runIfCommand()) return;
      event.preventDefault();
    },
    sendOrCommand: () => {
      if (runIfCommand()) return;
      input.send();
    },
    canSend: input.canSend,
  };
}
