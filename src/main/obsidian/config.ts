import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  obsidianQualificationSchema,
  type ObsidianOperation,
} from "../../shared/obsidian";

let dataDirectory = join(process.env.APPDATA ?? "", "verbo");
export function configureObsidianDataDirectory(directory: string): void {
  dataDirectory = directory;
}
export function obsidianDataDirectory(): string {
  return dataDirectory;
}
export function readObsidianQualification():
  import("../../shared/obsidian").ObsidianQualification | undefined {
  try {
    return obsidianQualificationSchema.parse(
      JSON.parse(
        readFileSync(
          join(dataDirectory, "obsidian-qualification.json"),
          "utf8",
        ),
      ),
    );
  } catch {
    return;
  }
}
export function obsidianTranslationAvailable(
  operation: ObsidianOperation,
): boolean {
  const qualification = readObsidianQualification();
  return (
    !!qualification?.enabled && !!qualification.operations[operation]?.supported
  );
}
