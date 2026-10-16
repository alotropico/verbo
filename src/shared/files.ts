import { z } from "zod";

export const folderKinds = ["none", "projects", "obsidian"] as const;
export const folderKindSchema = z.enum(folderKinds);
export type FolderKind = z.infer<typeof folderKindSchema>;

export const scopeAliasSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,31}$/u, "Use a short lowercase alias.");

export function splitScopeAliases(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

export const scopeAliasListSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .superRefine((value, context) => {
    const parts = splitScopeAliases(value);
    if (parts.length < 1 || parts.length > 8) {
      context.addIssue({
        code: "custom",
        message: "Use one to eight aliases, separated by commas.",
      });
      return;
    }
    if (new Set(parts).size !== parts.length) {
      context.addIssue({
        code: "custom",
        message: "That alias is repeated on this folder.",
      });
      return;
    }
    if (parts.some((part) => !scopeAliasSchema.safeParse(part).success)) {
      context.addIssue({
        code: "custom",
        message: "Use short lowercase aliases, separated by commas.",
      });
    }
  })
  .transform((value) => splitScopeAliases(value).join(", "));

export const scopeFlagSchema = z
  .object({
    alias: scopeAliasListSchema,
    read: z.boolean(),
    write: z.boolean(),
    defaultSave: z.boolean(),
    kind: folderKindSchema.optional(),
    routingDescription: z.string().trim().max(1000).optional(),
  })
  .strict();

export const scopeCommitSchema = z
  .object({
    removeIds: z.array(z.string().trim().min(1).max(128)).max(50),
    updates: z
      .array(
        scopeFlagSchema
          .extend({
            id: z.string().trim().min(1).max(128),
          })
          .strict(),
      )
      .max(50),
    picks: z
      .array(
        scopeFlagSchema
          .extend({
            pickId: z.string().uuid(),
          })
          .strict(),
      )
      .max(20),
    acceptDefault: z.boolean(),
  })
  .strict();

export const scopePatchSchema = scopeFlagSchema
  .partial()
  .extend({ id: z.string().min(1).max(128) })
  .strict();
export type ScopePatch = z.infer<typeof scopePatchSchema>;

export type ScopeCommit = z.infer<typeof scopeCommitSchema>;

export type FileScopeRecord = {
  routingDescription?: string;
  id: string;
  alias: string;
  aliases: string[];
  path: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  kind?: FolderKind;
  createdAt: number;
  updatedAt: number;
};

export type FileGrantKind = "file" | "directory";

export type ScopeMutationResult =
  | { ok: true; summary: string; scopes: FileScopeRecord[] }
  | { ok: false; code: string; summary: string };

export type FileGrantRecord = {
  id: string;
  kind: FileGrantKind;
  path: string;
  threadId?: string;
  createdAt: number;
  expiresAt: number;
};

export type FileScopeProposal = {
  alias: "tmp";
  path: string;
  saved: boolean;
};

export function displayFinalPath(path: string): string {
  return path.replace(/^\\\\\?\\/u, "");
}
