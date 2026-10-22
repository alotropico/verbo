import { useEffect, useState, type ReactElement } from "react";
import { Button } from "@mantine/core";
import { useAuiState } from "@assistant-ui/react";
import type { ActionResult } from "@shared/action-contract";
import {
  operationInventoryLine,
  type OperationReview,
  type OperationReviewFailure,
} from "@shared/file-mutation";
import { StatusMessage } from "@/components/StatusMessage";
import { operationReviewThreadId } from "@/runtime/operation-review-identity";
import styles from "./operation-review.module.css";

type ReviewResponse = OperationReview | OperationReviewFailure;

function readResult(result: unknown): ActionResult | null {
  const value =
    typeof result === "string"
      ? parseJson(result)
      : result && typeof result === "object"
        ? result
        : null;
  if (!value || typeof value !== "object" || !("operationId" in value))
    return null;
  return value as ActionResult;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function OperationReviewCard({
  result,
}: {
  result: unknown;
}): ReactElement | null {
  const ownerThreadId = useAuiState((state) => state.threadListItem.remoteId);
  const action = readResult(result);
  const operationId = action?.operationId;
  const threadId = action ? operationReviewThreadId(action, ownerThreadId) : null;
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [receipt, setReceipt] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!operationId || !threadId || !window.verbo?.operations) return;
    let cancelled = false;
    void window.verbo.operations
      .review({ operationId, threadId })
      .then((next) => {
        if (!cancelled) setReview(next);
      })
      .catch(() => {
        if (!cancelled) setError("The stored plan could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [operationId, threadId]);

  if (!action?.operationId) return null;
  const shown = review && review.ok ? review : null;
  const waiting = action.status === "requires_confirmation" && !receipt;

  return (
    <section className={styles.card} aria-label="Operation review">
      <p className={styles.summary}>
        {receipt?.summary ?? shown?.summary ?? action.summary}
      </p>
      {shown ? (
        <p className={styles.summary}>{operationInventoryLine(shown)}</p>
      ) : null}
      {shown?.risks.map((risk) => (
        <StatusMessage display="plain" key={risk} size="xs" tone="warning">
          {risk}
        </StatusMessage>
      ))}
      {shown && shown.items.length > 0 ? (
        <ul className={styles.list}>
          {shown.items.map((item) => (
            <li className={styles.item} key={item.index}>
              <span>
                {item.kind} {item.from ?? item.to}
                {item.to && item.from ? ` -> ${item.to}` : ""}
              </span>
              {item.diff ? (
                <pre className={styles.diff}>{item.diff}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <StatusMessage display="plain" size="xs" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {waiting && window.verbo?.operations ? (
        <div className={styles.actions}>
          <Button
            disabled={busy || !threadId}
            variant="default"
            onClick={() => {
              if (!operationId || !threadId) return;
              setBusy(true);
              setError(null);
              void window.verbo.operations
                .confirm({ operationId, threadId, decision: "deny" })
                .then((next) => {
                  if ("status" in next) setReceipt(next);
                  else setError(next.summary);
                })
                .catch(() => setError("Confirmation did not finish."))
                .finally(() => setBusy(false));
            }}
          >
            Deny
          </Button>
          <Button
            disabled={busy || !threadId}
            onClick={() => {
              if (!operationId || !threadId) return;
              setBusy(true);
              setError(null);
              void window.verbo.operations
                .confirm({ operationId, threadId, decision: "approve" })
                .then((next) => {
                  if ("status" in next) setReceipt(next);
                  else setError(next.summary);
                })
                .catch(() => setError("Confirmation did not finish."))
                .finally(() => setBusy(false));
            }}
          >
            Approve
          </Button>
        </div>
      ) : null}
      {waiting && !window.verbo?.operations ? (
        <StatusMessage display="plain" size="sm" tone="info">
          Confirmation opens in the app window.
        </StatusMessage>
      ) : null}
    </section>
  );
}
