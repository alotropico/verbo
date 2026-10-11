import { useEffect, useState, type ReactElement } from "react";
import { Button } from "@mantine/core";
import type { ActionResult } from "@shared/action-contract";
import type {
  OperationReview,
  OperationReviewFailure,
} from "@shared/file-mutation";
import { cx } from "@/lib/cx";
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

function threadIdFrom(result: ActionResult): string | null {
  const detail = result.detail ? parseJson(result.detail) : null;
  if (!detail || typeof detail !== "object" || !("threadId" in detail))
    return null;
  const threadId = detail.threadId;
  return typeof threadId === "string" ? threadId : null;
}

export function OperationReviewCard({
  result,
}: {
  result: unknown;
}): ReactElement | null {
  const action = readResult(result);
  const operationId = action?.operationId;
  const threadId = action ? threadIdFrom(action) : null;
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
    <section className={styles.card} aria-label="File operation">
      <p className={styles.summary}>
        {receipt?.summary ?? shown?.summary ?? action.summary}
      </p>
      {shown?.risks.map((risk) => (
        <p className={cx(styles.risk)} key={risk}>
          {risk}
        </p>
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
      {error ? <p className={styles.risk}>{error}</p> : null}
      {waiting && window.verbo?.operations ? (
        <Button
          disabled={busy}
          onClick={() => {
            if (!operationId || !threadId) return;
            setBusy(true);
            setError(null);
            void window.verbo.operations
              .confirm({ operationId, threadId })
              .then((next) => {
                if ("status" in next) setReceipt(next);
                else setError(next.summary);
              })
              .catch(() => setError("Confirmation did not finish."))
              .finally(() => setBusy(false));
          }}
        >
          Confirm in dialog
        </Button>
      ) : null}
      {waiting && !window.verbo?.operations ? (
        <p className={styles.summary}>Confirmation opens in the app window.</p>
      ) : null}
    </section>
  );
}
