import type { ChatSettings } from "../../shared/config";

export function ollamaOptions(settings: ChatSettings): {
  temperature: number;
  num_ctx: number;
} {
  return { temperature: settings.temperature, num_ctx: settings.numCtx };
}
