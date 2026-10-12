import { z } from "zod";

export type InstalledProgram = {
  name: string;
  version: string;
  publisher: string;
  location: string;
};

export type SoftwareHit = {
  source: "registry" | "path" | "known";
  name: string;
  version: string;
  path: string;
};

export const SOFTWARE_PAGE_LIMIT = 20;

export const softwareListArgsSchema = z
  .object({
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(SOFTWARE_PAGE_LIMIT)
      .default(SOFTWARE_PAGE_LIMIT),
    cursor: z.string().trim().min(8).max(120).optional(),
  })
  .strict();

export const softwareFindArgsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** A program name only. Path separators and shell metacharacters never pass. */
export function safeProgramToken(name: string): string | null {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/u.test(trimmed)) return null;
  if (DEVICE_NAME.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(".exe")) {
    const stem = trimmed.slice(0, -4).trim();
    if (!stem || DEVICE_NAME.test(stem)) return null;
    return stem;
  }
  return trimmed;
}
