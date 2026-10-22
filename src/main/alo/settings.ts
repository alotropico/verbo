import { z } from "zod";
import { commandNodeSchema, type CommandSettings } from "../../shared/commands";
import { aloDataAsync } from "./data-client";

const settingsSchema = z.object({
  metadata: z.array(z.unknown()),
  nodes: z.array(commandNodeSchema),
  defaults: z.array(commandNodeSchema),
  entries: z.array(z.object({ id: z.string() }).passthrough()),
});

/** One complete presentation snapshot, never used as dispatch/admission authority. */
export async function readCommandSettings(): Promise<CommandSettings> {
  return settingsSchema.parse(await aloDataAsync("settings.read")) as CommandSettings;
}
