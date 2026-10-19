import { useAuiState } from "@assistant-ui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  approvalRequestsFromParts,
  notifyApprovalRequest,
  type ApprovalNotice,
} from "@/runtime/approval-notice";
import { cx } from "@/lib/cx";
import { OperationReviewCard } from "./operation-review";
import styles from "./approval-region.module.css";

type ApprovalPortalApi = {
  element: HTMLDivElement | null;
  retain: () => void;
  release: () => void;
};

const ApprovalPortalContext = createContext<ApprovalPortalApi | null>(null);

export function ApprovalRequests({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const parts = useAuiState((state) => state.message.content);
  const requests = useMemo(() => approvalRequestsFromParts(parts), [parts]);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [portals, setPortals] = useState(0);
  const retain = useCallback(() => setPortals((count) => count + 1), []);
  const release = useCallback(
    () => setPortals((count) => Math.max(0, count - 1)),
    [],
  );
  const api = useMemo<ApprovalPortalApi>(
    () => ({ element, retain, release }),
    [element, release, retain],
  );
  useEffect(() => {
    for (const request of requests)
      notifyApprovalRequest(request.id, request.body);
  }, [requests]);
  const cards = requests.filter(
    (request): request is ApprovalNotice & { result: unknown } =>
      request.result !== undefined,
  );
  const shown = cards.length > 0 || portals > 0;

  return (
    <ApprovalPortalContext.Provider value={api}>
      <div
        data-slot="approval-requests"
        className={cx(styles.requests, !shown && styles.requestsIdle)}
        role={shown ? "region" : undefined}
        aria-label={shown ? "Approval requests" : undefined}
      >
        {cards.map((request) => (
          <OperationReviewCard key={request.id} result={request.result} />
        ))}
        <div
          ref={setElement}
          data-slot="approval-request-host"
          className={styles.host}
        />
      </div>
      {children}
    </ApprovalPortalContext.Provider>
  );
}

export function ExternalApproval({
  active,
  noticeId,
  noticeBody,
  children,
}: {
  active: boolean;
  noticeId?: string;
  noticeBody?: string;
  children: ReactNode;
}): ReactElement | null {
  const api = useContext(ApprovalPortalContext);
  const bodyRef = useRef(noticeBody);
  bodyRef.current = noticeBody;
  const host = api?.element ?? null;
  useLayoutEffect(() => {
    if (!active || !host || !api) return undefined;
    if (noticeId) notifyApprovalRequest(noticeId, bodyRef.current ?? "");
    api.retain();
    return () => api.release();
  }, [active, api, host, noticeId]);
  if (!active) return null;
  if (!host) return api ? null : <>{children}</>;
  return createPortal(children, host);
}
