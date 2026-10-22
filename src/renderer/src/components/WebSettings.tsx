import { ActionIcon, Button, Group, Stack, Switch, Tooltip } from "@mantine/core";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { allowedEngines, type EngineId, type WebStatus } from "@shared/web";
import type { WebSettings } from "@shared/web-settings";
import { useSettingsAutosave, useSettingsDraft } from "@/hooks/use-settings-draft";
import { useSettingsResource } from "@/hooks/use-settings-resource";
import { AutosaveStatus } from "./AutosaveStatus";
import { SettingsLoading } from "./SettingsLoading";
import { SettingsSection } from "./SettingsSection";
import { SettingsSlider } from "./SettingsSlider";
import { StatusMessage } from "./StatusMessage";
import styles from "./WebSettings.module.css";

const ENGINE_META: Record<EngineId, { label: string; description: string }> = {
  duckduckgo: { label: "DuckDuckGo", description: "Privacy-focused general web search" },
  brave: { label: "Brave", description: "Independent search index" },
  bing: { label: "Bing", description: "Microsoft search engine" },
  google: { label: "Google", description: "Google search index" },
  wikipedia: { label: "Wikipedia", description: "Free online encyclopedia" },
  github: { label: "GitHub", description: "Software development and code repositories" },
};

type ServiceView = {
  name: "ollama" | "voice" | "web";
  state: "stopped" | "starting" | "ready" | "error";
  owned: boolean;
  reused: boolean;
  identity?: string | null;
  pid?: number | null;
  detail: string;
  error: string | null;
  suppressed: boolean;
};

export function WebSettings(): ReactElement {
  const resource = useSettingsResource("web/settings", () => window.verbo.web.settings());
  if (!resource.data) {
    return <SettingsLoading label="Loading web search settings…" error={resource.error} retry={() => void resource.reload()} />;
  }
  return <LoadedWebSettings initialSettings={resource.data} />;
}

