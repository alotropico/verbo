import { z } from "zod";
import { scopeAliasSchema } from "./files";

export type RegisteredRoot = {
  id: string;
  alias: string;
  path: string;
  createdAt: number;
};

export const projectAddSchema = z
  .object({
    pickId: z.string().uuid(),
    alias: scopeAliasSchema,
  })
  .strict();

export const registeredRootRemoveSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const projectsListArgsSchema = z.object({}).strict();

export const projectsInspectArgsSchema = z
  .object({
    project: z.string().trim().min(1).max(1024),
  })
  .strict();

export const projectsFilesArgsSchema = z
  .object({
    project: z.string().trim().min(1).max(1024),
    path: z.string().trim().min(1).max(1024).optional(),
    depth: z.number().int().min(0).max(8).default(0),
    pageSize: z.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(16).max(80).optional(),
  })
  .strict();
