import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { actionResultSchema } from "../../shared/action-contract";
import {
  OBSIDIAN_DOCUMENTATION_URL,
  obsidianCliSchema,
  obsidianCreateSchema,
  obsidianDeleteSchema,
  obsidianEditSchema,
  obsidianHelpSchema,
  obsidianTargetSchema,
  obsidianTransferSchema,
  type ObsidianOperation,
} from "../../shared/obsidian";
import { createScopeStore } from "../db/scopes";
import { createAssetStore } from "../files/asset-store";
import {
  createObsidianAdapter,
  installedObsidianPaths,
  type ObsidianAdapterOptions,
} from "../obsidian/adapter";
import type {
  CommandDefinition,
  CommandModule,
  TrustedCommandBindings,
} from "./modules";
import { CommandFailure } from "./command-failure";
import {
  obsidianDataDirectory,
  readObsidianQualification,
} from "../obsidian/config";

const metadata = {
  aliases: [],
  tags: ["obsidian", "vault", "note"],
  parameterHelp: {
    vault:
      "Configured Obsidian vault scope ID or alias; never an active-note or default-vault guess.",
    path: "Exact relative note path including its extension, for example Inbox/Idea.md.",
  },
  output: actionResultSchema,
  messages: { failure: "Obsidian operation failed" },
  attachments: "handler_verified" as const,
  configurable: ["aliases"] as const,
  requirements: [
    `Fixture-qualified CLI and explicit configured vault. ${OBSIDIAN_DOCUMENTATION_URL}`,
  ],
};
const commands: CommandDefinition[] = [
  {
    ...metadata,
    id: "obsidian.help",
    aliases: ["manual", "docs"],
    description: `Upstream CLI help for a selected vault. ${OBSIDIAN_DOCUMENTATION_URL}`,
    kind: "read",
    approval: "none",
    args: obsidianHelpSchema,
    parameterHelp: {
      vault: metadata.parameterHelp.vault,
      command: "Optional upstream command name to explain, for example create.",
    },
    example: { vault: "garden", command: "create" },
    execution: { type: "handler", handler: "obsidian.help" },
    effect: "read",
  },
  {
    ...metadata,
    id: "obsidian.read",
    aliases: ["cat", "show"],
    description:
      "Read an exact relative note path with content reference, revision and receipt; no active-note default.",
    kind: "read",
    approval: "none",
    args: obsidianTargetSchema,
    example: { vault: "garden", path: "Inbox/Idea.md" },
    execution: { type: "handler", handler: "obsidian.read" },
    effect: "read",
  },
  {
    ...metadata,
    id: "obsidian.create",
    aliases: ["create-note", "write"],
    description:
      "Create a new note at an exact unused path through the qualified CLI. Supply content or a retained contentRef. Requires approval and exact content read-back; existing notes and literal backslash-n/backslash-t sequences are rejected.",
    kind: "mutation",
    approval: "required",
    args: obsidianCreateSchema,
    parameterHelp: {
      ...metadata.parameterHelp,
      content:
        "The new UTF-8 note body; supply this or contentRef, never both.",
      contentRef:
        "Retained note-body attachment UUID in this chat, supplied by Writer or a prior read.",
    },
    example: {
      vault: "garden",
      path: "Inbox/Idea.md",
      content: "# Idea\nText",
    },
    execution: { type: "process", process: "obsidian.create" },
    preparation: "obsidian.create.prepare",
    effect: "process",
  },
  {
    ...metadata,
    id: "obsidian.edit",
    aliases: ["edit-note", "update"],
    description:
      "Full-body edit contract, currently not_supported: the qualified CLI lacks expected-revision compare-and-swap. No native fallback. Do not promise an edit or substitute create/overwrite.",
    kind: "mutation",
    approval: "required",
    args: obsidianEditSchema,
    parameterHelp: {
      ...metadata.parameterHelp,
      content: "Replacement body; supply this or contentRef, never both.",
      contentRef: "Retained replacement-body attachment UUID in this chat.",
      revision:
        "Original SHA-256 revision from obsidian.read; preserve it unchanged.",
    },
    example: {
      vault: "garden",
      path: "Inbox/Idea.md",
      content: "Revised",
      revision: "0".repeat(64),
    },
    execution: { type: "process", process: "obsidian.edit" },
    preparation: "obsidian.edit.prepare",
    effect: "process",
  },
  {
    ...metadata,
    id: "obsidian.move",
    aliases: ["move-note", "relocate"],
    description:
      "Move an existing note to an exact unused relative path in the same vault through the qualified CLI, preserving content and allowing Obsidian link updates. Requires approval; verifies source and destination afterward.",
    kind: "mutation",
    approval: "required",
    args: obsidianTransferSchema,
    parameterHelp: {
      ...metadata.parameterHelp,
      to: "Exact destination note path within this same vault, including filename and extension.",
      revision:
        "Optional SHA-256 from a prior read to reject a changed source.",
    },
    example: { vault: "garden", path: "Inbox/Idea.md", to: "Archive/Idea.md" },
    execution: { type: "process", process: "obsidian.move" },
    preparation: "obsidian.move.prepare",
    effect: "process",
  },
  {
    ...metadata,
    id: "obsidian.rename",
    aliases: ["rename-note", "retitle"],
    description:
      "Rename an existing note within its current directory through the qualified CLI, preserving content and allowing Obsidian link updates. Requires approval; use move to change directories.",
    kind: "mutation",
    approval: "required",
    args: obsidianTransferSchema,
    parameterHelp: {
      ...metadata.parameterHelp,
      to: "Exact new note path in the source directory, including extension; not just a basename.",
      revision:
        "Optional SHA-256 from a prior read to reject a changed source.",
    },
    example: {
      vault: "garden",
      path: "Inbox/Idea.md",
      to: "Inbox/New name.md",
    },
    execution: { type: "process", process: "obsidian.rename" },
    preparation: "obsidian.rename.prepare",
    effect: "process",
  },
  {
    ...metadata,
    id: "obsidian.delete",
    aliases: ["delete-note", "remove"],
    description:
      "Delete contract, currently not_supported: vault-local trash does not provide the required system Recycle Bin semantics. No native fallback. Do not claim deletion or substitute CLI passthrough.",
    kind: "mutation",
    approval: "required",
    args: obsidianDeleteSchema,
    example: { vault: "garden", path: "Inbox/Idea.md" },
    execution: { type: "process", process: "obsidian.delete" },
    preparation: "obsidian.delete.prepare",
    effect: "process",
  },
  {
    ...metadata,
    id: "obsidian.cli",
    aliases: ["cli-note", "command"],
    description:
      "Module-wide upstream/plugin CLI passthrough with structured argv and explicit vault. Known reads stay lightweight; unknown effects require precise review and may extend outside the vault. No shell or JavaScript evaluation. Not a substitute for unsupported edit/delete contracts.",
    kind: "mutation",
    approval: "required",
    args: obsidianCliSchema,
    parameterHelp: {
      vault: metadata.parameterHelp.vault,
      command:
        "One upstream CLI command name; no shell syntax, eval or targeting override.",
      args: 'Array of literal CLI arguments, for example ["path=Inbox/Idea.md"]; vault/profile targeting is supplied by the wrapper.',
    },
    example: { vault: "garden", command: "help", args: [] },
    execution: { type: "process", process: "obsidian.cli" },
    preparation: "obsidian.cli.prepare",
    effect: "process",
  },
];
export const obsidianModule: CommandModule = {
  id: "obsidian",
  version: 1,
  aliases: ["vault", "notes"],
  description:
    "Qualified Obsidian CLI note operations and scoped upstream help/passthrough",
  scopes: [],
  commands,
};

