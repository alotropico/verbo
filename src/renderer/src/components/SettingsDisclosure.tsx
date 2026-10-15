import { Collapsible } from "@base-ui/react/collapsible";
import { Stack, UnstyledButton } from "@mantine/core";
import { ChevronDownIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import styles from "./SettingsDisclosure.module.css";

export function SettingsDisclosure({
  title,
  children,
  open,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactElement {
  return (
    <Collapsible.Root
      className={styles.root}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Collapsible.Trigger
        render={<UnstyledButton className={styles.trigger} />}
      >
        <span className={styles.title}>{title}</span>
        <ChevronDownIcon aria-hidden size={16} className={styles.chevron} />
      </Collapsible.Trigger>
      <Collapsible.Panel className={styles.panel}>
        <Stack gap="sm" p="md" pt={0}>
          {children}
        </Stack>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
