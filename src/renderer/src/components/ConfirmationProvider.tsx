import {
  ConfirmationContext,
  type Confirmation,
  type Request,
} from "./confirmation-context";
import { Button, Group, Modal, Text } from "@mantine/core";
import { CheckIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { StatusMessage } from "./StatusMessage";

export function ConfirmationProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [active, setActive] = useState<Request | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requests = useRef<Request[]>([]);
  const activeRef = useRef<Request | null>(null);
  const confirm = useCallback(
    (options: Confirmation): Promise<boolean> =>
      new Promise((resolve) => {
        const request = { ...options, resolve };
        if (activeRef.current) requests.current.push(request);
        else {
          activeRef.current = request;
          setActive(request);
          setError("");
          setOpened(true);
        }
      }),
    [],
  );
  const finish = (accepted: boolean): void => {
    if (!activeRef.current) return;
    activeRef.current.resolve(accepted);
    const next = requests.current.shift() ?? null;
    activeRef.current = next;
    if (next) {
      setActive(next);
      setError("");
    } else {
      // Keep the title, message and error in place throughout the exit animation.
      setOpened(false);
    }
  };
  useEffect(
    () => () => {
      activeRef.current?.resolve(false);
      for (const request of requests.current) request.resolve(false);
    },
    [],
  );
  return (
    <ConfirmationContext value={confirm}>
      {children}
      <Modal
        opened={opened}
        onClose={() => {
          if (!busy) finish(false);
        }}
        onExitTransitionEnd={() => {
          if (!activeRef.current) {
            setActive(null);
            setError("");
          }
        }}
        title={active?.title}
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        closeButtonProps={{ disabled: busy }}
      >
        <Text component="div" size="sm" c="dimmed">
          {active?.message}
        </Text>
        {error ? (
          <StatusMessage display="plain" tone="error" size="sm">
            {error}
          </StatusMessage>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            leftSection={<XIcon aria-hidden size={16} />}
            disabled={busy}
            onClick={() => finish(false)}
          >
            Cancel
          </Button>
          <Button
            color={active?.destructive ? "red" : undefined}
            leftSection={
              active?.destructive ? (
                <Trash2Icon aria-hidden size={16} />
              ) : (
                <CheckIcon aria-hidden size={16} />
              )
            }
            loading={busy}
            onClick={() => {
              if (!opened || busy || !active) return;
              setBusy(true);
              setError("");
              void Promise.resolve()
                .then(active.onConfirm)
                .then(() => finish(true))
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The action could not be completed.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {active?.confirmLabel ?? "Confirm"}
          </Button>
        </Group>
      </Modal>
    </ConfirmationContext>
  );
}
