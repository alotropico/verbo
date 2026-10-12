import type { ActionsOverview } from "@shared/actions-overview";
import { scopeAliasSchema } from "@shared/files";
import { Button, Stack, Text, TextInput } from "@mantine/core";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./ActionsSettings.module.css";

function aliasOrError(value: string): string | null {
  const parsed = scopeAliasSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function ActionsSettings(): ReactElement {
  const [overview, setOverview] = useState<ActionsOverview | null>(null);
  const [error, setError] = useState("");
  const [projectAlias, setProjectAlias] = useState("");
  const [hostAlias, setHostAlias] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((): void => {
    void window.verbo.actions
      .overview()
      .then((next) => {
        setOverview(next);
        setError("");
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : "Could not load actions.",
        );
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addRoot = (
    alias: string,
    add: (input: {
      pickId: string;
      alias: string;
    }) => Promise<{ ok: boolean; summary: string }>,
    clear: () => void,
  ): void => {
    const parsed = aliasOrError(alias);
    if (!parsed) {
      setError("Use a short lowercase alias.");
      return;
    }
    setBusy(true);
    void window.verbo.files
      .pick()
      .then(async (pick) => {
        if (!pick.ok) {
          setError(pick.code === "cancelled" ? "" : pick.summary);
          return;
        }
        const saved = await add({ pickId: pick.pickId, alias: parsed });
        if (!saved.ok) {
          setError(saved.summary);
          return;
        }
        clear();
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Could not add.");
      })
      .finally(() => setBusy(false));
  };

  const categories =
    overview?.catalog.filter((entry) => entry.kind === "category") ?? [];
  const history = overview?.history.slice(0, 12) ?? [];

  return (
    <Stack gap="sm">
      <Text size="sm">
        Approval stays on each action. This tab cannot turn it off. Project and
        AGS registration never grants write access.
      </Text>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      <Text fw={500}>Catalog</Text>
      {categories.map((category) => (
        <Stack gap={4} key={category.id}>
          <Text size="sm">{category.description}</Text>
          <ul className={styles.catalog}>
            {overview?.catalog
              .filter((entry) => entry.id.startsWith(`${category.id}.`))
              .map((entry) => (
                <li className={styles.entry} key={entry.id}>
                  <Text size="sm">
                    {entry.id}
                    {entry.approval === "required"
                      ? " · approval required"
                      : ""}
                  </Text>
                  <Text className={styles.path} size="xs">
                    {entry.description}
                  </Text>
                </li>
              ))}
          </ul>
        </Stack>
      ))}
      <Text fw={500}>Registered projects</Text>
      <div className={styles.row}>
        <TextInput
          className={styles.aliasField}
          label={
            <SettingsLabel
              label="Project alias"
              tip="Name for a project folder the model can open."
            />
          }
          value={projectAlias}
          onChange={(event) => setProjectAlias(event.currentTarget.value)}
        />
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() =>
            addRoot(projectAlias, window.verbo.projects.add, () =>
              setProjectAlias(""),
            )
          }
        >
          Add project folder
        </Button>
      </div>
      <ul className={styles.roots}>
        {overview?.projects.map((project) => (
          <li className={styles.row} key={project.id}>
            <Text size="sm">{project.alias}</Text>
            <Text className={styles.path} size="xs">
              {project.path}
            </Text>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => {
                void window.verbo.projects.remove(project.id).then(load);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Text fw={500}>AGS hosts</Text>
      <Text size="sm">
        {overview?.agsCheckConfigured
          ? `Check command: ${overview.agsCheckPath}`
          : "No allowlisted ags executable is configured. ags.check stays unavailable."}
      </Text>
      <div className={styles.row}>
        <Button
          type="button"
          size="xs"
          variant="default"
          onClick={() => {
            void window.verbo.ags.chooseCheck().then((result) => {
              if (!result.ok) setError(result.summary);
              else load();
            });
          }}
        >
          Choose ags executable
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          onClick={() => {
            void window.verbo.ags.clearCheck().then(load);
          }}
        >
          Clear check command
        </Button>
      </div>
      <div className={styles.row}>
        <TextInput
          className={styles.aliasField}
          label={
            <SettingsLabel
              label="Host alias"
              tip="Name for an AGS repository root."
            />
          }
          value={hostAlias}
          onChange={(event) => setHostAlias(event.currentTarget.value)}
        />
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() =>
            addRoot(hostAlias, window.verbo.ags.addHost, () => setHostAlias(""))
          }
        >
          Add AGS host
        </Button>
      </div>
      <ul className={styles.roots}>
        {overview?.agsHosts.map((host) => (
          <li className={styles.row} key={host.id}>
            <Text size="sm">{host.alias}</Text>
            <Text className={styles.path} size="xs">
              {host.path}
            </Text>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => {
                void window.verbo.ags.removeHost(host.id).then(load);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Text fw={500}>Recent actions</Text>
      {history.length === 0 ? (
        <Text size="sm">No recent actions.</Text>
      ) : (
        <ul className={styles.history}>
          {history.map((entry) => (
            <li
              className={styles.entry}
              key={`${entry.createdAt}-${entry.actionId}`}
            >
              <Text
                className={
                  entry.status === "error" || entry.status === "partial"
                    ? styles.error
                    : undefined
                }
                size="sm"
              >
                {entry.actionId}
                {entry.code ? ` (${entry.code})` : ""} · {entry.status}
              </Text>
              <Text size="xs">{entry.summary}</Text>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}
