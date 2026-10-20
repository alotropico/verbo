import { z } from "zod";
import type { Capability } from "./registry";
export function platformCapability(): Capability {
  return {
    id: "environment.platform",
    description: "Platform fixture",
    kind: "read",
    args: z.object({}).strict(),
    example: {},
    approval: "none",
    execute: () => ({
      action: "environment.platform",
      status: "success",
      summary: "win32 x64",
      detail: JSON.stringify({
        platform: "win32",
        arch: "x64",
        release: "fixture",
      }),
    }),
  };
}
