export const PERMANENT_MODEL_TOOLS = [
  "capabilities.list",
  "capabilities.search",
  "capabilities.describe",
  "actions.invoke",
] as const;

export type PermanentModelTool = (typeof PERMANENT_MODEL_TOOLS)[number];
