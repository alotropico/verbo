import { z } from "zod";
import { scopeAliasSchema } from "./files";
import type { RegisteredRoot } from "./projects";

export const entityAliasesSchema = z
  .array(scopeAliasSchema)
  .min(1)
  .max(12)
  .refine(
    (values) => new Set(values).size === values.length,
    "Aliases must be unique.",
  );
export const applicationRegistrationSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    aliases: entityAliasesSchema,
    executable: z.string().min(1).max(1024),
    enabled: z.boolean(),
    supportedTargets: z
      .array(z.enum(["folder", "file", "repository"]))
      .min(1)
      .max(3),
    launchArguments: z
      .array(
        z.union([
          z
            .object({
              literal: z
                .string()
                .max(1024)
                .refine((value) => !value.includes("\0")),
            })
            .strict(),
          z.object({ target: z.literal("path") }).strict(),
        ]),
      )
      .min(1)
      .max(16)
      .refine(
        (values) => values.some((value) => "target" in value),
        "Include the target path.",
      ),
    cwdPolicy: z.enum(["project", "application", "none"]),
    supportedPlatforms: z.array(z.literal("win32")).length(1),
  })
  .strict();
export type ApplicationRegistrationInput = z.infer<
  typeof applicationRegistrationSchema
>;
export type RegisteredApplication = Omit<ApplicationRegistrationInput, "id"> & {
  id: string;
  trust: "user-registered";
  executableIdentity: string;
  updatedAt: number;
};
export const projectPreferencesSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    aliases: z
      .array(scopeAliasSchema)
      .max(12)
      .refine((values) => new Set(values).size === values.length),
    enabled: z.boolean(),
    defaultApplicationId: z.string().uuid().nullable(),
    favoriteApplicationIds: z
      .array(z.string().uuid())
      .max(16)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type ProjectPreferences = z.infer<typeof projectPreferencesSchema>;
export type RegisteredProject = RegisteredRoot & Omit<ProjectPreferences, "id">;
export type EntitySettings = {
  projects: RegisteredProject[];
  applications: RegisteredApplication[];
  projectImport?: ProjectImportSettings;
};

export const projectImportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    applicationIds: z
      .array(z.string().uuid())
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type ProjectImportSettings = z.infer<typeof projectImportSettingsSchema>;
export type EntitySaveResult =
  { ok: true; summary: string } | { ok: false; summary: string; code: string };

const selector = z.string().trim().min(1).max(1024);
export const projectsResolveArgsSchema = z
  .object({
    project: selector,
    applications: z.array(selector).max(16).default([]),
  })
  .strict();
export const softwareResolveArgsSchema = z
  .object({ applications: z.array(selector).min(1).max(16) })
  .strict();
export const softwareLaunchArgsSchema = z
  .object({ application: selector, project: selector })
  .strict();
export const projectsOpenArgsSchema = projectsResolveArgsSchema;
