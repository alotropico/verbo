"use client";

import { useState, type FC, type KeyboardEvent } from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  AlertCircleIcon,
  ImageIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
} from "@assistant-ui/react";
import {
  Avatar,
  Button,
  Group,
  Modal,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { TooltipIconButton } from "./tooltip-icon-button";
import { PendingIndicator } from "./pending-indicator";
import { File, getFileHref } from "./file";
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
      radius="sm"
      size={24}
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
          tabIndex={src ? 0 : undefined}
          aria-label={`${src ? `Preview ${name}` : `${typeLabel} attachment ${name}`}${
            isError ? ", upload failed" : isUploading ? ", uploading" : ""
          }`}
          onClick={src ? openPreview : undefined}
          onKeyDown={openPreviewOnKey}
        >
          <AttachmentThumb src={src} />
          <span className={styles.fileName}>
            <AttachmentPrimitive.Name />
          </span>
          <span className={styles.fileType}>{typeLabel}</span>
          {isUploading ? <PendingIndicator size="compact" /> : null}
          {isError ? (
            <AlertCircleIcon className={styles.errorIcon} aria-hidden />
          ) : null}
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

export const MessageFileAttachment: FileMessagePartComponent = (part) => {
  const [opened, { open, close }] = useDisclosure(false);
  const href = getFileHref(part.data, part.mimeType, part.sourceType);
  const name = part.filename || "File";
  const image = part.mimeType.startsWith("image/") ? href : undefined;
  const media =
    part.mimeType.startsWith("audio/") || part.mimeType.startsWith("video/");
  return (
    <div className={styles.root}>
      <File.Icon mimeType={part.mimeType} />
      {href && (image || media) ? (
        <UnstyledButton
          className={styles.fileName}
          onClick={open}
          aria-label={`Preview ${name}`}
        >
          {name}
        </UnstyledButton>
      ) : (
        <span className={styles.fileName}>{name}</span>
      )}
      <File.Download
        data={part.data}
        mimeType={part.mimeType}
        sourceType={part.sourceType}
        filename={name}
      />
      {image ? (
        <AttachmentPreviewDialog
          src={image}
          name={name}
          opened={opened}
          onClose={close}
        />
      ) : null}
      {media && href ? (
        <Modal opened={opened} onClose={close} title={name} size="lg" centered>
          <File.Player
            data={part.data}
            mimeType={part.mimeType}
            sourceType={part.sourceType}
            filename={name}
          />
        </Modal>
      ) : null}
    </div>
  );
};

export const MessageImageAttachment: ImageMessagePartComponent = ({
  image,
  filename,
}) => {
  const [opened, { open, close }] = useDisclosure(false);
  const name = filename || "Image";
  return (
    <div className={styles.root}>
      <ImageIcon size={16} aria-hidden />
      <UnstyledButton
        className={styles.fileName}
        onClick={open}
        aria-label={`Preview ${name}`}
      >
        {name}
      </UnstyledButton>
      <File.Download
        data={image}
        mimeType="image/png"
        sourceType="url"
        filename={name}
      />
      <AttachmentPreviewDialog
        src={image}
        name={name}
        opened={opened}
        onClose={close}
      />
    </div>
  );
};

function AttachmentCollection({ source }: { source: "message" | "composer" }) {
  const attachments = useAuiState((state) =>
    source === "message"
      ? state.message.attachments
      : state.composer.attachments,
  );
  const parts = useAuiState((state) =>
    source === "message" ? state.message.parts : undefined,
  );
  const [opened, { open, close }] = useDisclosure(false);
  const Iterator =
    source === "message"
      ? MessagePrimitive.Attachments
      : ComposerPrimitive.Attachments;
  const represented = new Set(
    (attachments ?? []).flatMap((attachment) =>
      (attachment.content ?? []).flatMap((part) =>
        part.type === "file"
          ? [part.data]
          : part.type === "image"
            ? [part.image]
            : [],
      ),
    ),
  );
  const mediaParts = (parts ?? []).flatMap((part, index) =>
    (part.type === "file" || part.type === "image") &&
    !represented.has(part.type === "file" ? part.data : part.image)
      ? [{ index, key: part.type === "file" ? part.data : part.image }]
      : [],
  );
  const count = (attachments?.length ?? 0) + mediaParts.length;
  if (count === 0) return null;
  const visibleIds = new Set(
    (attachments ?? []).slice(0, 4).map((attachment) => attachment.id),
  );
  const renderParts = (limit: number) =>
    mediaParts.slice(0, limit).map(({ index, key }) => (
      <MessagePrimitive.PartByIndex
        key={key}
        index={index}
        components={{
          File: MessageFileAttachment,
          Image: MessageImageAttachment,
        }}
      />
    ));
  return (
    <div
      className={cx(
        styles.collection,
        source === "message"
          ? styles.userAttachments
          : styles.composerAttachments,
      )}
      role="group"
      aria-label="Attachments"
    >
      <Group className={styles.heading} justify="space-between" gap="xs">
        <Text size="xs" fw={500} c="dimmed">
          Attachments · {count}
        </Text>
        {count > 4 ? (
          <Button
            size="compact-xs"
            variant="subtle"
            aria-haspopup="dialog"
            onClick={open}
          >
            See all ({count})
          </Button>
        ) : null}
      </Group>
      <Iterator>
        {({ attachment }) =>
          visibleIds.has(attachment.id) ? <AttachmentUI /> : null
        }
      </Iterator>
      {renderParts(Math.max(0, 4 - (attachments?.length ?? 0)))}
      <Modal
        opened={opened}
        onClose={close}
        title={`Attachments (${count})`}
        size="lg"
        centered
      >
        <ScrollArea.Autosize mah="60dvh" type="auto" scrollbars="y">
          <div className={styles.collection}>
            <Iterator>{() => <AttachmentUI />}</Iterator>
            {renderParts(mediaParts.length)}
          </div>
        </ScrollArea.Autosize>
      </Modal>
    </div>
  );
}

export const UserMessageAttachments: FC = () => (
  <AttachmentCollection source="message" />
);

export const ComposerAttachments: FC = () => (
  <AttachmentCollection source="composer" />
);

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
