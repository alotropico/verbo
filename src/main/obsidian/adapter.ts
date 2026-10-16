import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import type { ActionResult } from "../../shared/action-contract";
import {
  OBSIDIAN_ADAPTER_VERSION,
  OBSIDIAN_DOCUMENTATION_URL,
  obsidianQualificationSchema,
  type ObsidianOperation,
  type ObsidianQualification,
} from "../../shared/obsidian";
import type { FileScopeRecord } from "../../shared/files";
import type { ActionContext } from "../capabilities/registry";
import {
  runBoundedProcess,
  type ProcessOutcome,
} from "../capabilities/process";
import { CommandFailure } from "../capabilities/command-failure";
import type { EffectPreparation } from "../capabilities/preparation";
import { activeInvocation } from "../agents/policy";
import {
  canonicalTarget,
  classifyVaultTarget,
} from "../files/vault-target-policy";
import { recordFileResource } from "../files/resource-events";
import {
  snapshotVaultNotes,
  recordVaultNoteChanges,
} from "./resource-snapshot";

const identities = new Map<string, { signature: string; value: string }>();
export function executableIdentity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The Obsidian launcher is not a regular executable.");
  const signature = `${realpathSync(path)}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = identities.get(path);
  if (cached?.signature === signature) return cached.value;
  const value = `${signature}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  identities.set(path, { signature, value });
  return value;
}
export function applicationIdentity(path: string): string {
  return createHash("sha256")
    .update(
      [
        path,
        join(dirname(path), "resources", "app.asar"),
        join(dirname(path), "resources", "obsidian.asar"),
      ]
        .map(executableIdentity)
        .join("\n"),
    )
    .digest("hex");
}
export function installedObsidianPaths(): {
  executable: string;
  application: string;
} {
  const root = join(process.env.LOCALAPPDATA ?? "", "Programs", "obsidian");
  return {
    executable: join(root, "Obsidian.exe"),
    application: join(root, "Obsidian.exe"),
  };
}
type Target = {
  scope: FileScopeRecord;
  vaultId: string;
  path?: string;
  absolute?: string;
  revision?: string;
};
export type ObsidianAdapterOptions = {
  scopes: () => FileScopeRecord[];
  generation: () => number;
  executable: string;
  application: string;
  profileDirectory: string;
  qualification: () => ObsidianQualification | undefined;
  content: {
    put: (threadId: string, text: string) => string;
    get: (threadId: string, id: string) => string | null;
  };
  runner?: typeof runBoundedProcess;
};
const unsafeCommands =
  /^(?:eval|js|javascript|shell|powershell|devtools|dev(?::|$)|__|restart|reload)/iu;
const readonlyCommands = new Set([
  "help",
  "version",
  "read",
  "files",
  "folders",
  "search",
  "properties",
  "tags",
  "commands",
]);
function relativePath(scope: FileScopeRecord, path: string): string {
  const root = canonicalTarget(scope.path);
  const candidate = canonicalTarget(win32.join(root, path));
  const rel = win32.relative(root, candidate);
  if (!rel || rel.startsWith("..") || win32.isAbsolute(rel))
    throw new CommandFailure(
      "outside_vault",
      "Choose an exact note inside the selected vault.",
    );
  return rel.replace(/\\/gu, "/");
}
function hashFile(path: string): string | undefined {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_000_000)
    throw new CommandFailure(
      "unsupported_note",
      "The note must be a regular bounded UTF-8 file.",
    );
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function unsupported(action: string, reason: string): ActionResult {
  return {
    action,
    status: "not_supported",
    code: "obsidian_unqualified",
    summary: reason.slice(0, 4000),
    detail: OBSIDIAN_DOCUMENTATION_URL,
  };
}
export function normalizeObsidianStdout(output: string): string {
  return output.startsWith("\r\n") ? output.slice(2) : output;
}