function LoadedWebSettings({ initialSettings }: { initialSettings: WebSettings }): ReactElement {
  const [draft, setDraft] = useSettingsDraft("web/draft", initialSettings);
  const autosave = useSettingsAutosave<WebSettings>(
    "web/save",
    async (next) => {
      await window.verbo.web.setSettings(next);
    },
    undefined,
    initialSettings,
  );

  const [service, setService] = useState<ServiceView | null>(null);
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    autosave.controller.acceptBaseline(initialSettings);
  }, [initialSettings, autosave.controller]);

  const refreshService = async (): Promise<void> => {
    try {
      const snap = await window.verbo.services.snapshot();
      setService(snap.web);
    } catch {
      // ignore snapshot fetch error
    }
    try {
      const stat = await window.verbo.web.status();
      setStatus(stat);
    } catch {
      // ignore status fetch error
    }
  };

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const snap = await window.verbo.services.snapshot();
        if (!cancelled) setService(snap.web);
      } catch {
        // ignore
      }
      try {
        const stat = await window.verbo.web.status();
        if (!cancelled) setStatus(stat);
      } catch {
        // ignore
      }
    };
    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const updateDraft = (updater: (prev: WebSettings) => WebSettings): void => {
    setDraft((prev) => {
      const next = updater(prev);
      autosave.controller.schedule(next);
      return next;
    });
  };

  const enabledEngines = draft.engines;
  const disabledEngines = allowedEngines.filter((id) => !enabledEngines.includes(id));
  const orderedDisplay = [...enabledEngines, ...disabledEngines];

  const handleToggle = (engine: EngineId, checked: boolean): void => {
    if (checked) {
      updateDraft((prev) => ({
        ...prev,
        engines: prev.engines.includes(engine) ? prev.engines : [...prev.engines, engine],
      }));
    } else {
      if (enabledEngines.length <= 1) return; // Prevent disabling last engine
      updateDraft((prev) => ({
        ...prev,
        engines: prev.engines.filter((id) => id !== engine),
      }));
    }
  };

  const handleMove = (engine: EngineId, direction: "up" | "down"): void => {
    const index = enabledEngines.indexOf(engine);
    if (index === -1) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= enabledEngines.length) return;

    const next = [...enabledEngines];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    updateDraft((prev) => ({ ...prev, engines: next }));
  };

  const handleStart = async (): Promise<void> => {
    setPending(true);
    setActionError("");
    try {
      await window.verbo.services.start("web");
      await refreshService();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start web search service.");
    } finally {
      setPending(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    setPending(true);
    setActionError("");
    try {
      const result = await window.verbo.services.stop("web");
      if ("ok" in result && !result.ok) {
        setActionError(result.summary);
      }
      await refreshService();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to stop web search service.");
    } finally {
      setPending(false);
    }
  };

  const isServiceRunning = service?.state === "ready" || service?.state === "starting";

  return (
    <div className={styles.container}>
      <SettingsSection title="Web search service" description="Local SearXNG instance for privacy-preserving web searches.">
        <Stack gap="xs">
          <div className={styles.serviceHeader}>
            <div>
              {service?.state === "ready" ? (
                <StatusMessage display="outline" size="xs" tone="success">
                  Web search service is ready.
                </StatusMessage>
              ) : service?.state === "starting" ? (
                <StatusMessage display="outline" size="xs" tone="info">
                  Web search service is starting…
                </StatusMessage>
              ) : service?.state === "error" ? (
                <StatusMessage display="outline" size="xs" tone="error">
                  {service.error || service.detail || "Web search service error."}
                </StatusMessage>
              ) : (
                <StatusMessage display="outline" size="xs" tone="info">
                  {service?.detail || "Web search service is stopped."}
                </StatusMessage>
              )}
              {status && (!status.ok ? status.detail : !status.ready ? status.detail : null) ? (
                <p className={styles.warningNote}>{!status.ok ? status.detail : status.detail}</p>
              ) : null}
              {actionError ? <p className={styles.warningNote}>{actionError}</p> : null}
            </div>
            <div>
              {isServiceRunning ? (
                <Button size="xs" variant="default" loading={pending} onClick={() => void handleStop()}>
                  Stop service
                </Button>
              ) : (
                <Button size="xs" variant="default" loading={pending} onClick={() => void handleStart()}>
                  Start service
                </Button>
              )}
            </div>
          </div>
        </Stack>
      </SettingsSection>

      <SettingsSection
        title="Search engines"
        description="Select search engines and order by preference. At least one engine must remain enabled."
      >
        <div className={styles.engineList}>
          {orderedDisplay.map((engine) => {
            const meta = ENGINE_META[engine];
            const isEnabled = enabledEngines.includes(engine);
            const engineIndex = enabledEngines.indexOf(engine);
            const isOnlyOneEnabled = isEnabled && enabledEngines.length === 1;

            return (
              <div key={engine} className={styles.engineRow}>
                <div className={styles.engineInfo}>
                  <span className={styles.engineName}>{meta.label}</span>
                  <span className={styles.engineDesc}>{meta.description}</span>
                </div>
                <div className={styles.engineActions}>
                  {isEnabled ? (
                    <>
                      <Tooltip label="Move up" position="top">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={`Move ${meta.label} up`}
                          disabled={engineIndex === 0}
                          onClick={() => handleMove(engine, "up")}
                        >
                          <ArrowUpIcon size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Move down" position="top">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={`Move ${meta.label} down`}
                          disabled={engineIndex === enabledEngines.length - 1}
                          onClick={() => handleMove(engine, "down")}
                        >
                          <ArrowDownIcon size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  ) : null}
                  <Switch
                    checked={isEnabled}
                    disabled={isOnlyOneEnabled}
                    aria-label={`Enable ${meta.label}`}
                    onChange={(e) => handleToggle(engine, e.currentTarget.checked)}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {enabledEngines.length === 1 ? <p className={styles.warningNote}>At least one search engine must remain enabled.</p> : null}
      </SettingsSection>

      <SettingsSection title="Search parameters" description="Configure pagination size, snippet length, and query timeouts.">
        <Stack gap="md">
          <SettingsSlider
            label="Page size"
            description="Number of organic results returned per page (1 to 10)."
            min={1}
            max={10}
            step={1}
            value={draft.pageSize}
            display={`${draft.pageSize} results`}
            onChange={(val) => updateDraft((prev) => ({ ...prev, pageSize: val }))}
          />
          <SettingsSlider
            label="Maximum snippet length"
            description="Character limit for each result preview snippet (100 to 500)."
            min={100}
            max={500}
            step={10}
            value={draft.maxSnippetChars}
            display={`${draft.maxSnippetChars} chars`}
            onChange={(val) => updateDraft((prev) => ({ ...prev, maxSnippetChars: val }))}
          />
          <SettingsSlider
            label="Search timeout"
            description="Maximum search duration before timing out (2000 ms to 20000 ms)."
            min={2000}
            max={20000}
            step={500}
            value={draft.timeoutMs}
            display={`${draft.timeoutMs} ms`}
            onChange={(val) => updateDraft((prev) => ({ ...prev, timeoutMs: val }))}
          />
        </Stack>
      </SettingsSection>

      <Group justify="flex-end">
        <AutosaveStatus state={autosave.state} retry={() => autosave.controller.retry()} />
      </Group>
    </div>
  );
}
