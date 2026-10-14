import { Button, Popover, Text } from "@mantine/core";
import { ChoiceInput } from "./ChoiceInput";
import { useEffect, useState, type ReactElement } from "react";
import { useConfirmation } from "./confirmation-context";
import { StatusMessage } from "./StatusMessage";
import styles from "./ServiceControls.module.css";

type ServiceView = {
  name: "ollama" | "voice";
  state: "stopped" | "starting" | "ready" | "error";
  owned: boolean;
  reused: boolean;
  detail: string;
  error: string | null;
  suppressed: boolean;
};

type Snapshot = { ollama: ServiceView; voice: ServiceView };

function dotClass(state: ServiceView["state"]): string {
  if (state === "ready") return styles.ready;
  if (state === "error") return styles.error;
  if (state === "starting") return styles.starting;
  return styles.stopped;
}

export function ServiceControls(): ReactElement {
  const [services, setServices] = useState<Snapshot | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const confirm = useConfirmation();
  const [error, setError] = useState("");
  const [open, setOpen] = useState<null | "ollama" | "voice">(null);
  const [pending, setPending] = useState<null | "ollama" | "voice">(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [next, settings, status] = await Promise.all([
        window.verbo.services.snapshot(),
        window.verbo.settings.get(),
        window.verbo.ollama.status(),
      ]);
      if (cancelled) return;
      setServices(next);
      setModel(settings.settings.model);
      if (status.ok) setModels(status.models);
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const ollama = services?.ollama;
  const voice = services?.voice;

  const run = (
    name: "ollama" | "voice",
    action: () => Promise<
      { ok: false; summary: string } | { ok: true } | ServiceView
    >,
  ): void => {
    setOpen(null);
    setError("");
    setPending(name);
    void action()
      .then(async (result) => {
        setServices(await window.verbo.services.snapshot());
        if ("ok" in result && !result.ok) throw new Error(result.summary);
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not change the service.",
        ),
      )
      .finally(() => {
        setPending((current) => (current === name ? null : current));
      });
  };

  const dot = (name: "ollama" | "voice", state: ServiceView["state"]): string =>
    [styles.dot, dotClass(state), pending === name ? styles.pending : ""]
      .filter(Boolean)
      .join(" ");

  return (
    <div className={styles.group}>
      {error ? (
        <StatusMessage tone="error" display="plain" size="xs">
          {error}
        </StatusMessage>
      ) : null}
      <Popover
        opened={open === "ollama"}
        onChange={(next) => {
          if (!next)
            setOpen((current) => (current === "ollama" ? null : current));
        }}
        position="bottom-end"
        width={280}
      >
        <Popover.Target>
          <Button
            type="button"
            size="compact-xs"
            variant="subtle"
            classNames={{
              label: styles.statusLabel,
              root: styles.statusButton,
            }}
            onClick={() =>
              setOpen((current) => (current === "ollama" ? null : "ollama"))
            }
            aria-label={`Ollama ${ollama?.state ?? "loading"}. Model ${model || "unset"}`}
            leftSection={
              <span
                className={dot("ollama", ollama?.state ?? "starting")}
                aria-hidden="true"
              />
            }
          >
            {model || "Model"}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <div className={styles.panel}>
            <Text size="sm">{ollama?.detail ?? "Checking Ollama."}</Text>
            <ChoiceInput
              label="Model"
              data={models}
              value={model}
              onChange={(value) => {
                if (!value) return;
                setModel(value);
                void window.verbo.settings
                  .patch({ model: value })
                  .then((saved) =>
                    window.dispatchEvent(
                      new CustomEvent("verbo:settings-changed", {
                        detail: saved,
                      }),
                    ),
                  )
                  .catch(() => setError("Could not save the model."));
              }}
            />
            {ollama?.state === "ready" ? (
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setOpen(null);
                  void confirm({
                    title: "Stop Ollama?",
                    message: ollama.reused
                      ? "This service may be serving other programs. Stop it?"
                      : "The current reply will stop.",
                    confirmLabel: "Stop Ollama",
                    onConfirm: async () => {
                      const result = await window.verbo.services.stop("ollama");
                      if ("ok" in result && !result.ok)
                        throw new Error(result.summary);
                      setServices(await window.verbo.services.snapshot());
                    },
                  });
                }}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                onClick={() =>
                  run("ollama", () => window.verbo.services.start("ollama"))
                }
              >
                Start
              </Button>
            )}
          </div>
        </Popover.Dropdown>
      </Popover>
      <Popover
        opened={open === "voice"}
        onChange={(next) => {
          if (!next)
            setOpen((current) => (current === "voice" ? null : current));
        }}
        position="bottom-end"
        width={280}
      >
        <Popover.Target>
          <Button
            type="button"
            size="compact-xs"
            variant="subtle"
            classNames={{
              label: styles.statusLabel,
              root: styles.statusButton,
            }}
            onClick={() =>
              setOpen((current) => (current === "voice" ? null : "voice"))
            }
            aria-label={`Voice ${voice?.state ?? "loading"}`}
            leftSection={
              <span
                className={dot("voice", voice?.state ?? "stopped")}
                aria-hidden="true"
              />
            }
          >
            Voice
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <div className={styles.panel}>
            <Text size="sm">
              {voice?.detail ?? "Voice has not been started."}
            </Text>
            <Text size="xs">
              Service status is separate from the microphone session.
            </Text>
            {voice?.state === "ready" ? (
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setOpen(null);
                  void confirm({
                    title: "Stop voice?",
                    message: voice.reused
                      ? "This service may be serving other programs. Stop it?"
                      : "The current voice session will stop.",
                    confirmLabel: "Stop voice",
                    onConfirm: async () => {
                      const result = await window.verbo.services.stop("voice");
                      if ("ok" in result && !result.ok)
                        throw new Error(result.summary);
                      setServices(await window.verbo.services.snapshot());
                    },
                  });
                }}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                onClick={() =>
                  run("voice", () => window.verbo.services.start("voice"))
                }
              >
                Start
              </Button>
            )}
          </div>
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}
