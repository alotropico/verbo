import {
  Component,
  lazy,
  Suspense,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import styles from "./ChatBlob.module.css";

const BlobCanvas = lazy(() => import("./BlobCanvas"));

function BlobFallback(): ReactNode {
  return <div className={styles.fallback} />;
}

class BlobBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <BlobFallback /> : this.props.children;
  }
}

/** A portable, decorative 70 × 70 scene. Requires no application providers. */
export function ChatBlob(): ReactNode {
  return (
    <span aria-hidden="true" className={styles.root}>
      <BlobBoundary>
        <Suspense fallback={<BlobFallback />}>
          <BlobCanvas />
        </Suspense>
      </BlobBoundary>
    </span>
  );
}
