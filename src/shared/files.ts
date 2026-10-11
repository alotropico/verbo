import { z } from "zod";

export const scopeAliasSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,31}$/u, "Use a short lowercase alias.");

export const scopeFlagSchema = z
  .object({
    alias: scopeAliasSchema,
    read: z.boolean(),
    write: z.boolean(),
    defaultSave: z.boolean(),
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

export type ScopeCommit = z.infer<typeof scopeCommitSchema>;

export type FileScopeRecord = {
  id: string;
  alias: string;
  path: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  createdAt: number;
  updatedAt: number;
};

export type FileGrantKind = "file" | "directory";

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
