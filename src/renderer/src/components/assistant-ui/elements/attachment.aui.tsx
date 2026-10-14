"use client";

import { useState, type FC, type KeyboardEvent } from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import { Avatar, Modal, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { TooltipIconButton } from "./tooltip-icon-button";
import { StatusMessage } from "@/components/StatusMessage";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import styles from "./attachment.aui.module.css";

type AttachmentPreviewProps = {
  src: string;
  name: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src, name }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={`Preview of ${name}`}
      className={cx(
        styles.previewImage,
        isLoaded
          ? cx("aui-attachment-preview-image-loaded", styles.previewImageLoaded)
          : cx(
              "aui-attachment-preview-image-loading",
              styles.previewImageLoading,
            ),
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

type AttachmentPreviewDialogProps = {
  src: string | undefined;
  name: string;
  opened: boolean;
  onClose: () => void;
};

const AttachmentPreviewDialog: FC<AttachmentPreviewDialogProps> = ({
  src,
  name,
  opened,
  onClose,
}) => {
  if (!src) return null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="48rem"
      padding="sm"
      radius="md"
      title={<span className={a11y.srOnly}>Preview {name}</span>}
      classNames={{ body: styles.previewWrap }}
    >
      <AttachmentPreview src={src} name={name} />
    </Modal>
  );
};

const AttachmentThumb: FC<{ src: string | undefined }> = ({ src }) => {
  return (
    <Avatar
      src={src}
      alt=""
      radius={0}
      className={cx("aui-attachment-tile-avatar", styles.avatar)}
      classNames={{ image: cx("aui-attachment-tile-image", styles.tileImage) }}
    >
      <FileText
        className={cx("aui-attachment-tile-fallback-icon", styles.fallbackIcon)}
      />
    </Avatar>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const src = useAttachmentSrc();

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const name = useAuiState((s) => s.attachment.name);
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? "error"
      : s.attachment.status.type === "running" ||
          (s.optional.message?.submission !== undefined &&
            s.attachment.status.type !== "complete")
        ? "uploading"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  const [previewOpened, { open: openPreview, close: closePreview }] =
    useDisclosure(false);
  const openPreviewOnKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!src || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openPreview();
  };

  return (
    <AttachmentPrimitive.Root
      className={cx(
        "aui-attachment-root",
        styles.root,
        isComposer && styles.rootComposerEnter,
        isImage && !isComposer && styles.rootMessageOnly,
        isImage && !isComposer && "aui-attachment-root-message",
      )}
    >
      <Tooltip
        label={
          <>
            <AttachmentPrimitive.Name />
            {errorMessage ? (
              <StatusMessage display="plain" size="xs" tone="error">
                {errorMessage}
              </StatusMessage>
            ) : null}
          </>
        }
        position="top"
        multiline
        maw={240}
      >
        <div
          className={cx(
            "aui-attachment-tile",
            styles.tile,
            src ? styles.tileHasSrc : styles.tileDefaultCursor,
            src && styles.previewTrigger,
            isError && styles.tileError,
          )}
          role={src ? "button" : "group"}
          tabIndex={0}
          aria-label={`${src ? `Preview ${name}` : `${typeLabel} attachment ${name}`}${
            isError ? ", upload failed" : isUploading ? ", uploading" : ""
          }`}
          onClick={src ? openPreview : undefined}
          onKeyDown={openPreviewOnKey}
        >
          <AttachmentThumb src={src} />
          {isUploading && (
            <div
              aria-hidden="true"
              className={cx(
                "aui-attachment-tile-uploading",
                styles.overlayUploading,
              )}
            >
              <Loader2Icon className={styles.loaderIcon} />
            </div>
          )}
          {isError && (
            <div
              aria-hidden="true"
              className={cx("aui-attachment-tile-error", styles.overlayError)}
            >
              <AlertCircleIcon className={styles.errorIcon} />
            </div>
          )}
        </div>
      </Tooltip>
      <AttachmentPreviewDialog
        src={src}
        name={name}
        opened={previewOpened}
        onClose={closePreview}
      />
      {isComposer && <AttachmentRemove name={name} />}
    </AttachmentPrimitive.Root>
  );
};

const AttachmentRemove: FC<{ name: string }> = ({ name }) => {
  return (
    <AttachmentPrimitive.Remove
      render={
        <TooltipIconButton
          tooltip={`Remove ${name}`}
          className={cx("aui-attachment-tile-remove", styles.removeButton)}
          side="top"
        />
      }
    >
      <XIcon className={cx("aui-attachment-remove-icon", styles.removeIcon)} />
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div
      className={cx("aui-user-message-attachments-end", styles.userAttachments)}
    >
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className={cx("aui-composer-attachments", styles.composerAttachments)}>
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment
      render={
        <TooltipIconButton
          tooltip="Add Attachment"
          side="bottom"
          className={cx("aui-composer-add-attachment", styles.addAttachment)}
          aria-label="Add Attachment"
        />
      }
    >
      <PlusIcon className={cx("aui-attachment-add-icon", styles.addIcon)} />
    </ComposerPrimitive.AddAttachment>
  );
};
