import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type VoiceSupervisor = {
  ensure: () => Promise<{ detail: string }>;
  stopOwned: () => void;
};

type VoiceSupervisorModule = {
  createVoiceSupervisor: (options?: {
    serviceRoot?: string;
    log?: (line: string) => void;
  }) => VoiceSupervisor;
};

function repoRoot(appPath: string): string {
  if (existsSync(join(appPath, "scripts", "voice-supervisor.mjs")))
    return appPath;
  const parent = join(appPath, "..", "..");
  if (existsSync(join(parent, "scripts", "voice-supervisor.mjs")))
    return parent;
  return appPath;
}

export async function attachVoiceService(
  appPath: string,
  assignStop: (stop: () => void) => void,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const root = repoRoot(appPath);
  try {
    const href = pathToFileURL(
      join(root, "scripts", "voice-supervisor.mjs"),
    ).href;
    const loaded = (await import(
      /* @vite-ignore */ href
    )) as VoiceSupervisorModule;
    const voice = loaded.createVoiceSupervisor({
      serviceRoot: join(root, "voice-service"),
      log,
    });
    assignStop(() => {
      voice.stopOwned();
    });
    const state = await voice.ensure();
    log(state.detail);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Voice service could not be loaded.";
    log(`${message} Typed chat still works.`);
  }
}
