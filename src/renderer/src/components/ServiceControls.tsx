import { Button, Group, Popover, Select, Text } from "@mantine/core";
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

  const stop = async (name: "ollama" | "voice"): Promise<void> => {
    const result = await window.verbo.services.stop(name);
    setServices(await window.verbo.services.snapshot());
    setConfirm(null);
    if (!result.ok) {
      window.alert(result.summary);
    }
  };

  return (
    <div className={styles.group}>
      <Popover position="bottom-end" width={280}>
        <Popover.Target>
          <Button
            type="button"
            size="compact-sm"
            variant="subtle"
            classNames={{
              label: styles.statusLabel,
              root: styles.statusButton,
            }}
            aria-label={`Ollama ${ollama?.state ?? "loading"}. Model ${model || "unset"}`}
            leftSection={
              <span
                className={`${styles.dot} ${dotClass(ollama?.state ?? "starting")}`}
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
            <Select
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
              searchable
            />
            {ollama?.state === "ready" ? (
              confirm === "ollama" ? (
                <Group>
                  <Text size="xs">
                    Stop Ollama
                    {ollama.reused
                      ? "? It may be serving other programs."
                      : "? The current reply will stop."}
                  </Text>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => void stop("ollama")}
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
                onClick={() => void window.verbo.services.start("ollama")}
              >
                Start
              </Button>
            )}
          </div>
        </Popover.Dropdown>
      </Popover>
      <Popover position="bottom-end" width={280}>
        <Popover.Target>
          <Button
            type="button"
            size="compact-sm"
            variant="subtle"
            classNames={{
              label: styles.statusLabel,
              root: styles.statusButton,
            }}
            aria-label={`Voice ${voice?.state ?? "loading"}`}
            leftSection={
              <span
                className={`${styles.dot} ${dotClass(voice?.state ?? "stopped")}`}
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
                <Group>
                  <Text size="xs">
                    Stop the voice service
                    {voice.reused ? "? It may serve other clients." : "?"}
                  </Text>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => void stop("voice")}
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
                  void window.verbo.services
                    .start("voice")
                    .then(() => window.verbo.services.snapshot())
                    .then(setServices)
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