export function obsidianBindings(
  resolveDatabase?: () => DatabaseSync,
  override?: () => ObsidianAdapterOptions,
): TrustedCommandBindings {
  const handlers: TrustedCommandBindings["handlers"] = {};
  const processes: TrustedCommandBindings["processes"] = {};
  const preparers: NonNullable<TrustedCommandBindings["preparers"]> = {};
  const adapter = (): ReturnType<typeof createObsidianAdapter> => {
    if (override) return createObsidianAdapter(override());
    if (!resolveDatabase)
      throw new CommandFailure(
        "obsidian_unqualified",
        "Obsidian storage and qualification are unavailable.",
      );
    const database = resolveDatabase();
    const scopes = createScopeStore(database);
    const userData = obsidianDataDirectory();
    const assets = createAssetStore(database, join(userData, "attachments"));
    return createObsidianAdapter({
      ...installedObsidianPaths(),
      profileDirectory: join(process.env.APPDATA ?? "", "obsidian"),
      scopes: scopes.list,
      generation: scopes.generation,
      qualification: readObsidianQualification,
      content: {
        put: (threadId, text) => {
          const stored = assets.put({
            threadId,
            name: "obsidian-note.md",
            mediaType: "text/markdown",
            bytes: Buffer.from(text, "utf8"),
          });
          if (!stored.ok) throw new CommandFailure(stored.code, stored.summary);
          return stored.attachment.id;
        },
        get: assets.text,
      },
    });
  };
  for (const operation of ["help", "read"] as const)
    handlers[`obsidian.${operation}`] = (args, context) =>
      adapter().execute(operation, args, context);
  for (const operation of [
    "create",
    "edit",
    "move",
    "rename",
    "delete",
    "cli",
  ] as (ObsidianOperation | "cli")[]) {
    processes[`obsidian.${operation}`] = (args, context) =>
      adapter().execute(operation, args, context);
    preparers[`obsidian.${operation}.prepare`] = (args, context) =>
      adapter().prepare(operation, args, context);
  }
  return { handlers, processes, preparers, aggregators: {} };
}
