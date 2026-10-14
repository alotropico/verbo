import type { CommandExecution } from "./commands";

export type CommandMetadata = {
  id: string;
  moduleVersion: number;
  tags: string[];
  parameterHelp: Record<string, string>;
  execution: CommandExecution;
  requirements: string[];
  effect: "read" | "write" | "launch" | "process";
  args: unknown;
  output: unknown;
  messages: { failure: string };
  attachments: "none" | "handler_verified";
  configurable: string[];
};
