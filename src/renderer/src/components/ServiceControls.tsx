import { Button, Group, Popover, Text } from "@mantine/core";
import { ChoiceInput } from "./ChoiceInput";
import { useEffect, useState, type ReactElement } from "react";
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
  const [confirm, setConfirm] = useState<null | "ollama" | "voice">(null);
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
    action: () => Promise<{ ok: false; summary: string } | { ok: true } | ServiceView>,
  ): void => {
    setOpen(null);
    setConfirm(null);
    setPending(name);
    void action()
      .then(async (result) => {
        setServices(await window.verbo.services.snapshot());
        if ("ok" in result && !result.ok) window.alert(result.summary);
      })
      .finally(() => {
        setPending((current) => (current === name ? null : current));
      });
  };

  const dot = (name: "ollama" | "voice", state: ServiceView["state"]): string =>
    [
      styles.dot,
      dotClass(state),
      pending === name ? styles.pending : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div className={styles.group}>
      <Popover
        opened={open === "ollama"}
        onChange={(next) => {
          if (!next) setOpen((current) => (current === "ollama" ? null : current));
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
                void window.verbo.settings.get().then((current) =>
                  window.verbo.settings.set({
                    ...current.settings,
                    model: value,
                  }),
                );
              }}
            />
            {ollama?.state === "ready" ? (
              confirm === "ollama" ? (
                <>
                  <Text size="xs">
                    Stop Ollama
                    {ollama.reused
                      ? "? It may be serving other programs."
                      : "? The current reply will stop."}
                  </Text>
                  <Group gap="xs">
                    <Button
                      type="button"
                      size="xs"
                      onClick={() =>
                        run("ollama", () => window.verbo.services.stop("ollama"))
                      }
                    >
                      Stop Ollama
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      onClick={() => setConfirm(null)}
                    >
                      Keep running
                    </Button>
                  </Group>
                </>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  onClick={() => setConfirm("ollama")}
                >
                  Stop
                </Button>
              )
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
          if (!next) setOpen((current) => (current === "voice" ? null : current));
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
              confirm === "voice" ? (
                <>
                  <Text size="xs">
                    Stop the voice service
                    {voice.reused ? "? It may serve other clients." : "?"}
                  </Text>
                  <Group gap="xs">
                    <Button
                      type="button"
                      size="xs"
                      onClick={() =>
                        run("voice", () => window.verbo.services.stop("voice"))
                      }
                    >
                      Stop voice
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      onClick={() => setConfirm(null)}
                    >
                      Keep running
                    </Button>
                  </Group>
                </>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  onClick={() => setConfirm("voice")}
                >
                  Stop
                </Button>
              )
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
