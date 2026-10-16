import type { FileScopeRecord } from "../../shared/files";
import type { PendingQuestion } from "../../shared/workflows";

export type WorkflowTargetSnapshot = Pick<
  FileScopeRecord,
  "id" | "path" | "kind" | "read" | "write"
>;

export function resolveWorkflowTarget(input: {
  scopes: FileScopeRecord[];
  target: string | null;
  answer?: unknown;
  prior?: unknown;
  vault: boolean;
}): {
  scope?: FileScopeRecord;
  snapshot?: WorkflowTargetSnapshot;
  question?: PendingQuestion;
} {
  const binding = input.vault ? "vault" : "target";
  const candidates = input.scopes.filter(
    (scope) => !input.vault || scope.kind === "obsidian",
  );
  const hint = typeof input.answer === "string" ? input.answer : input.target;
  if (!input.vault && !hint) return {};
  const scope = hint
    ? candidates.find(
        (entry) =>
          entry.id === hint ||
          entry.aliases.some(
            (alias) => alias.toLowerCase() === hint.toLowerCase(),
          ),
      )
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  const question = (text: string): { question: PendingQuestion } => ({
    question: {
      text,
      required: true,
      expected: candidates.length
        ? { type: "enum", values: candidates.map((entry) => entry.alias) }
        : { type: "text", maxLength: 200 },
      binding,
    },
  });
  if (!scope)
    return question(
      `Choose the ${input.vault ? "vault" : "folder"} explicitly. No available target matches the retained selection.`,
    );
  const snapshot: WorkflowTargetSnapshot = {
    id: scope.id,
    path: scope.path,
    kind: scope.kind,
    read: scope.read,
    write: scope.write,
  };
  const prior = input.prior as WorkflowTargetSnapshot | undefined;
  if (
    prior &&
    typeof input.answer !== "string" &&
    Object.keys(snapshot).some(
      (key) =>
        prior[key as keyof WorkflowTargetSnapshot] !==
        snapshot[key as keyof WorkflowTargetSnapshot],
    )
  )
    return question(
      "The selected target's identity or permissions changed. Choose it explicitly again before continuing.",
    );
  return { scope, snapshot };
}
