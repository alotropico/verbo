import { createContext, useContext } from "react";

export type ChatSelectionValue = {
  extraIds: readonly string[];
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  selectRange: (id: string) => void;
  selectVisible: () => void;
  cancel: () => void;
  setVisibleIds: (ids: readonly string[]) => void;
};

export const ChatSelectionContext = createContext<ChatSelectionValue | null>(
  null,
);

export function useChatSelection(): ChatSelectionValue {
  const value = useContext(ChatSelectionContext);
  if (!value) {
    throw new Error("Chat selection is only available inside the app shell.");
  }
  return value;
}
