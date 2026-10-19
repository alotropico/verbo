import {
  backendNoticeSchema,
  type BackendNotice,
} from "../../shared/backend-notice";
import type { ChatTurnStop } from "../../shared/chat-ipc";
import {
  reportParagraphs,
  type ExecutionTrace,
} from "../../shared/execution-trace";

/** One terminal notice per evaluated incident. Progress info is not a callout. */
export function terminalNotices(
  trace: ExecutionTrace | undefined,
): BackendNotice[] {
  if (!trace || trace.readiness !== "ready") return [];
  return trace.incidents
    .filter((incident) => incident.lifecycle === "terminal")
    .map((incident) =>
      backendNoticeSchema.parse({
        id: `incident:${incident.id}`.slice(0, 160),
        origin: "backend",
        severity: incident.severity,
        code: incident.code,
        message: incident.message,
      }),
    );
}

/** Turn-level notice for stops that are not ordinary completion or an open approval. */
export function turnStopNotice(input: {
  stop: ChatTurnStop;
  summary?: string;
  turnId: string;
}): BackendNotice | undefined {
  if (!input.summary || input.stop === "completed") return;
  return backendNoticeSchema.parse({
    id: `turn:${input.turnId}:${input.stop}`.slice(0, 160),
    origin: "backend",
    severity: input.stop === "failed" ? "error" : "warning",
    code: `turn_${input.stop}`,
    message: input.summary.slice(0, 500),
  });
}

export function fallbackProse(trace: ExecutionTrace | undefined): string {
  const paragraphs = trace ? reportParagraphs(trace) : [];
  return (
    paragraphs.join("\n\n") || "The turn finished without a written response."
  );
}
