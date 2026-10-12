"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  type MarkdownTextPrimitiveProps,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { type FC, memo, useMemo, useRef } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "./tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cx } from "@/lib/cx";
import styles from "./markdown-text.module.css";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  componentsByLanguage?: MarkdownTextPrimitiveProps["componentsByLanguage"];
  preprocess?: (text: string) => string;
  defer?: boolean;
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({
  components,
  componentsByLanguage,
  preprocess,
  defer = true,
}) => {
  const stableComponents = useShallowStable(components);
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={markdownComponents}
      componentsByLanguage={stableComponentsByLanguage}
      preprocess={preprocess}
      defer={defer}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className={cx("aui-code-header-root", styles.codeHeader)}>
      <span
        className={cx("aui-code-header-language", styles.codeHeaderLanguage)}
      >
        {language}
      </span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon className={styles.copyIconEnter} />}
        {isCopied && <CheckIcon className={styles.copyIconCheck} />}
      </TooltipIconButton>
    </div>
  );
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1 className={cx("aui-md-h1", styles.h1, className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cx("aui-md-h2", styles.h2, className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cx("aui-md-h3", styles.h3, className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cx("aui-md-h4", styles.h4, className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={cx("aui-md-h5", styles.h5, className)} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6 className={cx("aui-md-h6", styles.h6, className)} {...props} />
  ),
  p: ({ className, ...props }) => (
    <p className={cx("aui-md-p", styles.p, className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a className={cx("aui-md-a", styles.a, className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cx("aui-md-blockquote", styles.blockquote, className)}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cx("aui-md-ul", styles.ul, className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cx("aui-md-ol", styles.ol, className)} {...props} />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cx("aui-md-hr", styles.hr, className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className={cx("aui-md-table-wrapper", styles.tableWrapper)}>
      <table
        className={cx("aui-md-table", styles.table, className)}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th className={cx("aui-md-th", styles.th, className)} {...props} />
  ),
  td: ({ className, ...props }) => (
    <td className={cx("aui-md-td", styles.td, className)} {...props} />
  ),
  tr: ({ className, ...props }) => (
    <tr className={cx("aui-md-tr", styles.tr, className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cx("aui-md-li", styles.li, className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cx("aui-md-strong", styles.strong, className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup className={cx("aui-md-sup", styles.sup, className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={cx("aui-md-pre", styles.pre, className)} {...props} />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cx(
          !isCodeBlock && cx("aui-md-inline-code", styles.inlineCode),
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