export function createObsidianAdapter(options: ObsidianAdapterOptions): {
  prepare: (
    operation: ObsidianOperation | "cli",
    args: Record<string, unknown>,
    context: ActionContext,
  ) => EffectPreparation;
  execute: (
    operation: ObsidianOperation | "cli" | "help",
    args: Record<string, unknown>,
    context: ActionContext,
  ) => Promise<ActionResult>;
  target: (args: Record<string, unknown>, write: boolean) => Target;
} {
  const runner = options.runner ?? runBoundedProcess;
  function target(args: Record<string, unknown>, write: boolean): Target {
    const hint = String(args.vault);
    const matches = options
      .scopes()
      .filter(
        (scope) =>
          scope.kind === "obsidian" &&
          (scope.id === hint || scope.aliases.includes(hint.toLowerCase())),
      );
    if (matches.length !== 1)
      throw new CommandFailure(
        "vault_not_found",
        "Name one configured vault explicitly; no active/default vault is substituted.",
      );
    const scope = matches[0]!;
    if (!scope.read || (write && !scope.write))
      throw new CommandFailure(
        "vault_permission_denied",
        "The selected vault does not permit this operation.",
      );
    const root = canonicalTarget(scope.path);
    if (
      !existsSync(join(root, ".obsidian")) ||
      lstatSync(join(root, ".obsidian")).isSymbolicLink()
    )
      throw new CommandFailure(
        "vault_unavailable",
        "The configured vault marker is unavailable.",
      );
    let registry: { vaults?: Record<string, { path?: string }>; cli?: boolean };
    try {
      registry = JSON.parse(
        readFileSync(join(options.profileDirectory, "obsidian.json"), "utf8"),
      );
    } catch {
      throw new CommandFailure(
        "vault_mapping_unavailable",
        "Obsidian's configured vault registry is unavailable.",
      );
    }
    if (!registry.cli)
      throw new CommandFailure(
        "cli_disabled",
        "Enable Obsidian's command line interface in its settings before qualification.",
      );
    const mappings = Object.entries(registry.vaults ?? {}).filter(
      ([, entry]) => {
        try {
          return (
            entry.path &&
            canonicalTarget(entry.path).toLowerCase() === root.toLowerCase()
          );
        } catch {
          return false;
        }
      },
    );
    if (mappings.length !== 1)
      throw new CommandFailure(
        "vault_mapping_ambiguous",
        "The scope does not map uniquely to a registered Obsidian vault.",
      );
    if (typeof args.path !== "string")
      return { scope, vaultId: mappings[0]![0] };
    const path = relativePath(scope, args.path);
    const absolute = win32.join(root, path);
    const intersections = classifyVaultTarget({
      path: absolute,
      scopes: options.scopes(),
    });
    if (
      intersections.some(
        (hit) =>
          hit.scope.id !== scope.id ||
          !hit.scope.read ||
          (write && !hit.scope.write),
      )
    )
      throw new CommandFailure(
        "vault_intersection",
        "The exact note intersects a different or restricted nested vault.",
      );
    return {
      scope,
      vaultId: mappings[0]![0],
      path,
      absolute,
      revision: hashFile(absolute),
    };
  }
  function qualification(
    operation?: ObsidianOperation,
  ): ObsidianQualification | undefined {
    const value = options.qualification();
    const parsed = obsidianQualificationSchema.safeParse(value);
    if (
      !parsed.success ||
      !parsed.data.enabled ||
      parsed.data.adapterVersion !== OBSIDIAN_ADAPTER_VERSION
    )
      return;
    if (
      parsed.data.executableIdentity !==
        executableIdentity(options.executable) ||
      parsed.data.applicationIdentity !==
        applicationIdentity(options.application)
    )
      return;
    if (operation && !parsed.data.operations[operation]?.supported) return;
    return parsed.data;
  }
  function cliArgs(vaultId: string, command: string, argv: string[]): string[] {
    if (
      unsafeCommands.test(command) ||
      argv.some(
        (arg) =>
          /^(?:vault|session)=/iu.test(arg) ||
          /^--(?:user-data-dir|remote-debugging|inspect|eval)/iu.test(arg) ||
          arg.includes("\0"),
      )
    )
      throw new CommandFailure(
        "host_ineligible",
        "This invocation would change trusted targeting or request prohibited evaluation/developer execution.",
      );
    return [
      `--user-data-dir=${options.profileDirectory}`,
      `vault=${vaultId}`,
      command,
      ...argv,
    ];
  }
  function materialize(
    operation: ObsidianOperation | "cli" | "help",
    args: Record<string, unknown>,
    context: ActionContext,
  ): {
    selected: Target;
    command: string;
    exactArgs: string[];
    qualified: ObsidianQualification;
    knownRead: boolean;
  } {
    const command =
      operation === "cli"
        ? String(args.command)
        : operation === "help"
          ? "help"
          : operation === "create"
            ? "create"
            : operation === "edit"
              ? "create"
              : operation === "delete"
                ? "delete"
                : operation;
    if (unsafeCommands.test(command))
      throw new CommandFailure(
        "host_ineligible",
        "Shell and JavaScript evaluation/developer execution are prohibited.",
      );
    const knownRead =
      operation === "read" ||
      operation === "help" ||
      (operation === "cli" && readonlyCommands.has(command));
    const qualified = qualification(
      operation === "cli" || operation === "help" ? undefined : operation,
    );
    if (!qualified) {
      const evidence = options.qualification();
      const limitation =
        operation !== "cli" && operation !== "help"
          ? evidence?.operations[operation]?.reason
          : undefined;
      throw new CommandFailure(
        "obsidian_unqualified",
        `Obsidian ${operation} is disabled until this executable/version and its semantics are fixture-qualified and activated.${limitation ? ` ${limitation}` : ""} No native vault mutation fallback is available.`.slice(
          0,
          2000,
        ),
      );
    }
    const selected = target(args, !knownRead);
    if (operation === "cli") {
      const policy = activeInvocation();
      if (policy && !policy.allowed.modules.includes("obsidian"))
        throw new CommandFailure(
          "module_authority_required",
          "Upstream CLI passthrough requires module-wide Obsidian authority, not an action-specific grant.",
        );
      if (!qualified.passthrough)
        throw new CommandFailure(
          "obsidian_unqualified",
          "CLI passthrough has not been qualified/activated.",
        );
    }
    let argv: string[] = [];
    if (operation === "cli") argv = args.args as string[];
    else if (operation === "help")
      argv = typeof args.command === "string" ? [args.command] : [];
    else {
      if (!selected.path || !selected.absolute)
        throw new CommandFailure(
          "missing_path",
          "An exact note path is required.",
        );
      argv = [`path=${selected.path}`];
      if (operation === "create" || operation === "edit") {
        const body =
          typeof args.content === "string"
            ? args.content
            : typeof args.contentRef === "string"
              ? options.content.get(context.threadId, args.contentRef)
              : null;
        if (body === null)
          throw new CommandFailure(
            "content_unavailable",
            "The retained note body is missing. Supply its content explicitly.",
          );
        if (body.length > 24000)
          throw new CommandFailure(
            "content_too_large",
            "The qualified CLI argument limit cannot hold this body.",
          );
        if (/\\[nt]/u.test(body))
          throw new CommandFailure(
            "not_supported",
            "The CLI converts literal backslash-n/backslash-t sequences and cannot preserve this body faithfully. Revise those sequences explicitly; no native write fallback is used.",
          );
        if (operation === "create" && selected.revision)
          throw new CommandFailure(
            "collision",
            "That exact note already exists.",
          );
        if (operation === "edit" && selected.revision !== args.revision)
          throw new CommandFailure(
            "revision_conflict",
            "The note changed. Read it again before editing.",
          );
        argv.push(
          `content=${body.replace(/\n/gu, "\\n").replace(/\t/gu, "\\t")}`,
        );
        if (operation === "edit") argv.push("overwrite");
      }
      if (operation === "move" || operation === "rename") {
        const to = relativePath(selected.scope, String(args.to));
        if (
          operation === "rename" &&
          win32.dirname(to) !== win32.dirname(selected.path)
        )
          throw new CommandFailure(
            "rename_directory",
            "Rename preserves the note's directory; use move to change directories.",
          );
        const destination = target(
          { vault: selected.scope.id, path: to },
          true,
        );
        if (destination.revision)
          throw new CommandFailure(
            "collision",
            "The destination note already exists.",
          );
        argv.push(
          `${operation === "rename" ? "name" : "to"}=${operation === "rename" ? basename(to) : to}`,
        );
      }
      if (operation !== "create" && !selected.revision)
        throw new CommandFailure(
          "missing_note",
          "The exact note was not found.",
        );
      if (
        typeof args.revision === "string" &&
        selected.revision !== args.revision
      )
        throw new CommandFailure(
          "revision_conflict",
          "The original note revision no longer matches.",
        );
    }
    const exactArgs = cliArgs(selected.vaultId, command, argv);
    if (knownRead)
      for (const arg of argv)
        if (arg.startsWith("path=")) relativePath(selected.scope, arg.slice(5));
    return { selected, command, exactArgs, qualified, knownRead };
  }
  function prepare(
    operation: ObsidianOperation | "cli",
    args: Record<string, unknown>,
    context: ActionContext,
  ): EffectPreparation {
    const prepared = materialize(operation, args, context);
    return {
      snapshot: {
        backend: "obsidian-cli",
        adapterVersion: OBSIDIAN_ADAPTER_VERSION,
        executable: options.executable,
        executableIdentity: executableIdentity(options.executable),
        applicationIdentity: applicationIdentity(options.application),
        appVersion: prepared.qualified.appVersion,
        scopeId: prepared.selected.scope.id,
        scopeGeneration: options.generation(),
        vaultId: prepared.selected.vaultId,
        path: prepared.selected.path ?? null,
        revision: prepared.selected.revision ?? null,
        argv: prepared.exactArgs,
        destinationRevision:
          typeof args.to === "string"
            ? (hashFile(
                win32.join(prepared.selected.scope.path, String(args.to)),
              ) ?? null)
            : null,
      },
      summary:
        `${operation} in ${prepared.selected.scope.alias}: ${prepared.command}`.slice(
          0,
          500,
        ),
      automatic: prepared.knownRead,
      ...(prepared.knownRead ? { readOnly: true as const } : {}),
      risks: prepared.knownRead
        ? []
        : operation === "cli"
          ? [
              "Upstream/plugin effects may be unknown and may affect files outside the selected vault. Confirmation does not provide sandbox confinement.",
            ]
          : [
              "Obsidian may update inbound links and related notes according to vault settings. Complete atomic undo is not guaranteed.",
            ],
      details: JSON.stringify({
        executable: options.executable,
        argv: prepared.exactArgs,
        selectedVault: prepared.selected.vaultId,
        backend: "obsidian-cli",
      }),
    };
  }
  async function execute(
    operation: ObsidianOperation | "cli" | "help",
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ActionResult> {
    const action = `obsidian.${operation}`;
    let prepared: ReturnType<typeof materialize>;
    try {
      prepared = materialize(operation, args, context);
    } catch (error) {
      if (error instanceof CommandFailure)
        return error.code === "obsidian_unqualified" ||
          error.code === "not_supported"
          ? unsupported(action, error.message)
          : {
              action,
              status: "error",
              code: error.code,
              summary: error.message,
            };
      return unsupported(
        action,
        "The installed CLI, vault identity or qualification could not be revalidated.",
      );
    }
    const before = prepared.selected.revision;
    const beforeNotes = !prepared.knownRead
      ? snapshotVaultNotes(prepared.selected.scope, options.scopes())
      : undefined;
    const result: ProcessOutcome = await runner({
      executable: options.executable,
      args: prepared.exactArgs,
      cwd: prepared.selected.scope.path,
      timeoutMs: 15_000,
      signal: context.signal,
    });
    result.stdout = normalizeObsidianStdout(result.stdout);
    const relatedResources = beforeNotes
      ? recordVaultNoteChanges(
          beforeNotes,
          snapshotVaultNotes(prepared.selected.scope, options.scopes()),
          prepared.selected.absolute,
        )
      : undefined;
    if (result.timedOut || result.cancelled)
      return {
        action,
        status: result.cancelled ? "cancelled" : "error",
        code: prepared.knownRead ? "cli_timeout" : "effect_uncertain",
        summary: prepared.knownRead
          ? "The CLI read did not complete."
          : "The CLI client was interrupted after dispatch; effects are uncertain. Reconcile the note before any retry.",
        ...(relatedResources ? { data: { relatedResources } } : {}),
      };
    if (
      !result.spawned ||
      result.code !== 0 ||
      /^(?:Error:|Vault not found|Command line interface is not enabled)/mu.test(
        result.stdout,
      )
    )
      return {
        action,
        status: "error",
        code: "cli_failed",
        summary: (
          result.stderr ||
          result.stdout ||
          "The CLI could not complete."
        ).slice(0, 2000),
      };
    if (operation === "read") {
      const absolute = prepared.selected.absolute!;
      if (hashFile(absolute) !== before)
        return {
          action,
          status: "error",
          code: "revision_conflict",
          summary: "The note changed during the CLI read.",
        };
      const content = readFileSync(absolute, "utf8");
      if (
        result.stdout !== content &&
        result.stdout.replace(/\r?\n$/u, "") !== content
      )
        return {
          action,
          status: "error",
          code: "read_unverified",
          summary: "The CLI output does not match the exact selected note.",
        };
      const contentRef = options.content.put(context.threadId, content);
      recordFileResource(absolute, "read");
      return {
        action,
        status: "success",
        summary: `Read ${prepared.selected.path}.`,
        data: {
          scopeId: prepared.selected.scope.id,
          path: prepared.selected.path!,
          revision: before!,
          contentRef,
          backend: "obsidian-cli",
        },
      };
    }
    if (operation === "help" || (operation === "cli" && prepared.knownRead))
      return {
        action,
        status: "success",
        summary: result.stdout.slice(0, 4000) || "The CLI read completed.",
        detail: OBSIDIAN_DOCUMENTATION_URL,
      };
    // Semantic postconditions, never exit code alone.
    const absolute = prepared.selected.absolute;
    const destination =
      typeof args.to === "string"
        ? win32.join(prepared.selected.scope.path, String(args.to))
        : absolute;
    const body =
      typeof args.content === "string"
        ? args.content
        : typeof args.contentRef === "string"
          ? options.content.get(context.threadId, args.contentRef)
          : null;
    const verified =
      operation === "create" || operation === "edit"
        ? !!absolute &&
          existsSync(absolute) &&
          readFileSync(absolute, "utf8") === body
        : operation === "move" || operation === "rename"
          ? !!absolute &&
            !existsSync(absolute) &&
            !!destination &&
            hashFile(destination) === before
          : false;
    if (!verified)
      return {
        action,
        status: operation === "cli" ? "partial" : "error",
        code: "effect_uncertain",
        summary:
          "The CLI returned, but complete effects are not verified. Do not repeat this mutation automatically.",
        data: {
          backend: "obsidian-cli",
          relatedResources: relatedResources!,
          observedStdout: result.stdout.slice(0, 2000),
        },
      };
    if (destination)
      recordFileResource(
        destination,
        operation === "move" || operation === "rename" ? "move" : "write",
        operation === "move" || operation === "rename" ? absolute : undefined,
      );
    return {
      action,
      status: "success",
      summary: `${operation} verified for ${prepared.selected.path}.`,
      data: {
        backend: "obsidian-cli",
        relatedResources: relatedResources!,
        scopeId: prepared.selected.scope.id,
        path: typeof args.to === "string" ? args.to : prepared.selected.path!,
        revision: destination ? (hashFile(destination) ?? null) : null,
      },
    };
  }
  return { prepare, execute, target };
}
