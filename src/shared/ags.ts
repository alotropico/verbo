import { z } from "zod";
import { scopeAliasSchema } from "./files";

/** The only arguments `ags.check` may pass. Callers cannot replace them. */
export const AGS_CHECK_ARGS = ["check"] as const;

export const AGS_EXECUTABLE_NAMES = new Set(["ags", "ags.exe", "ags.cmd"]);

export const agsHostAddSchema = z
  .object({
    pickId: z.string().uuid(),
    alias: scopeAliasSchema,
  })
  .strict();

export const agsHostArgsSchema = z
  .object({
    host: z.string().trim().min(1).max(1024),
  })
  .strict();

export const agsHostsArgsSchema = z.object({}).strict();

export function agsExecutableAllowed(filePath: string): boolean {
  const base = filePath.split(/[/\\]/u).pop()?.toLowerCase() ?? "";
  return AGS_EXECUTABLE_NAMES.has(base);
}
