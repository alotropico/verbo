import type { ComponentProps, ReactElement } from "react";

export function VerboMark(props: ComponentProps<"svg">): ReactElement {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5 8L13 25L21 8M18 18L23 8H28L20 25"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
