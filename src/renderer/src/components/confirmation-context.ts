import { createContext, useContext, type ReactNode } from "react";
export type Confirmation = {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
};
export type Request = Confirmation & { resolve: (accepted: boolean) => void };
export const ConfirmationContext = createContext<
  ((options: Confirmation) => Promise<boolean>) | null
>(null);

export function useConfirmation(): (options: Confirmation) => Promise<boolean> {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("ConfirmationProvider is missing.");
  return confirm;
}
