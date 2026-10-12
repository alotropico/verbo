"use client";

import {
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type PropsWithChildren,
} from "react";
import { createPortal } from "react-dom";
import {
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  ImageOffIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import type {
  ImageMessagePart,
  ImageMessagePartComponent,
} from "@assistant-ui/react";
import { ActionIcon } from "@mantine/core";
import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import { hostOf, safeHref } from "./href";
import styles from "./image.module.css";

export type ImageVariant = "outline" | "ghost" | "muted";
export type ImageSize = "sm" | "default" | "lg" | "full";

function imageVariants({
  className,
}: {
  variant?: ImageVariant;
  size?: ImageSize;
  className?: string;
} = {}) {
  return cx("aui-image-root", styles.root, className);
}

const ratioClass = {
  "1:1": styles.aspectSquare,
  "4:3": styles.aspect4x3,
  "16:9": styles.aspectVideo,
  "9:16": styles.aspect9x16,
} as const;

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

const dataUriToBlob = (dataUri: string): Blob | null => {
  const commaIndex = dataUri.indexOf(",");
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri;
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : "";
  const mime =
    meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ??
    "application/octet-stream";
  if (!/;base64/i.test(meta)) {
    const parts: BlobPart[] = [];
    let last = 0;
    for (const match of data.matchAll(/(?:%[\da-f]{2})+/gi)) {
      if (match.index > last) parts.push(data.slice(last, match.index));
      const run = match[0];
      const escaped = new Uint8Array(run.length / 3);
      for (let index = 0; index < escaped.length; index++) {
        escaped[index] = Number.parseInt(
          run.slice(index * 3 + 1, index * 3 + 3),
          16,
        );
      }
      parts.push(escaped);
      last = match.index + run.length;
    }
    parts.push(data.slice(last));
    return new Blob(parts, { type: mime });
  }
  let bytes: string;
  try {
    const base64 = data.replace(/%([\da-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    bytes = atob(base64);
  } catch {
    return null;
  }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();

const defaultFilenameFromImage = (image: string): string => {
  const mime = mimeFromImage(image);
  if (mime) return `image.${extensionForMimeType(mime)}`;
  try {
    const path = new URL(image, document.baseURI).pathname;
    const encodedBasename = path.split("/").pop() ?? "";
    let basename = encodedBasename;
    try {
      basename = decodeURIComponent(encodedBasename);
    } catch {
      // Malformed escapes keep the encoded name.
    }
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(basename)) return basename;
  } catch {
    // Unparseable URLs fall back to the default name.
  }
  return "image.png";
};

const safeImageDownloadHref = (image: string): string | null => {
  try {
    const url = new URL(image, document.baseURI);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "blob:"
      ? image
      : null;
  } catch {
    return null;
  }
};

const downloadImagePart = (
  part: Pick<ImageMessagePart, "image" | "filename">,
): void => {
  if (typeof document === "undefined") return;
  const filename = part.filename ?? defaultFilenameFromImage(part.image);
  const isDataUri = /^data:/i.test(part.image);
  const blob = isDataUri ? dataUriToBlob(part.image) : null;
  if (isDataUri && !blob) return;
  const objectUrl = blob ? URL.createObjectURL(blob) : null;
  const href = objectUrl ?? safeImageDownloadHref(part.image);
  if (!href) return;
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000);
};

const copyImagePart = async (
  part: Pick<ImageMessagePart, "image">,
): Promise<void> => {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("Clipboard API is not available in this environment.");
  }
  const blob = /^data:/i.test(part.image)
    ? dataUriToBlob(part.image)
    : await fetch(part.image).then((r) => r.blob());
  if (!blob) return;
  const mime = mimeFromImage(part.image) ?? blob.type ?? "image/png";
  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
};

export type ImageRootProps = React.ComponentProps<"div"> & {
  variant?: ImageVariant;
  size?: ImageSize;
};

function ImageRoot({
  className,
  variant,
  size,
  children,
  ...props
}: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      data-variant={variant}
      data-size={size}
      className={imageVariants({ variant, size, className })}
      {...props}
    >
      {children}
    </div>
  );
}

type ImagePreviewProps = Omit<React.ComponentProps<"img">, "children"> & {
  containerClassName?: string | undefined;
  ratio?: "auto" | "1:1" | "4:3" | "16:9" | "9:16" | undefined;
  fit?: "cover" | "contain" | undefined;
};

function ImagePreview({
  className,
  containerClassName,
  ratio = "auto",
  fit = "contain",
  onLoad,
  onError,
  alt = "Image content",
  src,
  ...props
}: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);

  const loaded = loadedSrc === src;
  const error = errorSrc === src;
  const fixedRatio = ratio !== "auto";
  const ratioClassName =
    ratio !== "auto" ? ratioClass[ratio as keyof typeof ratioClass] : undefined;

  useEffect(() => {
    const image = imgRef.current;
    if (typeof src !== "string" || !image?.complete) return;
    if (image.naturalWidth > 0) setLoadedSrc(src);
    else setErrorSrc(src);
  }, [src]);

  return (
    <div
      data-slot="image-preview"
      className={cx(
        styles.previewContainer,
        fixedRatio ? ratioClassName : styles.previewMinH,
        containerClassName,
      )}
    >
      {!loaded && !error && (
        <div
          data-slot="image-preview-loading"
          className={styles.loadingOverlay}
        >
          <ImageIcon className={styles.loadingIcon} />
        </div>
      )}
      {error ? (
        <div
          data-slot="image-preview-error"
          className={cx(
            styles.errorPanel,
            fixedRatio && styles.errorPanelFixed,
          )}
        >
          <ImageOffIcon className={styles.errorIcon} />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={cx(
            fixedRatio
              ? cx(
                  styles.imgFixed,
                  fit === "cover" ? styles.imgCover : styles.imgContain,
                )
              : styles.imgAuto,
            !loaded && styles.imgHidden,
            className,
          )}
          onLoad={(e) => {
            if (typeof src === "string") setLoadedSrc(src);
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

export type ImageSourceProps = {
  label?: string | undefined;
  url?: string | undefined;
  iconUrl?: string | undefined;
} & React.ComponentProps<"div">;

function ImageSource({
  className,
  label,
  url,
  iconUrl,
  ...props
}: ImageSourceProps) {
  const href = safeHref(url);
  const host = hostOf(url);
  const displayLabel = label || host;
  const [failedIconUrl, setFailedIconUrl] = useState<string | undefined>();

  if (!displayLabel) return null;

  const showIcon = iconUrl !== undefined && failedIconUrl !== iconUrl;

  return (
    <div
      data-slot="image-source"
      className={cx("aui-image-source", styles.source, className)}
      {...props}
    >
      {showIcon ? (
        <img
          data-slot="image-source-icon"
          src={iconUrl}
          alt=""
          className={styles.sourceIcon}
          onError={() => setFailedIconUrl(iconUrl)}
        />
      ) : (
        <span
          data-slot="image-source-icon-fallback"
          aria-hidden="true"
          className={styles.sourceIconFallback}
        >
          {displayLabel.charAt(0).toUpperCase()}
        </span>
      )}
      {href ? (
        <a
          data-slot="image-source-label"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.sourceLink}
        >
          {displayLabel}
          <span className={a11y.srOnly}> (opens in a new tab)</span>
        </a>
      ) : (
        <span data-slot="image-source-label" className={styles.sourceLink}>
          {displayLabel}
        </span>
      )}
    </div>
  );
}

function ImageFilename({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  if (!children) return null;

  return (
    <span
      data-slot="image-filename"
      className={cx("aui-image-filename", styles.filename, className)}
      {...props}
    >
      {children}
    </span>
  );
}

type ImageZoomProps = PropsWithChildren<{
  src: string;
  alt?: string;
}>;

function ImageZoom({ src, alt = "Image preview", children }: ImageZoomProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables?.[0];
      const last = focusables?.[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.click();
          } else if (e.key === " ") {
            e.preventDefault();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " ") e.currentTarget.click();
        }}
        role="button"
        tabIndex={0}
        className={cx("aui-image-zoom-trigger", styles.zoomTrigger)}
        aria-label="Click to zoom image"
      >
        {children}
      </div>
      {isOpen &&
        createPortal(
          <div
            ref={overlayRef}
            data-slot="image-zoom-overlay"
            role="dialog"
            aria-modal="true"
            className={cx("aui-image-zoom-overlay", styles.zoomOverlay)}
            onClick={handleClose}
            aria-label="Zoomed image"
          >
            <img
              data-slot="image-zoom-content"
              src={src}
              alt={alt}
              className={cx("aui-image-zoom-content", styles.zoomContent)}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
            />
            <ActionIcon
              ref={closeRef}
              type="button"
              variant="subtle"
              aria-label="Close zoomed image"
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              className={styles.zoomClose}
            >
              <XIcon className={styles.closeIcon} />
            </ActionIcon>
          </div>,
          document.body,
        )}
    </>
  );
}

function ImageGenerating({ className }: { className?: string }) {
  return (
    <div
      data-slot="image-generating"
      className={cx(styles.generating, className)}
    >
      <Loader2Icon className={styles.spinner} />
      <span className={a11y.srOnly}>Generating image…</span>
    </div>
  );
}

function ImageContentFilterError({
  className,
  reason,
}: {
  className?: string;
  reason?: string;
}) {
  return (
    <div
      data-slot="image-content-filter-error"
      className={cx(styles.filterError, className)}
    >
      <ShieldAlertIcon className={styles.errorIcon} />
      <p className={styles.filterTitle}>Image could not be generated</p>
      {reason && <p className={styles.filterReason}>{reason}</p>}
    </div>
  );
}

export type ImageActionsProps = {
  part: ImageMessagePart;
  /**
   * Wire to your own generation call to show a regenerate button. The button
   * renders only when this is set and the part carries a `prompt`.
   */
  onRegenerate?: () => void | Promise<void>;
  className?: string;
};

function RegenerateButton({
  onRegenerate,
}: {
  onRegenerate: () => void | Promise<void>;
}) {
  const [isRegenerating, setIsRegenerating] = useState(false);
  return (
    <ActionIcon
      type="button"
      variant="subtle"
      onClick={async () => {
        setIsRegenerating(true);
        try {
          await onRegenerate();
        } catch {
          // The caller reports regeneration failures.
        } finally {
          setIsRegenerating(false);
        }
      }}
      disabled={isRegenerating}
      data-slot="image-regenerate"
      aria-label="Regenerate image"
      className={styles.actionButton}
    >
      <RefreshCwIcon
        className={cx(
          styles.actionIcon,
          isRegenerating && styles.actionIconSpin,
        )}
      />
    </ActionIcon>
  );
}

function ImageActions({ part, onRegenerate, className }: ImageActionsProps) {
  return (
    <div data-slot="image-actions" className={cx(styles.actions, className)}>
      <ActionIcon
        type="button"
        variant="subtle"
        onClick={() => downloadImagePart(part)}
        data-slot="image-download"
        aria-label="Download image"
        className={styles.actionButton}
      >
        <DownloadIcon className={styles.actionIcon} />
      </ActionIcon>
      <ActionIcon
        type="button"
        variant="subtle"
        onClick={() => {
          copyImagePart(part).catch(() => {});
        }}
        data-slot="image-copy"
        aria-label="Copy image"
        className={styles.actionButton}
      >
        <CopyIcon className={styles.actionIcon} />
      </ActionIcon>
      {onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
    </div>
  );
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props;

  if (status?.type === "running") {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }

  if (status?.type === "incomplete" && status.reason === "content-filter") {
    return (
      <ImageRoot>
        <ImageContentFilterError reason="The provider blocked this image." />
      </ImageRoot>
    );
  }

  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || "Image content"}>
        <ImagePreview src={image} alt={filename || "Image content"} />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  );
};

const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  Root: typeof ImageRoot;
  Preview: typeof ImagePreview;
  Source: typeof ImageSource;
  Filename: typeof ImageFilename;
  Zoom: typeof ImageZoom;
  Actions: typeof ImageActions;
  Generating: typeof ImageGenerating;
  ContentFilterError: typeof ImageContentFilterError;
};

Image.displayName = "Image";
Image.Root = ImageRoot;
Image.Preview = ImagePreview;
Image.Source = ImageSource;
Image.Filename = ImageFilename;
Image.Zoom = ImageZoom;
Image.Actions = ImageActions;
Image.Generating = ImageGenerating;
Image.ContentFilterError = ImageContentFilterError;

export {
  Image,
  ImageRoot,
  ImagePreview,
  ImageSource,
  ImageFilename,
  ImageZoom,
  ImageActions,
  ImageGenerating,
  ImageContentFilterError,
  imageVariants,
};
