import {
  ExportedMessageRepository,
  useAui,
  type AttachmentAdapter,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { isPersistedThreadId } from "@shared/thread-identity";
import { useMemo } from "react";
import { createVerboAttachmentAdapter } from "./attachment-adapter";

function useThreadHistoryAdapter(): ThreadHistoryAdapter {
  const aui = useAui();
  return useMemo(
    () => ({
      async load() {
        const { remoteId } = aui.threadListItem.getState();
        if (!remoteId) {
          return ExportedMessageRepository.fromArray([]);
        }
        const { messages, headId } =
          await window.verbo.storage.loadMessages(remoteId);
        return ExportedMessageRepository.fromBranchableArray(
          messages as { message: ThreadMessageLike; parentId: string | null }[],
          { headId },
        );
      },
      async append({ message, parentId }) {
        const { remoteId } = await aui.threadListItem.initialize();
        await window.verbo.storage.appendMessage({
          threadId: remoteId,
          parentId: parentId ?? undefined,
          message,
        });
      },
    }),
    [aui],
  );
}

function useAttachmentAdapter(): AttachmentAdapter {
  const aui = useAui();
  return useMemo(
    () =>
      createVerboAttachmentAdapter(() => {
        const remoteId = aui.threadListItem.getState().remoteId;
        return isPersistedThreadId(remoteId) ? remoteId : null;
      }),
    [aui],
  );
}

export function useThreadAdapters(): {
  history: ThreadHistoryAdapter;
  attachments: AttachmentAdapter;
} {
  const history = useThreadHistoryAdapter();
  const attachments = useAttachmentAdapter();
  return useMemo(() => ({ history, attachments }), [attachments, history]);
}
