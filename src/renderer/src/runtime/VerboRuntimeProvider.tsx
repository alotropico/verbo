import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { createChatModelAdapter } from "./chat-model-adapter";
import { verboThreadListAdapter } from "./thread-list-adapter";
import { PERMANENT_MODEL_TOOLS } from "../../../shared/model-tools";

function useThreadRuntime(): ReturnType<typeof useLocalRuntime> {
  const modelAdapter = useMemo(
    () =>
      createChatModelAdapter(
        async () => (await window.verbo.settings.get()).settings,
      ),
    [],
  );
  return useLocalRuntime(modelAdapter, {
    unstable_humanToolNames: [...PERMANENT_MODEL_TOOLS],
  });
}

export function VerboRuntimeProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
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
