import {
  FolderPlusIcon,
  ScanSearchIcon,
  ShieldPlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Switch,
  Group,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  applicationRegistrationSchema,
  projectPreferencesSchema,
  type EntitySettings,
  type ApplicationRegistrationInput,
  type ProjectPreferences,
  type ProjectImportSettings,
  type RegisteredApplication,
  type RegisteredProject,
} from "@shared/application-registration";
import { notify } from "@/lib/notify";
import { StatusMessage, type StatusFeedback } from "./StatusMessage";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsSection } from "./SettingsSection";
import { SettingsLabel } from "./SettingsLabel";
import {
  useSettingsAutosave,
  useSettingsDraft,
  useSettingsRef,
  useSettingsForm,
} from "@/hooks/use-settings-draft";
import { AutosaveStatus } from "./AutosaveStatus";
import { useConfirmation } from "./confirmation-context";
import { scopeAliasSchema } from "@shared/files";
import styles from "./ActionsSettings.module.css";

function ApplicationEditor({
  application,
  reload,
}: {
  application?: RegisteredApplication;
  reload: () => void;
}): ReactElement {
  const key = `application/${application?.id ?? "new"}/`;
  const [notice, setNotice] = useSettingsDraft<StatusFeedback | null>(
    key + "notice",
    null,
  );
  const [busy, setBusy] = useSettingsDraft(key + "busy", false);
  const [opened, setOpened] = useSettingsDraft(key + "open", false);
  const [aliasSearch, setAliasSearch] = useSettingsDraft(
    key + "alias-search",
    "",
  );
  const confirm = useConfirmation();
  const autosave = useSettingsAutosave<ApplicationRegistrationInput>(
    key + "save",
    async (value) => {
      const result = await window.verbo.commands.saveApplication(value);
      if (!result.ok) throw new Error(result.summary);
      reload();
    },
  );
  const form = useSettingsForm(key + "form", {
    mode: "uncontrolled",
    onValuesChange: () => {
      if (application) void save();
    },
    initialValues: {
      name: application?.name ?? "",
      aliases: application?.aliases ?? [],
      executable: application?.executable ?? "",
      enabled: application?.enabled ?? true,
      cwdPolicy: application?.cwdPolicy ?? "project",
      arguments:
        application?.launchArguments
          .map((binding) =>
            "literal" in binding ? binding.literal : "{project}",
          )
          .join("\n") ?? "{project}",
    },
  });
  const save = async (): Promise<void> => {
    const value = form.getValues();
    const parsed = applicationRegistrationSchema.safeParse({
      ...(application ? { id: application.id } : {}),
      name: value.name,
      aliases: value.aliases,
      executable: value.executable,
      enabled: value.enabled,
      supportedTargets: application?.supportedTargets ?? [
        "folder",
        "repository",
      ],
      supportedPlatforms: ["win32"],
      cwdPolicy: value.cwdPolicy,
      launchArguments: value.arguments
        .split("\n")
        .map((line) =>
          line === "{project}" ? { target: "path" } : { literal: line },
        ),
    });
    if (!parsed.success) {
      setNotice({
        text:
          parsed.error.issues[0]?.message ?? "Check the application settings.",
        tone: "error",
      });
      return;
    }
    if (application) {
      setNotice(null);
      autosave.controller.schedule(parsed.data);
      return;
    }
    setBusy(true);
    try {
      const result = await window.verbo.commands.saveApplication(parsed.data);
      if (result.ok) {
        setNotice(null);
        notify({ message: result.summary, tone: "success" });
        reload();
      } else setNotice({ text: result.summary, tone: "error" });
    } catch {
      setNotice({
        text: "The application could not be registered.",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  const editor = (
    <Stack gap="md" className={application ? undefined : styles.entry}>
      {!application ? <Text fw={500}>Register an application</Text> : null}
      <SimpleGrid type="container" cols={{ base: 1, "640px": 2 }} spacing="sm">
        <TextInput
          label={
            <SettingsLabel
              label="Display name"
              tip="The name shown for this application in Settings and project choices."
            />
          }
          key={form.key("name")}
          {...form.getInputProps("name")}
        />
        <TagsInput
          label={
            <SettingsLabel
              label="Application aliases"
              tip="Short lowercase names you can use to request this application. Press Enter or comma to add one."
            />
          }
          maxTags={12}
          searchValue={aliasSearch}
          onSearchChange={setAliasSearch}
          key={form.key("aliases")}
          {...form.getInputProps("aliases")}
        />
      </SimpleGrid>
      <TextInput
        label={
          <SettingsLabel
            label="Windows executable"
            tip="Full path to the installed application’s .exe file."
          />
        }
        placeholder="Choose the installed .exe path"
        key={form.key("executable")}
        {...form.getInputProps("executable")}
      />
      <Textarea
        label={
          <SettingsLabel
            label="Arguments, one per line"
            tip="Each line is one launch argument. Use {project} for the chosen folder; other lines are passed exactly as written."
          />
        }
        description="Use {project} for the folder. Other lines are fixed arguments, passed as separate values."
        minRows={2}
        key={form.key("arguments")}
        {...form.getInputProps("arguments")}
      />
      <SimpleGrid
        type="container"
        cols={{ base: 1, "640px": 2 }}
        spacing="md"
        className={styles.preferenceFields}
      >
        <Select
          label={
            <SettingsLabel
              label="Working directory"
              tip="The starting folder for the program: the project, the application’s folder, or the system default."
            />
          }
          data={[
            { value: "project", label: "Project folder" },
            { value: "application", label: "Application folder" },
            { value: "none", label: "System default" },
          ]}
          allowDeselect={false}
          key={form.key("cwdPolicy")}
          {...form.getInputProps("cwdPolicy")}
        />
        <Switch
          label={
            <SettingsLabel
              label="Available for projects"
              tip="Allow this trusted application to be selected when opening projects."
            />
          }
          key={form.key("enabled")}
          {...form.getInputProps("enabled", { type: "checkbox" })}
        />
      </SimpleGrid>
      <Text size="xs">
        Registration trusts this executable and these arguments. Model launches
        require confirmation. Launch receipts confirm that the program started.
      </Text>
      <Group gap="xs">
        {!application ? (
          <Button
            leftSection={<ShieldPlusIcon aria-hidden size={16} />}
            size="xs"
            loading={busy}
            onClick={() => void save()}
          >
            Add and trust application
          </Button>
        ) : null}
        {application ? (
          <Button
            leftSection={<Trash2Icon aria-hidden size={16} />}
            size="xs"
            type="button"
            variant="default"
            disabled={busy}
            onClick={() =>
              void confirm({
                title: "Remove application?",
                message: `Remove ${application.name} from trusted applications?`,
                confirmLabel: "Remove application",
                destructive: true,
                onConfirm: async () => {
                  await autosave.controller.reset();
                  const result = await window.verbo.commands.removeApplication(
                    application.id,
                  );
                  if (!result.ok) throw new Error(result.summary);
                  reload();
                },
              })
            }
          >
            Remove
          </Button>
        ) : null}
      </Group>
      {application ? (
        <AutosaveStatus
          state={autosave.state}
          retry={() => autosave.controller.retry()}
        />
      ) : null}
      {notice ? (
        <StatusMessage display="plain" size="sm" tone={notice.tone}>
          {notice.text}
        </StatusMessage>
      ) : null}
    </Stack>
  );
  return application ? (
    <SettingsDisclosure
      title={application.name}
      open={opened}
      onOpenChange={setOpened}
    >
      {editor}
    </SettingsDisclosure>
  ) : (
    editor
  );
}

function ProjectEditor({
  project,
  applications,
  reload,
}: {
  project: RegisteredProject;
  applications: RegisteredApplication[];
  reload: () => void;
}): ReactElement {
  const confirm = useConfirmation();
  const key = `project/${project.id}/`;
  const [error, setError] = useSettingsDraft(key + "error", "");
  const [opened, setOpened] = useSettingsDraft(key + "open", false);
  const [aliasSearch, setAliasSearch] = useSettingsDraft(
    key + "alias-search",
    "",
  );
  const autosave = useSettingsAutosave<ProjectPreferences>(
    key + "save",
    async (value) => {
      const result = await window.verbo.commands.saveProject(value);
      if (!result.ok) throw new Error(result.summary);
      reload();
    },
  );
  const form = useSettingsForm(key + "form", {
    mode: "uncontrolled",
    initialValues: {
      id: project.id,
      name: project.name,
      aliases: project.aliases.filter((alias) => alias !== project.alias),
      enabled: project.enabled,
      defaultApplicationId: project.defaultApplicationId,
      favoriteApplicationIds: project.favoriteApplicationIds,
    },
    onValuesChange: (values) => {
      const parsed = projectPreferencesSchema.safeParse(values);
      setError(
        parsed.success
          ? ""
          : (parsed.error.issues[0]?.message ?? "Check project settings."),
      );
      if (parsed.success) autosave.controller.schedule(parsed.data);
    },
  });
  const choices = applications
    .filter((app) => app.enabled && app.supportedTargets.includes("folder"))
    .map((app) => ({ value: app.id, label: app.name }));
  return (
    <SettingsDisclosure
      title={project.name + " (" + project.alias + ")"}
      open={opened}
      onOpenChange={setOpened}
    >
      <Text size="xs">{project.path}</Text>
      <SimpleGrid type="container" cols={{ base: 1, "640px": 2 }} spacing="sm">
        <TextInput
          label={
            <SettingsLabel
              label="Display name"
              tip="A readable name for this project folder."
            />
          }
          key={form.key("name")}
          {...form.getInputProps("name")}
        />
        <TagsInput
          label={
            <SettingsLabel
              label="Additional aliases"
              tip="Other lowercase project names. Press Enter or comma to add one. The original alias is retained."
            />
          }
          maxTags={12}
          searchValue={aliasSearch}
          onSearchChange={setAliasSearch}
          description={"Original alias: " + project.alias}
          key={form.key("aliases")}
          {...form.getInputProps("aliases")}
        />
        <Select
          label={
            <SettingsLabel
              label="Default application"
              tip="Open with this application unless you request another. Clear it to use no default."
            />
          }
          data={choices}
          clearable
          searchable
          key={form.key("defaultApplicationId")}
          {...form.getInputProps("defaultApplicationId")}
        />
        <MultiSelect
          label={
            <SettingsLabel
              label="Favorite applications"
              tip="Up to 16 applications to offer for this project."
            />
          }
          data={choices}
          maxValues={16}
          searchable
          key={form.key("favoriteApplicationIds")}
          {...form.getInputProps("favoriteApplicationIds")}
        />
      </SimpleGrid>
      <Switch
        label={
          <SettingsLabel
            label="Available for opening"
            tip="Allow Verbo to open this project with a trusted application."
          />
        }
        key={form.key("enabled")}
        {...form.getInputProps("enabled", { type: "checkbox" })}
      />
      <Group>
        <Button
          leftSection={<Trash2Icon aria-hidden size={16} />}
          size="xs"
          variant="subtle"
          color="red"
          onClick={() =>
            void confirm({
              title: "Remove project?",
              message:
                "Remove " +
                project.name +
                " from registered projects? The folder will remain.",
              confirmLabel: "Remove project",
              destructive: true,
              onConfirm: async () => {
                await autosave.controller.reset();
                const result = await window.verbo.projects.remove(project.id);
                if (!result.ok) throw new Error(result.summary);
                reload();
              },
            })
          }
        >
          Remove project
        </Button>
      </Group>
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
        </StatusMessage>
      ) : null}
    </SettingsDisclosure>
  );
}

function ApplicationDiscovery({
  data,
  reload,
}: {
  data: EntitySettings;
  reload: () => void;
}): ReactElement {
  const [candidates, setCandidates] = useSettingsDraft<
    Array<{ name: string; aliases: string[]; executable: string }>
  >("application-discovery/candidates", []);
  const [busy, setBusy] = useSettingsDraft("application-discovery/busy", false);
  const [error, setError] = useSettingsDraft("application-discovery/error", "");
  const [detectionNotice, setDetectionNotice] = useSettingsDraft(
    "application-discovery/notice",
    "",
  );
  const [importSettings, setImportSettings] =
    useSettingsDraft<ProjectImportSettings>(
      "application-discovery/import-settings",
      data.projectImport ?? { enabled: false, applicationIds: [] },
    );
  const currentRef = useSettingsRef(
    "application-discovery/current",
    importSettings,
  );
  const baselineRef = useSettingsRef(
    "application-discovery/baseline",
    JSON.stringify(importSettings),
  );
  const confirm = useConfirmation();
  const autosave = useSettingsAutosave<ProjectImportSettings>(
    "application-discovery/save",
    async (value) => {
      const result = await window.verbo.commands.saveProjectImport(value);
      if (!result.ok) throw new Error(result.summary);
      baselineRef.current = JSON.stringify(value);
      reload();
    },
  );
  useEffect(() => {
    if (JSON.stringify(currentRef.current) === baselineRef.current) {
      const next = data.projectImport ?? { enabled: false, applicationIds: [] };
      currentRef.current = next;
      setImportSettings(next);
      baselineRef.current = JSON.stringify(next);
    }
  }, [data.projectImport, currentRef, baselineRef, setImportSettings]);
  const chooseFavorites = (applicationIds: string[]): void => {
    const next = { ...currentRef.current, applicationIds };
    setImportSettings(next);
    currentRef.current = next;
    autosave.controller.schedule(next);
  };
  const toggle = async (
    candidate: (typeof candidates)[number],
    checked: boolean,
  ): Promise<void> => {
    const existing = data.applications.find(
      (app) =>
        app.executable.toLowerCase() === candidate.executable.toLowerCase(),
    );
    if (!checked && existing) {
      await confirm({
        title: "Remove application?",
        message: `Remove ${existing.name} from trusted applications?`,
        confirmLabel: "Remove application",
        destructive: true,
        onConfirm: async () => {
          await autosave.controller.flush();
          const result = await window.verbo.commands.removeApplication(
            existing.id,
          );
          if (!result.ok) throw new Error(result.summary);
          chooseFavorites(
            currentRef.current.applicationIds.filter(
              (id) => id !== existing.id,
            ),
          );
          reload();
        },
      });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const used = new Set(data.applications.flatMap((app) => app.aliases));
      let aliases = candidate.aliases.filter((alias) => !used.has(alias));
      if (!aliases.length) {
        let suffix = 2;
        let alias = `${candidate.aliases[0].slice(0, 25)}-${suffix}`;
        while (used.has(alias))
          alias = `${candidate.aliases[0].slice(0, 25)}-${++suffix}`;
        aliases = [alias];
      }
      const result = await window.verbo.commands.saveApplication({
        name: candidate.name.slice(0, 100),
        aliases,
        executable: candidate.executable,
        enabled: true,
        supportedTargets: ["folder", "repository"],
        supportedPlatforms: ["win32"],
        cwdPolicy: "project",
        launchArguments: [{ target: "path" }],
      });
      if (!result.ok) throw new Error(result.summary);
      const next = await window.verbo.commands.entities();
      const added = next.applications.find(
        (app) =>
          app.executable.toLowerCase() === candidate.executable.toLowerCase(),
      );
      if (added && currentRef.current.applicationIds.length < 16)
        chooseFavorites([
          ...new Set([...currentRef.current.applicationIds, added.id]),
        ]);
      reload();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not register the application.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="sm">
      <Group>
        <Button
          leftSection={<ScanSearchIcon aria-hidden size={16} />}
          loading={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void window.verbo.commands
              .discoverApplications()
              .then((found) => {
                setCandidates(found);
                setDetectionNotice(
                  found.length
                    ? `${found.length} programs detected. Choose the ones to add.`
                    : "No available programs were detected. You can add an application manually below.",
                );
              })
              .catch(() =>
                setError("Available applications could not be detected."),
              )
              .finally(() => setBusy(false));
          }}
        >
          Detect available programs
        </Button>
      </Group>
      {detectionNotice ? (
        <Text size="xs" c="dimmed">
          {detectionNotice}
        </Text>
      ) : null}
      <Text size="xs" c="dimmed">
        Select a program to add and trust it. Check its launch arguments below
        if it needs a special folder option.
      </Text>
      {candidates.map((candidate) => (
        <Checkbox
          key={candidate.executable}
          label={candidate.name}
          description={candidate.executable}
          disabled={busy}
          checked={data.applications.some(
            (app) =>
              app.executable.toLowerCase() ===
              candidate.executable.toLowerCase(),
          )}
          onChange={(event) =>
            void toggle(candidate, event.currentTarget.checked)
          }
        />
      ))}
      <Switch
        label={
          <SettingsLabel
            label="Use selected applications as favorites on project import"
            tip="Apply these favorites only to newly imported projects. Existing project preferences stay as they are."
          />
        }
        checked={importSettings.enabled}
        onChange={(event) => {
          const next = {
            ...currentRef.current,
            enabled: event.currentTarget.checked,
            applicationIds: event.currentTarget.checked
              ? [
                  ...new Set([
                    ...currentRef.current.applicationIds,
                    ...data.applications
                      .filter(
                        (app) =>
                          candidates.some(
                            (candidate) =>
                              candidate.executable.toLowerCase() ===
                              app.executable.toLowerCase(),
                          ) &&
                          app.enabled &&
                          app.supportedTargets.includes("folder"),
                      )
                      .map((app) => app.id),
                  ]),
                ]
              : currentRef.current.applicationIds,
          };
          if (next.applicationIds.length > 16) {
            setError(
              "Choose up to 16 applications as favorites for new projects.",
            );
            return;
          }
          currentRef.current = next;
          setImportSettings(next);
          autosave.controller.schedule(next);
        }}
      />
      <MultiSelect
        label={
          <SettingsLabel
            label="Applications selected for imports"
            tip="Choose up to 16 registered applications as favorites for new projects. Newly selected detected programs are added here automatically."
          />
        }
        data={data.applications
          .filter(
            (app) => app.enabled && app.supportedTargets.includes("folder"),
          )
          .map((app) => ({ value: app.id, label: app.name }))}
        value={importSettings.applicationIds}
        maxValues={16}
        searchable
        onChange={chooseFavorites}
      />
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
        </StatusMessage>
      ) : null}
    </Stack>
  );
}

