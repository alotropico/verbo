import { Tooltip } from "@mantine/core";
import { useEffect, useState, type ReactElement } from "react";
import styles from "./OllamaStatusBanner.module.css";

type Status =
  | { kind: "loading" }
  | { kind: "ok"; model: string }
  | { kind: "error"; message: string };

export function OllamaStatusBanner(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const result = await window.verbo.ollama.status();
        if (cancelled) return;
        if (!result.ok) {
          setStatus({ kind: "error", message: result.error });
          return;
        }
        if (!result.modelInstalled) {
          setStatus({
            kind: "error",
            message: `Model "${result.configuredModel}" not installed. Installed: ${result.models.join(", ") || "(none)"}`,
          });
          return;
        }
        setStatus({ kind: "ok", model: result.configuredModel });
      } catch {
        if (!cancelled)
          setStatus({
            kind: "error",
            message:
              "Could not reach the local model. Check that Ollama is running.",
          });
      }
    };
    void poll();
    const id = window.setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const label =
    status.kind === "ok"
      ? "Local model ready"
      : status.kind === "error"
        ? "Model unavailable"
        : "Connecting to local model";
  const detail =
    status.kind === "ok"
      ? `Running ${status.model} on your machine`
      : status.kind === "error"
        ? status.message
        : label;

  return (
    <Tooltip
      label={detail}
      multiline
      maw={320}
      events={{ hover: true, focus: true, touch: true }}
    >
      <div
        className={styles.status}
        data-status={status.kind}
        tabIndex={0}
        role="status"
        aria-label={label}
      >
        <span className={styles.dot} aria-hidden="true" />
        <span>
          {status.kind === "ok"
            ? "Local"
            : status.kind === "error"
              ? "Unavailable"
              : "Connecting"}
        </span>
        {status.kind === "ok" && (
          <span className={styles.model}>{status.model.split(":")[0]}</span>
        )}
      </div>
    </Tooltip>
  );
}
