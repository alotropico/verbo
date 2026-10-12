import type { ComponentProps, ReactElement } from "react";
import mark from "@/assets/verbo-mark.json";

export function VerboMark(props: ComponentProps<"svg">): ReactElement {
  return (
    <svg viewBox={mark.viewBox} fill="none" aria-hidden="true" {...props}>
      <path
        d={mark.path}
        stroke="currentColor"
        strokeWidth={mark.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