export function EntityCommandSettings({
  module,
}: {
  module: "projects" | "software";
}): ReactElement {
  const [data, setData] = useState<EntitySettings | null>(null);
  const [error, setError] = useSettingsDraft(`${module}/error`, "");
  const [alias, setAlias] = useSettingsDraft(`${module}/alias`, "");
  const [busy, setBusy] = useSettingsDraft(`${module}/busy`, false);
  const [manualOpen, setManualOpen] = useSettingsDraft(
    "software/manual-open",
    false,
  );
  const load = useCallback((): void => {
    void window.verbo.commands
      .entities()
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch(() => setError("Registrations could not be loaded."));
  }, [setData, setError]);
  const changed = useCallback((): void => {
    window.dispatchEvent(new Event("verbo:entities-changed"));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("verbo:entities-changed", load);
    return () => window.removeEventListener("verbo:entities-changed", load);
  }, [load]);
  return (
    <SettingsSection
      title={module === "software" ? "Applications" : "Projects"}
      description={
        module === "software"
          ? "Choose installed applications and how they open projects."
          : "Register project folders and choose their preferred applications."
      }
    >
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {!data && !error ? (
        <Text size="sm" c="dimmed">
          Loading registrations…
        </Text>
      ) : null}
      {module === "software" ? (
        <>
          {data ? <ApplicationDiscovery data={data} reload={changed} /> : null}
          <SettingsDisclosure
            title="Add an application manually"
            open={manualOpen}
            onOpenChange={setManualOpen}
          >
            <ApplicationEditor reload={changed} />
          </SettingsDisclosure>
          {data?.applications.map((app) => (
            <ApplicationEditor
              key={app.id}
              application={app}
              reload={changed}
            />
          ))}
        </>
      ) : (
        <>
          <Group align="flex-end">
            <TextInput
              label={
                <SettingsLabel
                  label="Project alias"
                  tip="A short lowercase name for the folder. Adding a project does not grant write access."
                />
              }
              value={alias}
              onChange={(event) => setAlias(event.currentTarget.value)}
            />
            <Button
              leftSection={<FolderPlusIcon aria-hidden size={16} />}
              loading={busy}
              onClick={() => {
                const parsed = scopeAliasSchema.safeParse(alias);
                if (!parsed.success) {
                  setError("Use a short lowercase project alias.");
                  return;
                }
                setBusy(true);
                setError("");
                void window.verbo.files
                  .pick()
                  .then(async (pick) => {
                    if (!pick.ok) {
                      if (pick.code !== "cancelled")
                        throw new Error(pick.summary);
                      return;
                    }
                    const result = await window.verbo.projects.add({
                      pickId: pick.pickId,
                      alias: parsed.data,
                    });
                    if (!result.ok) throw new Error(result.summary);
                    setAlias("");
                    changed();
                  })
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not add the project.",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Add project folder
            </Button>
          </Group>
          {data?.projects.length === 0 ? (
            <Text size="sm" c="dimmed">
              No projects registered yet.
            </Text>
          ) : null}
          {data?.projects.map((project) => (
            <ProjectEditor
              key={project.id}
              project={project}
              applications={data.applications}
              reload={changed}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}
