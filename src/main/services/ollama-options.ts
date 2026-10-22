import type { ChatSettings } from "../../shared/config";

export type OllamaOptionOverrides = {
  temperature?: number;
  seed?: number;
};

export function ollamaOptions(
  settings: ChatSettings,
  overrides?: OllamaOptionOverrides,
): {
  temperature: number;
  num_ctx: number;
  seed?: number;
} {
  return {
    temperature: overrides?.temperature ?? settings.temperature,
    num_ctx: settings.numCtx,
    ...(overrides?.seed !== undefined ? { seed: overrides.seed } : {}),
  };
}
