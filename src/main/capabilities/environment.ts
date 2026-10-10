import { arch, platform, release } from "node:os";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import type { Capability } from "./registry";

const platformArgsSchema = z.object({}).strict();

export function platformCapability(): Capability {
  return {
    id: "environment.platform",
    description: "Operating system name, version, and architecture.",
    kind: "read",
    approval: "none",
    args: platformArgsSchema,
    example: {},
    execute(): ActionResult {
      const facts = {
        platform: platform(),
        release: release(),
        arch: arch(),
      };
      return {
        action: "environment.platform",
        status: "success",
        summary: `${facts.platform} ${facts.arch}`,
        detail: JSON.stringify(facts),
      };
    },
  };
}
