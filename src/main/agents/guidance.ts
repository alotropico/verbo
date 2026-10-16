import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentId } from "../../shared/workflows";
import { agentIdSchema } from "../../shared/workflows";
import type { FileScopeRecord } from "../../shared/files";
import { resolveFileReference } from "../files/path-policy";
import { readBoundedGuidance, type ContextSource } from "./cts";

const assignmentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u),
    reference: z.string().max(1000),
    scopeId: z.string().min(1).max(128),
    audiences: z.array(agentIdSchema).min(1).max(4),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type GuidanceAssignment = z.infer<typeof assignmentSchema>;
const assignmentsSchema = z.array(assignmentSchema).max(20);

export function guidanceConfigurationVersion(
  assignments: GuidanceAssignment[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...assignments]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((assignment) => ({
            ...assignment,
            audiences: [...assignment.audiences].sort(),
          })),
      ),
    )
    .digest("hex");
}

/** Explicit approved file assignments only. Installed AGS skills are never auto-loaded. */
export function readGuidanceAssignments(path: string): GuidanceAssignment[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
    throw new Error(
      "Guidance assignments are unavailable or exceed their bound.",
    );
  return assignmentsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function resolveAssignedGuidance(input: {
  assignments: GuidanceAssignment[];
  agentId: AgentId;
  scopes: FileScopeRecord[];
  selectedScopeId?: string | null;
}): { sources: ContextSource[]; versions: Record<string, string> } {
  const sources: ContextSource[] = [];
  const versions: Record<string, string> = {};
  for (const assignment of input.assignments) {
    if (
      !assignment.audiences.includes(input.agentId) ||
      (input.selectedScopeId && assignment.scopeId !== input.selectedScopeId)
    )
      continue;
    const resolved = resolveFileReference({
      reference: assignment.reference,
      purpose: "read",
      actor: "model",
      scopes: input.scopes,
      grants: [],
    });
    if (
      !resolved.ok ||
      resolved.path.scopeId !== assignment.scopeId ||
      !/\.(?:md|txt)$/iu.test(resolved.path.absolute)
    )
      throw new Error(
        `Guidance ${assignment.id} is not available within its approved scope.`,
      );
    const text = readBoundedGuidance({
      path: resolved.path.absolute,
      expectedPath: resolved.path.absolute,
      permitted: true,
    });
    const hash = createHash("sha256").update(text).digest("hex");
    if (hash !== assignment.sha256)
      throw new Error(
        `Guidance ${assignment.id} changed and must be approved again.`,
      );
    sources.push({
      id: `guidance.${assignment.id}`,
      text,
      audience: assignment.audiences,
      kind: "instructions",
    });
    versions[`guidance.${assignment.id}`] = hash;
  }
  return { sources, versions };
}
