import { platformCapability } from "./environment";
import { createRegistry, type CapabilityRegistry } from "./registry";

/** Production catalog. Tests add fixture actions on their own registry. */
export function createProductionRegistry(): CapabilityRegistry {
  return createRegistry([platformCapability()]);
}
