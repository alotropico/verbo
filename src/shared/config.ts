export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export const DEFAULT_MODEL = "qwen3.5:4b-q4_K_M";
export const ALTERNATE_MODEL = "qwen3.5-4b-32k:latest";

export type ChatSettings = {
  model: string;
  think: boolean;
  temperature: number;
  numCtx: number;
  keepAlive: string;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  model: DEFAULT_MODEL,
  think: true,
  temperature: 0.4,
  numCtx: 8192,
  keepAlive: "5m",
};
