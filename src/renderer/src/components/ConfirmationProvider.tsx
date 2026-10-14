import {
  ConfirmationContext,
  type Confirmation,
  type Request,
} from "./confirmation-context";
import { Button, Group, Modal, Text } from "@mantine/core";
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
        }
      }),
    [],
  );
  const finish = (accepted: boolean): void => {
    activeRef.current?.resolve(accepted);
    const next = requests.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
    setError("");
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
        opened={active !== null}
        onClose={() => {
          if (!busy) finish(false);
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
            disabled={busy}
            onClick={() => finish(false)}
          >
            Cancel
          </Button>
          <Button
            color={active?.destructive ? "red" : undefined}
            loading={busy}
            onClick={() => {
              if (!active) return;
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
