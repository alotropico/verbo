import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useMemo, type ReactNode } from "react";
import { createChatModelAdapter } from "./chat-model-adapter";
import { verboThreadListAdapter } from "./thread-list-adapter";

function useThreadRuntime() {
  const modelAdapter = useMemo(
    () => createChatModelAdapter(() => window.verbo.settings.get()),
    [],
  );
  return useLocalRuntime(modelAdapter);
}

export function VerboRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useRemoteThreadListRuntime({
    adapter: verboThreadListAdapter,
    runtimeHook: useThreadRuntime,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
